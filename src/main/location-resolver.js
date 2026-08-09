/**
 * Asset location resolution.
 *
 * An asset's location_id is a CHAIN, not a place. It may point at a station, a
 * solar system, a player structure, or — commonly — at the item_id of another
 * asset (a ship, container, or hangar), which itself has a location_id, and so
 * on until the chain reaches a real place.
 * See https://docs.esi.evetech.net/docs/asset_location_id.html
 *
 * This module walks that chain. It is structured as a pipeline with one job per
 * stage, because the previous single-function version interleaved four jobs
 * (classifying ids, walking the tree, calling ESI, formatting strings) and grew
 * two unreachable branches nobody noticed:
 *
 *   - `detectLocationType()` can never return 'structure' — player structures
 *     and asset item_ids share the >= 1 trillion range — yet both the walk's
 *     terminal test and the name-resolution branch compared against exactly
 *     that value. An item nested in a container at a player structure therefore
 *     fell through everything and resolved to "Unknown", while a top-level item
 *     at the SAME structure resolved fine.
 *   - The walk called `assets.find()` per hop over a freshly re-read array, and
 *     `getAssets()` (a full table read) ran once per location.
 *
 * The pipeline:
 *   1. buildAssetIndex   — read assets ONCE, build Map + item-id Set
 *   2. classify          — pure; decides container vs structure using that Set
 *   3. walkChain         — pure; follows the chain to a terminal place
 *   4. resolveTerminal   — the only stage that touches SDE or ESI
 *   5. formatLocation    — builds display strings in one place
 */

const { getAssets } = require('./esi-assets');
const {
  getLocationName,
  getSystemNameFromStation,
  getSystemName,
  getTypeName,
} = require('./sde-database');
const { classify, isTerminal } = require('./location-classifier');

// Key format: "locationId-characterId-isCorporation"
const locationInfoCache = new Map();

function getCacheKey(locationId, characterId, isCorporation) {
  return `${locationId}-${characterId}-${isCorporation}`;
}

/**
 * Clear location cache for a specific character
 * @param {number} characterId - Character ID
 * @param {boolean} isCorporation - Whether to clear corporation cache
 */
function clearLocationCache(characterId, isCorporation) {
  const suffix = `-${characterId}-${isCorporation}`;
  const keysToDelete = [];

  for (const key of locationInfoCache.keys()) {
    if (key.endsWith(suffix)) {
      keysToDelete.push(key);
    }
  }

  keysToDelete.forEach(key => locationInfoCache.delete(key));
  console.log(`Cleared ${keysToDelete.length} location cache entries for character ${characterId} (corp: ${isCorporation})`);
}

/** Clear all location cache */
function clearAllLocationCache() {
  const size = locationInfoCache.size;
  locationInfoCache.clear();
  console.log(`Cleared all ${size} location cache entries`);
}

/** Cache statistics */
function getLocationCacheStats() {
  return {
    size: locationInfoCache.size,
    entries: Array.from(locationInfoCache.keys()),
  };
}

// ---------------------------------------------------------------------------
// 1. Asset index
// ---------------------------------------------------------------------------

/**
 * Read the character's assets ONCE and build the lookups the walk needs.
 *
 * Previously `getAssets()` (a full table read) ran inside the per-location
 * resolver, and each hop did a linear `assets.find()`. With ~1,200 assets and
 * dozens of distinct locations that is tens of thousands of comparisons plus a
 * repeated table read, for data that is identical across the whole batch.
 *
 * @param {number} characterId
 * @param {boolean} isCorporation
 * @returns {{ byItemId: Map<number, Object>, itemIds: Set<number> }}
 */
function buildAssetIndex(characterId, isCorporation = false) {
  const assets = getAssets(characterId, isCorporation) || [];
  return indexAssets(assets);
}

/**
 * Build the lookup structures from an asset array.
 *
 * IDs are normalised to Numbers because the assets table stores `item_id` as
 * TEXT and `location_id` as INTEGER. Without this the Set lookup in classify()
 * compares a number against strings, `Set.has` is strict-equality, and EVERY
 * one of our own containers is misread as a player structure - which sends a
 * ship or can to ESI's structure endpoint, earns a 403, and spends the
 * application-wide error budget. That is precisely the bug this whole layer
 * exists to prevent, so the coercion is load-bearing, not defensive.
 *
 * Ids stay well inside Number.MAX_SAFE_INTEGER (EVE spawned ids are ~1e12
 * against a ~9e15 ceiling), so Number() is exact here.
 *
 * @param {Array} assets
 * @returns {{ byItemId: Map<number, Object>, itemIds: Set<number> }}
 */
