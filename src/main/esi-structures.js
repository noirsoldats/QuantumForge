/**
 * Player-structure name resolver.
 *
 * Resolves a structure ID to its name via ESI (`/universe/structures/{id}/`,
 * needs esi-universe.read_structures.v1).
 *
 * TWO CACHE LAYERS:
 *   1. In-memory (this file) — dedupes within a session, including in-flight
 *      requests so concurrent callers share one fetch.
 *   2. Persistent (structure-cache.js, table resolved_structures) — survives
 *      restart. 24h TTL on names, 7 days on access denials.
 *
 * Layer 2 exists because the session-only cache re-attempted every structure on
 * EVERY LAUNCH. Structures the character cannot dock at answer 403, and 4xx
 * responses count against ESI's application-wide error limit (100 non-2xx/3xx
 * per minute, then 420 on every route). That per-launch burst is what took the
 * background refresh cycle down.
 *
 * The 7-day denial backoff is only defensible because
 * `structures:manualRefresh` can clear both timers on demand.
 */

const { esiFetch } = require('./esi-fetch');
const { getCharacters, getCharacter } = require('./settings-manager');
const structureCachePersistent = require('./structure-cache');

// structureId -> { name, solarSystemId, typeId } | null (null = known-unresolvable this session)
const structureCache = new Map();
// structureId -> Promise, so concurrent callers dedupe onto one in-flight fetch.
const inFlight = new Map();

const STRUCTURE_SCOPE = 'esi-universe.read_structures.v1';

/**
 * Pick a character that can authenticate the structure lookup. Prefers the
 * provided characterId; falls back to any character with the structures scope.
 */
function pickAuthCharacter(characterId) {
  if (characterId) {
    const c = getCharacter(characterId);
    if (c && c.scopes && c.scopes.includes(STRUCTURE_SCOPE)) return c;
  }
  const all = getCharacters() || [];
  return all.find(c => c.scopes && c.scopes.includes(STRUCTURE_SCOPE)) || null;
}

/**
 * Resolve a single structure ID to { structureId, name, solarSystemId, typeId }
 * or null if it can't be resolved (no scope, no access, or fetch failure).
 * In-memory cached for the session.
 * @param {number} structureId
 * @param {number} [characterId] - preferred authenticating character
 */
async function resolveStructure(structureId, characterId = null) {
  if (!structureId) return null;

  if (structureCache.has(structureId)) {
    const cached = structureCache.get(structureId);
    return cached ? { structureId, ...cached } : null;
  }
  if (inFlight.has(structureId)) {
    const cached = await inFlight.get(structureId);
    return cached ? { structureId, ...cached } : null;
  }

  // Persistent layer: a fresh name or a fresh denial both answer without ESI.
  // This is what stops the per-launch 403 burst.
  const persisted = structureCachePersistent.get(structureId);
  if (persisted) {
    if (persisted.status === 'resolved') {
      const info = {
        name: persisted.name,
        solarSystemId: persisted.solarSystemId,
        typeId: persisted.typeId,
      };
      structureCache.set(structureId, info);
      return { structureId, ...info };
    }
    // 'denied' and still inside the backoff — do not call ESI.
    structureCache.set(structureId, null);
    return null;
  }

  const promise = (async () => {
    const character = pickAuthCharacter(characterId);
    if (!character) {
      // No character holds the scope. NOT persisted as a denial: this is a
      // local capability gap, not an ESI access fact, and it changes the moment
      // a character authenticates with the scope.
      structureCache.set(structureId, null);
      return null;
    }

    try {
      const url = `https://esi.evetech.net/latest/universe/structures/${structureId}/?datasource=tranquility`;
      const result = await esiFetch('structure', `structure_${structureId}`, url, {
        characterId: character.characterId,
        category: 'universe',
        endpointLabel: 'Structure Info',
        // Own in-memory cache governs cadence; don't let the per-endpoint gate
        // suppress a first-time lookup.
        skipGate: true,
        // Structure names rarely change, so a re-resolve after the 24h TTL is
        // usually a 304: 1 token instead of 2, no body, and no error-budget
        // cost. Safe here because a notModified answer means "keep the name you
        // already have", which is exactly what the persistent cache holds.
        useETag: true,
      });

      // Role-forbidden (403, no docking access) is a real ACCESS FACT from ESI,
      // so it persists with the 7-day backoff - re-asking is what burns the
      // error budget.
      if (result.roleForbidden) {
        structureCachePersistent.putDenied(structureId);
        structureCache.set(structureId, null);
        return null;
      }

      // A gate/budget refusal is NOT an access fact - we never asked ESI. Skip
      // for this session only; persisting it would suppress a lookup that might
      // have succeeded, for a week.
      if (result.skipped) {
        structureCache.set(structureId, null);
        return null;
      }

      // 304: unchanged since our stored ETag, and no body was sent. The name we
      // already hold is still correct - re-stamp it so its 24h TTL restarts.
      // Without this branch the empty body would read as "no name" and wipe a
      // perfectly good cache entry.
      if (result.notModified) {
        const prior = structureCachePersistent.getRaw(structureId);
        if (prior && prior.name) {
          const info = {
            name: prior.name,
            solarSystemId: prior.solarSystemId,
            typeId: prior.typeId,
          };
          structureCachePersistent.putResolved(structureId, info, character.characterId);
          structureCache.set(structureId, info);
          return info;
        }
        // A 304 with nothing stored should be impossible (we only send
        // If-None-Match when we have an ETag, which we only get alongside a
        // name). Treat it as a miss rather than inventing data.
        structureCache.set(structureId, null);
        return null;
      }

      const data = result.data || {};
      const info = {
        name: data.name || null,
        solarSystemId: data.solar_system_id || null,
        typeId: data.type_id || null,
      };
      if (info.name) {
        structureCachePersistent.putResolved(structureId, info, character.characterId);
      }
      structureCache.set(structureId, info.name ? info : null);
      return info.name ? info : null;
    } catch (error) {
      // Scope error, rate-limited, network. Session-only: none of these say
      // anything about whether this character can access this structure, so
      // none should earn a 7-day backoff. A bare labeled ID is fine meanwhile.
      console.log(`[Structures] Could not resolve structure ${structureId}: ${error.message}`);
      structureCache.set(structureId, null);
      return null;
    } finally {
      inFlight.delete(structureId);
    }
  })();

  inFlight.set(structureId, promise);
  const info = await promise;
  return info ? { structureId, ...info } : null;
}

