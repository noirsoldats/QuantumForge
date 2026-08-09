/**
 * Corporation name resolver.
 *
 * Resolves a corporation ID to its name and ticker via ESI
 * (`/corporations/{id}/`). Unlike the structure resolver this endpoint is
 * PUBLIC - no token, no scope, no authenticating character to pick - so it
 * works even before any character is connected.
 *
 * Results are cached IN MEMORY for the app session. Corporation names rarely
 * change and a fresh session re-fetches, so a rename shows up on the next
 * launch rather than being pinned by a stale persistent cache. Mirrors
 * esi-structures.js deliberately: same caching, same in-flight dedupe, same
 * "a failure is cached as unresolvable for this session" rule.
 *
 * Callers previously read `character.corporationName`, which nothing ever
 * writes - so every one of them silently fell back to "Corporation <id>".
 */

const { esiFetch } = require('./esi-fetch');

// corporationId -> { name, ticker } | null (null = known-unresolvable this session)
const corporationCache = new Map();
// corporationId -> Promise, so concurrent callers dedupe onto one fetch.
const inFlight = new Map();

/**
 * Resolve a corporation ID to { corporationId, name, ticker }, or null when
 * it cannot be resolved. In-memory cached for the session.
 * @param {number} corporationId
 * @returns {Promise<{corporationId: number, name: string, ticker: string|null}|null>}
 */
async function resolveCorporation(corporationId) {
  if (!corporationId) return null;

  if (corporationCache.has(corporationId)) {
    const cached = corporationCache.get(corporationId);
    return cached ? { corporationId, ...cached } : null;
  }
  if (inFlight.has(corporationId)) {
    const cached = await inFlight.get(corporationId);
    return cached ? { corporationId, ...cached } : null;
  }

  const promise = (async () => {
    try {
      const url = `https://esi.evetech.net/latest/corporations/${corporationId}/?datasource=tranquility`;
      const result = await esiFetch('corporation_info', `corporation_${corporationId}`, url, {
        // Public endpoint: no character, no scope.
        requiresAuth: false,
        category: 'universe',
        endpointLabel: 'Corporation Info',
        // Own in-memory cache governs cadence; don't let the per-endpoint
        // gate suppress a first-time lookup.
        skipGate: true,
      });

      if (result.skipped) {
        corporationCache.set(corporationId, null);
        return null;
      }

      const data = result.data || {};
      const info = { name: data.name || null, ticker: data.ticker || null };
      corporationCache.set(corporationId, info.name ? info : null);
      return info.name ? info : null;
    } catch (error) {
      // Rate-limited, network, or an ID that no longer exists. A bare
      // labelled ID is a fine fallback, so don't retry this session.
      console.log(`[Corporations] Could not resolve corporation ${corporationId}: ${error.message}`);
      corporationCache.set(corporationId, null);
      return null;
    } finally {
      inFlight.delete(corporationId);
    }
  })();

  inFlight.set(corporationId, promise);
  const info = await promise;
  return info ? { corporationId, ...info } : null;
}

/**
 * Resolve just the display name for a corporation (or null).
 * @param {number} corporationId
 * @returns {Promise<string|null>}
 */
async function resolveCorporationName(corporationId) {
  const info = await resolveCorporation(corporationId);
  return info ? info.name : null;
}

/**
 * Resolve several corporations at once, deduped.
 * @param {number[]} corporationIds
 * @returns {Promise<Object>} corporationId -> name, omitting unresolvable ids
 */
async function resolveCorporationNames(corporationIds) {
  const unique = [...new Set((corporationIds || []).filter(Boolean))];
  const results = await Promise.all(unique.map((id) => resolveCorporation(id)));

  const out = {};
  results.forEach((info, i) => {
    if (info && info.name) out[unique[i]] = info.name;
  });
  return out;
}

/** Clear the in-memory cache (for testing, or a manual refresh). */
function clearCorporationCache() {
  corporationCache.clear();
  inFlight.clear();
}

module.exports = {
  resolveCorporation,
  resolveCorporationName,
  resolveCorporationNames,
  clearCorporationCache,
};
