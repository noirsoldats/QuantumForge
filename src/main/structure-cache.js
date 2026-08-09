/**
 * Persistent player-structure cache (character-data.db, table resolved_structures).
 *
 * WHY THIS EXISTS: structure names were cached in memory only, so every launch
 * re-attempted every structure. Structures the character cannot dock at answer
 * 403, and 4xx responses count against ESI's APPLICATION-WIDE error limit (100
 * non-2xx/3xx per minute; exceed it and ESI returns 420 for every route). A
 * user with assets spread across many inaccessible structures burned the budget
 * on every launch and took unrelated background calls down with them.
 *
 * Two TTLs, deliberately different (see migration 027):
 *
 *   NAME_TTL_MS    24h. A name can change; a stale name presented as fact is
 *                  worse than a brief unknown.
 *   DENIED_TTL_MS  7 days. A denial is an ACCESS fact, not a name - it changes
 *                  when docking rights change, not when the owner renames the
 *                  structure. Giving denials the 24h TTL would restore the
 *                  daily 403 burst this cache exists to stop.
 *
 * Both are overridable by an explicit user-initiated refresh, which is the
 * escape hatch that makes the 7-day backoff safe.
 *
 * Only >= 1 trillion Upwell structures belong here. NPC stations resolve from
 * the SDE and never call ESI.
 */

const { getCharacterDatabase } = require('./character-database');
const { SPAWNED_ITEM_MIN } = require('./location-classifier');

/** A resolved name is trusted for 24h. */
const NAME_TTL_MS = 24 * 60 * 60 * 1000;
/** An access denial is trusted for 7 days. */
const DENIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Only player structures are cacheable. Anything below the spawned-item floor
 * is an NPC station/system that resolves from the SDE for free.
 */
function isCacheable(structureId) {
  const id = Number(structureId);
  return Number.isFinite(id) && id >= SPAWNED_ITEM_MIN;
}

/**
 * Look up a structure.
 *
 * @param {number} structureId
 * @param {number} [now]
 * @returns {Object|null} null when we have nothing usable and a lookup should
 *   run. Otherwise { status, name, solarSystemId, typeId, resolvedAt, deniedAt }
 *   where status is:
 *     'resolved' - a fresh name, use it
 *     'denied'   - a fresh denial, do NOT call ESI
 */
function get(structureId, now = Date.now()) {
  if (!isCacheable(structureId)) return null;

  try {
    const db = getCharacterDatabase();
    const row = db.prepare(`
      SELECT structure_id, name, solar_system_id, type_id,
             resolved_at, denied_at, resolved_by
        FROM resolved_structures
       WHERE structure_id = ?
    `).get(structureId);

    if (!row) return null;

    // A fresh name wins over a stale denial: access was regained.
    if (row.name && row.resolved_at && (now - row.resolved_at) < NAME_TTL_MS) {
      return {
        status: 'resolved',
        structureId: row.structure_id,
        name: row.name,
        solarSystemId: row.solar_system_id,
        typeId: row.type_id,
        resolvedAt: row.resolved_at,
      };
    }

    if (row.denied_at && (now - row.denied_at) < DENIED_TTL_MS) {
      return {
        status: 'denied',
        structureId: row.structure_id,
        deniedAt: row.denied_at,
      };
    }

    // Row exists but everything in it has aged out - treat as a miss so the
    // caller re-resolves.
    return null;
  } catch (error) {
    // A cache is an optimisation; never let it break resolution.
    console.error(`[StructureCache] Read failed for ${structureId}:`, error.message);
    return null;
  }
}

/**
 * Record a successful name lookup. Clears any denial - access was regained.
 * @param {number} structureId
 * @param {Object} info - { name, solarSystemId, typeId }
 * @param {number} [characterId] - who authenticated the lookup
 */
function putResolved(structureId, info, characterId = null, now = Date.now()) {
  if (!isCacheable(structureId) || !info || !info.name) return;

  try {
    const db = getCharacterDatabase();
    db.prepare(`
      INSERT INTO resolved_structures
        (structure_id, name, solar_system_id, type_id, resolved_at, denied_at, resolved_by, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(structure_id) DO UPDATE SET
        name            = excluded.name,
        solar_system_id = excluded.solar_system_id,
        type_id         = excluded.type_id,
        resolved_at     = excluded.resolved_at,
        denied_at       = NULL,
        resolved_by     = excluded.resolved_by,
        updated_at      = excluded.updated_at
    `).run(
      structureId,
      info.name,
      info.solarSystemId || null,
      info.typeId || null,
      now,
      characterId || null,
      now
    );
  } catch (error) {
    console.error(`[StructureCache] Write failed for ${structureId}:`, error.message);
  }
}