/**
 * Resolve just the display name for a structure (or null).
 * @param {number} structureId
 * @param {number} [characterId]
 * @returns {Promise<string|null>}
 */
async function resolveStructureName(structureId, characterId = null) {
  const info = await resolveStructure(structureId, characterId);
  return info ? info.name : null;
}

/** Clear the in-memory structure cache (e.g. for testing or a manual refresh). */
function clearStructureCache() {
  structureCache.clear();
  inFlight.clear();
}

/**
 * User-initiated re-resolution of structures, overriding BOTH backoffs.
 *
 * This is the escape hatch that makes a 7-day denial backoff acceptable: a
 * character granted docking access should not have to wait it out.
 *
 * Three safety properties, because forcing a re-resolve of many previously
 * denied structures is EXACTLY the 403 burst that caused the original 420:
 *
 *   1. userInitiated - spends into the reserve (down to CRITICAL) rather than
 *      being refused at the background threshold, because the user asked.
 *   2. Stops cleanly at CRITICAL and reports partial progress, instead of
 *      grinding on until ESI discards everything.
 *   3. Re-arms the denial backoff on anything that 403s again, so repeatedly
 *      pressing the button cannot turn one burst into a loop.
 *
 * Sequential by design - parallel structure lookups are what spend a budget in
 * one go.
 *
 * @param {number[]} structureIds - structures to re-resolve
 * @param {number} [characterId] - preferred authenticating character
 * @returns {Promise<Object>} { requested, resolved, denied, stopped, remaining }
 */
async function refreshStructures(structureIds, characterId = null) {
  const errorBudget = require('./esi-error-budget');

  const ids = [...new Set((structureIds || []).filter(structureCachePersistent.isCacheable))];

  // Lift both timers first so the lookups below actually reach ESI.
  structureCachePersistent.clearBackoffs(ids);
  ids.forEach((id) => {
    structureCache.delete(id);
    inFlight.delete(id);
  });

  const summary = {
    requested: ids.length,
    resolved: 0,
    denied: 0,
    stopped: false,
    stoppedAfter: 0,
    remaining: null,
  };

  for (const id of ids) {
    // Check BEFORE each call: the budget is shared, so it can be spent by other
    // activity mid-loop.
    const budget = errorBudget.canSpend({ userInitiated: true });
    if (!budget.allowed) {
      summary.stopped = true;
      summary.stoppedAfter = summary.resolved + summary.denied;
      summary.remaining = budget.remaining;
      console.warn(
        `[Structures] Manual refresh stopped after ${summary.stoppedAfter}/${ids.length} ` +
        `to protect the ESI error budget (${budget.reason}).`
      );
      break;
    }

    const info = await resolveStructure(id, characterId);
    if (info && info.name) {
      summary.resolved += 1;
    } else {
      summary.denied += 1;
    }
  }

  if (!summary.stopped) {
    summary.remaining = errorBudget.getStatus().remaining;
  }

  console.log(
    `[Structures] Manual refresh: ${summary.resolved} resolved, ` +
    `${summary.denied} unresolved of ${summary.requested} requested` +
    (summary.stopped ? ' (stopped early — error budget)' : '')
  );

  return summary;
}

module.exports = {
  resolveStructure,
  resolveStructureName,
  clearStructureCache,
  refreshStructures,
};
