/**
 * Location ID classification — pure, no I/O.
 *
 * Splitting this out fixes a specific class of bug. `detectLocationType()` in
 * sde-database.js can only see the ID, and player structures share the >= 1
 * trillion "spawned items" pool with asset item_ids (docs/eve-id-ranges.md), so
 * it can NEVER return 'structure'. Two branches downstream tested for exactly
 * that value:
 *
 *   location-resolver.js:87   if (type === 'npc-station' || type === 'structure')
 *   location-resolver.js:267  else if (ultimateLocation.locationType === 'structure')
 *
 * Both were unreachable. The consequence was that an item nested inside a
 * container at a player structure fell through every branch and resolved to
 * "Unknown", while a top-level item at the SAME structure resolved fine.
 *
 * The fix is to give the classifier the one extra input that makes the
 * distinction decidable: the set of item_ids we own. A >= 1T id that is one of
 * our own items is a container; one that is not is a structure.
 *
 * Ranges are from docs/eve-id-ranges.md (official ID-ranges guide).
 */

/** Assets moved by CCP's asset-safety system all sit at this one fixed id. */
const ASSET_SAFETY_ID = 2004;

/** Spawned/dynamic items: asset item_ids AND player structures. */
const SPAWNED_ITEM_MIN = 1000000000000;

const RANGES = {
  npcStation: [60000000, 60999999],
  // 61M-63M outposts and 66M-69M station folders are NOT NPC stations and do
  // not resolve via staStations.
  outpost: [61000000, 63999999],
  stationFolder: [66000000, 69999999],
  // Solar systems span five sub-ranges: known space, wormhole, abyssal, void,
  // hidden. 33M and 35M are unallocated and deliberately excluded.
  systemKnown: [30000000, 30999999],
  systemWormhole: [31000000, 31999999],
  systemAbyssal: [32000000, 32999999],
  systemVoid: [34000000, 34999999],
  systemHidden: [36000000, 36999999],
};

function inRange(id, [lo, hi]) {
  return id >= lo && id <= hi;
}

function isSystemId(id) {
  return inRange(id, RANGES.systemKnown)
    || inRange(id, RANGES.systemWormhole)
    || inRange(id, RANGES.systemAbyssal)
    || inRange(id, RANGES.systemVoid)
    || inRange(id, RANGES.systemHidden);
}

/**
 * Classify a location id.
 *
 * @param {number|string} locationId
 * @param {Set<number>} [ownItemIds] - item_ids of assets we own. Required to
 *   tell an own container from a player structure; without it every >= 1T id
 *   is reported as 'structure-or-container' rather than guessed at.
 * @returns {string} One of:
 *   'npc-station'           resolves via SDE staStations
 *   'system'                resolves via SDE mapSolarSystems
 *   'asset-safety'          the fixed asset-safety location
 *   'own-container'         another asset of ours (ship/container/hangar)
 *   'structure'             player-owned Upwell structure - needs ESI
 *   'structure-or-container' >= 1T but we have no item-id set to decide with
 *   'outpost'               legacy outpost - no SDE name, no ESI endpoint
 *   'station-folder'        corp office / station folder container
 *   'unknown'               unallocated or unrecognised
 */
function classify(locationId, ownItemIds = null) {
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) return 'unknown';

  if (id === ASSET_SAFETY_ID) return 'asset-safety';

  // OWNERSHIP BEATS RANGE. If this id is one of our own assets it is a
  // container we can walk through, whatever range it falls in.
  //
  // This check must come before the range tests: legacy ships and containers
  // created before the 2010 id migration sit BELOW the 1-trillion spawned-item
  // floor (ids in the hundreds of millions). Testing the range first classified
  // them 'unknown', so the walk could not recognise them as ours.
  //
  // It also cannot be folded into the >= 1T branch alone - that is what made a
  // Golem with 29 items inside it get sent to ESI's structure endpoint.
  //
  // BOTH forms are checked because the assets table stores `item_id` as TEXT
  // and `location_id` as INTEGER, so a Set built straight from a query holds
  // strings while the id under test is a number. `Set.has` is strict-equality,
  // so a number probe silently misses a string Set - and every container then
  // looks like a structure. Callers should normalise (see indexAssets), but
  // this must not depend on their doing so: the failure is silent, expensive,
  // and burns ESI's error budget.
  if (ownItemIds && (ownItemIds.has(id) || ownItemIds.has(String(id)))) {
    return 'own-container';
  }

  if (id >= SPAWNED_ITEM_MIN) {
    // The whole reason this module exists: decidable only with the item-id set.
    // Reaching here means the id is NOT one of ours, so it is a structure.
    if (!ownItemIds) return 'structure-or-container';
    return 'structure';
  }

  if (inRange(id, RANGES.npcStation)) return 'npc-station';
  if (isSystemId(id)) return 'system';
  if (inRange(id, RANGES.outpost)) return 'outpost';
  if (inRange(id, RANGES.stationFolder)) return 'station-folder';

  return 'unknown';
}

/**
 * True when this classification names a real, final place - something an asset
 * can ultimately BE at, as opposed to a container to keep walking up through.
 * @param {string} kind
 */
function isTerminal(kind) {
  return kind === 'npc-station'
    || kind === 'structure'
    || kind === 'system'
    || kind === 'asset-safety'
    || kind === 'outpost';
}

module.exports = {
  classify,
  isTerminal,
  ASSET_SAFETY_ID,
  SPAWNED_ITEM_MIN,
  RANGES,
};