function indexAssets(assets) {
  const byItemId = new Map();
  const itemIds = new Set();

  for (const asset of assets || []) {
    const itemId = Number(asset.itemId);
    if (!Number.isFinite(itemId)) continue;
    byItemId.set(itemId, { ...asset, itemId, locationId: Number(asset.locationId) });
    itemIds.add(itemId);
  }

  return { byItemId, itemIds };
}

// ---------------------------------------------------------------------------
// 2/3. Chain walk
// ---------------------------------------------------------------------------

/**
 * Follow a location chain up to the real place that contains it.
 *
 * Pure: no I/O. Terminates when `classify` reports a terminal kind — which it
 * can now genuinely do for player structures, because it is given the item-id
 * Set and can distinguish "one of our containers" from "a structure".
 *
 * @param {number} locationId - starting location id
 * @param {{byItemId: Map, itemIds: Set}} index
 * @returns {{terminalId: number, terminalKind: string, containerPath: Array}}
 */
function walkChain(locationId, index) {
  const visited = new Set();
  const containerPath = [];
  // Normalised for the same reason the index is - see indexAssets(). A string
  // id here would miss every Map/Set lookup below.
  let current = Number(locationId);

  while (current) {
    if (visited.has(current)) {
      console.warn(`Circular reference detected in asset tree at location ${current}`);
      break;
    }
    visited.add(current);

    const kind = classify(current, index.itemIds);

    if (isTerminal(kind)) {
      return { terminalId: current, terminalKind: kind, containerPath: containerPath.reverse() };
    }

    // Not terminal: it should be one of our own containers. Step up through it.
    const container = index.byItemId.get(current);
    if (!container) {
      // Nothing to step through and not a place we recognise. Report it as-is
      // rather than inventing a classification.
      return { terminalId: current, terminalKind: kind, containerPath: containerPath.reverse() };
    }

    containerPath.push({
      itemId: container.itemId,
      typeId: container.typeId,
      locationFlag: container.locationFlag,
    });

    current = container.locationId;
  }

  return { terminalId: locationId, terminalKind: 'unknown', containerPath: containerPath.reverse() };
}

// ---------------------------------------------------------------------------
// 4. Terminal resolution (the only stage that does I/O)
// ---------------------------------------------------------------------------

/**
 * Turn a terminal id + kind into { stationName, systemName, locationType }.
 * @returns {Promise<Object>}
 */
async function resolveTerminal(terminalId, terminalKind, characterId) {
  switch (terminalKind) {
    case 'npc-station': {
      const [stationName, systemName] = await Promise.all([
        getLocationName(terminalId).catch(() => null),
        getSystemNameFromStation(terminalId).catch(() => null),
      ]);
      return {
        stationName: stationName || `Station (ID: ${terminalId})`,
        systemName: systemName || 'Unknown System',
        locationType: 'npc-station',
      };
    }

    case 'system': {
      const systemName = await getSystemName(terminalId).catch(() => null);
      return {
        stationName: null,
        systemName: systemName || 'Unknown System',
        locationType: 'system',
      };
    }

    case 'asset-safety':
      return {
        stationName: 'Asset Safety',
        systemName: 'Asset Safety',
        locationType: 'asset-safety',
      };

    case 'structure': {
      // The only ESI-backed branch. resolveStructure owns its own caching
      // (in-memory for the session + persistent with a 24h/7-day TTL), so this
      // is at most one call per structure and none at all while a name or a
      // denial is still fresh.
      let structure = null;
      try {
        const { resolveStructure } = require('./esi-structures');
        structure = await resolveStructure(terminalId, characterId);
      } catch (error) {
        // Cosmetic failure — fall back to the labelled id below.
        console.log(`[Locations] Structure ${terminalId} unresolved: ${error.message}`);
      }

      if (structure && structure.name) {
        let systemName = null;
        if (structure.solarSystemId) {
          systemName = await getSystemName(structure.solarSystemId).catch(() => null);
        }
        return {
          stationName: structure.name,
          systemName: systemName || 'Unknown System',
          locationType: 'structure',
        };
      }

      // No access / not resolvable. Show the last name we ever saw if we have
      // one — better than a bare id — otherwise the labelled placeholder.
      const { getLastKnownName } = require('./structure-cache');
      const lastKnown = getLastKnownName(terminalId);
      return {
        stationName: lastKnown || `Player Structure (ID: ${terminalId})`,
        systemName: 'Unknown System',
        locationType: 'structure',
      };
    }

    case 'outpost':
      return {
        stationName: `Outpost (ID: ${terminalId})`,
        systemName: 'Unknown System',
        locationType: 'outpost',
      };

    case 'station-folder':
      return {
        stationName: `Office (ID: ${terminalId})`,
        systemName: 'Unknown System',
        locationType: 'station-folder',
      };

    default:
      return {
        stationName: `Unknown Location (ID: ${terminalId})`,
        systemName: 'Unknown System',
        locationType: 'unknown',
      };
  }
}