/**
 * Record that ESI refused access (403, or a budget refusal that means we could
 * not even ask). Deliberately KEEPS any previously resolved name: showing the
 * last known name beats showing a bare ID, and the name's own TTL still governs
 * whether it is trusted.
 * @param {number} structureId
 */
function putDenied(structureId, now = Date.now()) {
  if (!isCacheable(structureId)) return;

  try {
    const db = getCharacterDatabase();
    db.prepare(`
      INSERT INTO resolved_structures
        (structure_id, name, solar_system_id, type_id, resolved_at, denied_at, resolved_by, updated_at)
      VALUES (?, NULL, NULL, NULL, NULL, ?, NULL, ?)
      ON CONFLICT(structure_id) DO UPDATE SET
        denied_at  = excluded.denied_at,
        updated_at = excluded.updated_at
    `).run(structureId, now, now);
  } catch (error) {
    console.error(`[StructureCache] Denial write failed for ${structureId}:`, error.message);
  }
}

/**
 * Clear the backoffs so the next lookup actually calls ESI.
 *
 * This is the escape hatch that makes a 7-day denial backoff acceptable: a user
 * who has just been granted docking access does not have to wait it out.
 *
 * Clears BOTH timers - a forced refresh that honoured either one would not be a
 * forced refresh. Rows (and their last known names) are kept, so a structure
 * that fails to re-resolve still displays its previous name rather than
 * regressing to a bare ID.
 *
 * @param {number[]} [structureIds] - specific structures, or all when omitted
 * @returns {number} rows affected
 */
function clearBackoffs(structureIds = null) {
  try {
    const db = getCharacterDatabase();

    if (Array.isArray(structureIds) && structureIds.length > 0) {
      const ids = structureIds.filter(isCacheable);
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => '?').join(',');
      const result = db.prepare(`
        UPDATE resolved_structures
           SET resolved_at = NULL, denied_at = NULL, updated_at = ?
         WHERE structure_id IN (${placeholders})
      `).run(Date.now(), ...ids);
      return result.changes;
    }

    const result = db.prepare(`
      UPDATE resolved_structures
         SET resolved_at = NULL, denied_at = NULL, updated_at = ?
    `).run(Date.now());
    return result.changes;
  } catch (error) {
    console.error('[StructureCache] Could not clear backoffs:', error.message);
    return 0;
  }
}

/**
 * The stored row ignoring both TTLs, or null.
 *
 * For the two cases where age is not the question: a 304 (the data is
 * confirmed current, so re-stamp what we hold) and display fallback (a stale
 * name beats a bare ID).
 * @returns {Object|null} { name, solarSystemId, typeId, resolvedAt, deniedAt }
 */
function getRaw(structureId) {
  if (!isCacheable(structureId)) return null;
  try {
    const db = getCharacterDatabase();
    const row = db.prepare(`
      SELECT name, solar_system_id, type_id, resolved_at, denied_at
        FROM resolved_structures
       WHERE structure_id = ?
    `).get(structureId);
    if (!row) return null;
    return {
      name: row.name || null,
      solarSystemId: row.solar_system_id,
      typeId: row.type_id,
      resolvedAt: row.resolved_at,
      deniedAt: row.denied_at,
    };
  } catch (error) {
    return null;
  }
}

/** Last known name regardless of TTL - for display fallback only. */
function getLastKnownName(structureId) {
  const row = getRaw(structureId);
  return row && row.name ? row.name : null;
}

/** Counts for the ESI Status screen. */
function getStats(now = Date.now()) {
  try {
    const db = getCharacterDatabase();
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN name IS NOT NULL AND resolved_at IS NOT NULL
                  AND (? - resolved_at) < ? THEN 1 ELSE 0 END) AS fresh,
        SUM(CASE WHEN denied_at IS NOT NULL
                  AND (? - denied_at) < ? THEN 1 ELSE 0 END) AS denied
      FROM resolved_structures
    `).get(now, NAME_TTL_MS, now, DENIED_TTL_MS);

    return {
      total: row.total || 0,
      fresh: row.fresh || 0,
      denied: row.denied || 0,
      nameTtlMs: NAME_TTL_MS,
      deniedTtlMs: DENIED_TTL_MS,
    };
  } catch (error) {
    return { total: 0, fresh: 0, denied: 0, nameTtlMs: NAME_TTL_MS, deniedTtlMs: DENIED_TTL_MS };
  }
}

module.exports = {
  get,
  getRaw,
  putResolved,
  putDenied,
  clearBackoffs,
  getLastKnownName,
  getStats,
  isCacheable,
  NAME_TTL_MS,
  DENIED_TTL_MS,
};
