/**
 * Corporation hangar divisions.
 *
 * EVE corp hangars are seven numbered divisions, exposed on an asset or
 * blueprint as a `location_flag` of the form `CorpSAG1` … `CorpSAG7`. Items in
 * a corp location that is NOT a numbered hangar (deliveries, containers,
 * ships) carry other flags and cannot be attributed to a division at all.
 *
 * THE RULE, and it is absolute: if we cannot attribute a corp item to an
 * ENABLED division, we do not use it. No divisions configured means no corp
 * items. An unparseable flag means that item is out. This applies identically
 * to assets and to blueprints, in every tool.
 *
 * Two copies of this logic previously existed - `cleanup-tool.js` and
 * `manufacturing-plans.js` - under the same name and signature but with
 * opposite edge behaviour: cleanup-tool included corp items when no divisions
 * were configured or the flag would not parse. That was a bug, not a
 * deliberate policy: it silently pulled in corp holdings the user never opted
 * into, which is the same class of surprise as a corp BPO overriding a
 * personal blueprint's ME. Both callers now fail closed.
 */

/**
 * Division id from a corp hangar location flag.
 *
 * @param {string} locationFlag e.g. "CorpSAG2"
 * @returns {number|null} 1-7, or null when the flag is absent, not a corp
 *   hangar, or not parseable.
 */
function divisionFromLocationFlag(locationFlag) {
  if (!locationFlag || typeof locationFlag !== 'string') return null;
  // Anchored: `CorpSAG12` and `XCorpSAG1` are not division 1.
  const match = locationFlag.match(/^CorpSAG(\d)$/);
  if (!match) return null;

  const id = parseInt(match[1], 10);
  return id >= 1 && id <= 7 ? id : null;
}

/**
 * Is this location flag inside an enabled corp division?
 *
 * Call this ONLY for corp-owned items - personal items are not division-scoped
 * and must be filtered before reaching here.
 *
 * Returns false when no divisions are enabled and when the flag cannot be
 * attributed to a division. There is no opt-out from that.
 *
 * @param {string} locationFlag
 * @param {number[]} enabledDivisions division ids the user has turned on
 * @returns {boolean}
 */
function isInEnabledDivision(locationFlag, enabledDivisions) {
  if (!enabledDivisions || enabledDivisions.length === 0) return false;

  const divisionId = divisionFromLocationFlag(locationFlag);
  if (divisionId === null) return false;

  return enabledDivisions.includes(divisionId);
}

/**
 * Group characters by corporation, unioning their enabled divisions.
 *
 * Several characters can belong to the same corp and see the SAME corp hangar.
 * Corp items are stored once per character who can see them (the blueprints and
 * assets tables are keyed on `(character_id, item_id)`), so reading every
 * character's corp items double-counts.
 *
 * The previous guard skipped a corp after the first character, which deduped
 * but silently adopted THAT character's division list and discarded everyone
 * else's - so with A enabling division 1 and B enabling 1+2, whether division 2
 * counted depended on iteration order.
 *
 * Unioning fixes both: each corp is read exactly once (no duplication) using
 * every division any of its characters enabled (no lost configuration, no
 * ordering dependence). Divisions are a property of the corp hangar; the
 * per-character setting means "which divisions do I want used".
 *
 * @param {Array<{characterId: number, corporationId: number, divisions: number[]}>} entries
 * @returns {Array<{corporationId: number, readerCharacterId: number, divisions: number[]}>}
 *   one entry per corp; `readerCharacterId` is the character whose stored rows
 *   should be read (they are identical across the corp's characters).
 */
function unionDivisionsByCorp(entries) {
  const byCorp = new Map();

  for (const entry of entries || []) {
    if (!entry || !entry.corporationId) continue;

    const existing = byCorp.get(entry.corporationId);
    if (!existing) {
      byCorp.set(entry.corporationId, {
        corporationId: entry.corporationId,
        readerCharacterId: entry.characterId,
        divisions: new Set(entry.divisions || []),
      });
      continue;
    }

    for (const division of entry.divisions || []) {
      existing.divisions.add(division);
    }
  }

  return Array.from(byCorp.values()).map((corp) => ({
    corporationId: corp.corporationId,
    readerCharacterId: corp.readerCharacterId,
    divisions: Array.from(corp.divisions).sort((a, b) => a - b),
  }));
}

module.exports = {
  divisionFromLocationFlag,
  isInEnabledDivision,
  unionDivisionsByCorp,
};
