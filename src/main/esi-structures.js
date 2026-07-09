/**
 * Player-structure name resolver.
 *
 * Resolves a structure ID to its name via ESI (`/universe/structures/{id}/`,
 * needs esi-universe.read_structures.v1). Results are cached IN MEMORY for the
 * app session — structure names rarely change, and a fresh session re-fetches,
 * so a rename shows up on the next launch (no stale persistent cache).
 *
 * Guarantees at most one ESI call per structure per session (and marks
 * inaccessible/failed structures so we don't retry them within the session).
 */

const { esiFetch } = require('./esi-fetch');
const { getCharacters, getCharacter } = require('./settings-manager');

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

  const promise = (async () => {
    const character = pickAuthCharacter(characterId);
    if (!character) {
      structureCache.set(structureId, null); // no character can resolve it this session
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
      });

      // Gated/role-forbidden (no docking access) → not resolvable this session.
      if (result.skipped || result.roleForbidden) {
        structureCache.set(structureId, null);
        return null;
      }

      const data = result.data || {};
      const info = {
        name: data.name || null,
        solarSystemId: data.solar_system_id || null,
        typeId: data.type_id || null,
      };
      structureCache.set(structureId, info.name ? info : null);
      return info.name ? info : null;
    } catch (error) {
      // 403 (no access), scope error, rate-limited, network — don't retry this
      // session; a bare labeled ID is fine as the fallback.
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

module.exports = {
  resolveStructure,
  resolveStructureName,
  clearStructureCache,
};