/** Resolve container type names from SDE. */
async function resolveContainerNames(containerPath) {
  const names = [];

  for (const container of containerPath) {
    try {
      const typeName = await getTypeName(container.typeId);
      names.push(typeName || 'Container');
    } catch (error) {
      console.error(`Error resolving type name for ${container.typeId}:`, error);
      names.push('Container');
    }
  }

  return names;
}

// ---------------------------------------------------------------------------
// 5. Formatting
// ---------------------------------------------------------------------------

/**
 * Build the display shape. One place, so a branch cannot forget a field —
 * which is how the old code produced `stationName: null`.
 *
 * `fullPath` is the TERMINAL PLACE ONLY — the station or structure the chain
 * ends at, never the containers on the way there.
 *
 * That distinction matters because callers group and facet on `fullPath`. When
 * it included the container names, two items sitting in the same hangar but in
 * different ships produced different values ("Sotiyo - Golem" vs
 * "Sotiyo - Revelation"), so the Assets screen split one station into a
 * separate row and facet per container.
 *
 * The chain is still available, and richer than before:
 *   containerNames  outermost-first type names, e.g. ['Golem', 'Station Container']
 *   containerPath   the same chain with locationFlag, for a full breadcrumb
 *   chainLabel      ready-to-display "Cargo → Golem → Sotiyo"
 *
 * @param {Object} terminal
 * @param {string[]} containerNames - outermost-first, aligned with containerPath
 * @param {Array} containerPath - outermost-first hops
 * @param {string|null} [itemFlag] - the ITEM's own location_flag; it names where
 *   the item sits inside the innermost container ("Cargo", "MedSlot6")
 */
function formatLocation(terminal, containerNames, containerPath = [], itemFlag = null) {
  const place = terminal.stationName || terminal.systemName || 'Unknown';

  // A location_flag describes where the FLAGGED THING sits inside its parent,
  // so the chain reads innermost-first as:
  //
  //   <item's flag> → <each container, inner to outer> → <place>
  //   Cargo         → Golem                            → Sotiyo
  //
  // Only the ITEM's flag appears. The intermediate containers' own flags are
  // deliberately omitted: naming both containers already says where the item
  // is, and interleaving their flags produced confusing repetition on nested
  // chains ("Cargo → Station Container → Cargo → Golem" - both flags really
  // are "Cargo", which reads as a rendering fault).
  //
  // containerPath is outermost-first, so walk it inner-to-outer.
  const innerNames = [...containerNames].reverse();

  const segments = [];
  if (itemFlag) segments.push(itemFlag);
  innerNames.forEach((name, i) => segments.push(name || `Container ${i + 1}`));
  segments.push(place);

  const chainLabel = segments.join(' → ');

  return {
    systemName: terminal.systemName || 'Unknown System',
    stationName: terminal.stationName || null,
    containerNames,
    containerPath,
    // The place, and only the place. See the note above.
    fullPath: place,
    chainLabel,
    locationType: terminal.locationType,
  };
}

/**
 * Build a full breadcrumb for ONE item at an already-resolved location.
 *
 * Resolved locations are cached per location id and shared by every item there,
 * but `location_flag` belongs to the item ("Cargo", "MedSlot6", "DroneBay"), so
 * the innermost hop can only be completed once the item is known. This applies
 * that final piece:
 *
 *   buildChainLabel(locationInfo, 'Cargo')  ->  "Cargo → Golem → Sotiyo"
 *
 * For an item sitting directly in a station there are no containers, so the
 * result is just the place - no misleading "Hangar → " prefix.
 *
 * @param {Object} locationInfo - a resolveLocationInfo result
 * @param {string|null} itemFlag - the item's own location_flag
 * @returns {string}
 */
function buildChainLabel(locationInfo, itemFlag) {
  if (!locationInfo) return 'Unknown';

  const place = locationInfo.stationName || locationInfo.systemName || 'Unknown';
  const containerPath = locationInfo.containerPath || [];
  if (containerPath.length === 0) return place;

  return formatLocation(
    {
      stationName: locationInfo.stationName,
      systemName: locationInfo.systemName,
      locationType: locationInfo.locationType,
    },
    locationInfo.containerNames || [],
    containerPath,
    itemFlag
  ).chainLabel;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve one location using a prebuilt asset index.
 * @param {number} locationId
 * @param {number} characterId
 * @param {boolean} isCorporation
 * @param {{byItemId: Map, itemIds: Set}} index
 */
async function resolveWithIndex(locationId, characterId, isCorporation, index) {
  const cacheKey = getCacheKey(locationId, characterId, isCorporation);
  const cached = locationInfoCache.get(cacheKey);
  if (cached) return cached;

  try {
    const { terminalId, terminalKind, containerPath } = walkChain(locationId, index);

    const terminal = await resolveTerminal(terminalId, terminalKind, characterId);
    const containerNames = await resolveContainerNames(containerPath);
    // No item flag here: this result is cached per LOCATION and shared by every
    // item at that location, while the flag ("Cargo", "MedSlot6") differs per
    // item. Callers that know their item's flag build the final chain label
    // with buildChainLabel(); chainLabel here is the location's own chain.
    const result = formatLocation(terminal, containerNames, containerPath);

    locationInfoCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error(`Error resolving location ${locationId}:`, error);
    const errorResult = {
      systemName: 'Unknown',
      stationName: 'Unknown',
      containerNames: [],
      fullPath: 'Unknown',
      locationType: 'error',
    };
    // Deliberately NOT cached: an error is transient (network, DB), unlike a
    // resolved name. Caching it would pin "Unknown" for the whole session.
    return errorResult;
  }
}

/**
 * Resolve location information for a single location.
 * @param {number} locationId - Location ID
 * @param {number} characterId - Character ID
 * @param {boolean} isCorporation - Whether this is corporation data
 * @returns {Promise<Object>} { systemName, stationName, containerNames, fullPath, locationType }
 */
async function resolveLocationInfo(locationId, characterId, isCorporation = false) {
  const cacheKey = getCacheKey(locationId, characterId, isCorporation);
  const cached = locationInfoCache.get(cacheKey);
  if (cached) return cached;

  const index = buildAssetIndex(characterId, isCorporation);
  return resolveWithIndex(locationId, characterId, isCorporation, index);
}

/**
 * Resolve many locations in one call.
 *
 * The Assets screen previously awaited resolveLocationInfo once PER ASSET —
 * over a thousand sequential IPC round-trips on load. Deduping first means the
 * work is proportional to DISTINCT locations (a few dozen), and the asset index
 * is built once for the whole batch instead of once per location.
 *
 * Resolution is sequential by design: these can hit ESI, and firing dozens of
 * structure lookups in parallel is precisely what spends the error budget in
 * one burst.
 *
 * @param {Array<number|string>} locationIds
 * @param {number} characterId
 * @param {boolean} [isCorporation=false]
 * @returns {Promise<Object>} locationId -> location info
 */
async function resolveLocationInfoMany(locationIds, characterId, isCorporation = false) {
  const unique = [...new Set((locationIds || []).filter((id) => id != null))];
  const out = {};

  if (unique.length === 0) return out;

  const index = buildAssetIndex(characterId, isCorporation);

  for (const locationId of unique) {
    try {
      out[locationId] = await resolveWithIndex(locationId, characterId, isCorporation, index);
    } catch (error) {
      // One unresolvable location must not lose the other hundred.
      console.error(`[Locations] Could not resolve ${locationId}: ${error.message}`);
      out[locationId] = {
        systemName: 'Unknown',
        stationName: 'Unknown',
        containerNames: [],
        fullPath: 'Unknown',
        locationType: 'error',
      };
    }
  }

  return out;
}

/**
 * Legacy shape kept for existing callers/tests: walk an asset chain given a
 * plain assets ARRAY rather than a prebuilt index.
 * @param {number} locationId
 * @param {Array} assets
 * @returns {Object|null} { locationId, locationType, containerPath }
 */
function findUltimateLocation(locationId, assets) {
  // Goes through indexAssets rather than building a Map/Set inline, so it gets
  // the same TEXT/INTEGER normalisation. Hand-rolling it here once meant this
  // path carried the container-misclassified-as-structure bug independently of
  // the main one.
  const { terminalId, terminalKind, containerPath } = walkChain(
    locationId, indexAssets(assets)
  );
  return { locationId: terminalId, locationType: terminalKind, containerPath };
}

module.exports = {
  findUltimateLocation,
  walkChain,
  buildAssetIndex,
  indexAssets,
  formatLocation,
  buildChainLabel,
  resolveLocationInfo,
  resolveLocationInfoMany,
  clearLocationCache,
  clearAllLocationCache,
  getLocationCacheStats,
};
