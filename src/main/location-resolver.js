const { getAssets } = require('./esi-assets');
const {
  detectLocationType,
  getLocationName,
  getSystemNameFromStation,
  getSystemName,
  getTypeName,
} = require('./sde-database');

// Location info cache
// Key format: "locationId-characterId-isCorporation"
// This caches resolved location info to avoid redundant lookups
const locationInfoCache = new Map();

/**
 * Get cache key for a location
 * @param {number} locationId - Location ID
 * @param {number} characterId - Character ID
 * @param {boolean} isCorporation - Whether this is corporation data
 * @returns {string} Cache key
 */
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

/**
 * Clear all location cache
 */
function clearAllLocationCache() {
  const size = locationInfoCache.size;
  locationInfoCache.clear();
  console.log(`Cleared all ${size} location cache entries`);
}

/**
 * Get cache statistics
 * @returns {Object} Cache statistics
 */
function getLocationCacheStats() {
  return {
    size: locationInfoCache.size,
    entries: Array.from(locationInfoCache.keys()),
  };
}

/**
 * Traverse asset tree to find ultimate location
 * @param {number} locationId - Starting location ID
 * @param {Array} assets - Array of all assets for the character
 * @returns {Object|null} Ultimate location info { locationId, locationType, containerPath }
 */
function findUltimateLocation(locationId, assets) {
  const visited = new Set();
  const containerPath = [];
  let currentLocationId = locationId;

  // Traverse up the asset tree
  while (currentLocationId) {
    // Prevent infinite loops
    if (visited.has(currentLocationId)) {
      console.warn(`Circular reference detected in asset tree at location ${currentLocationId}`);
      break;
    }
    visited.add(currentLocationId);

    // Check if this is a station or structure (final location)
    const locationType = detectLocationType(currentLocationId);
    if (locationType === 'npc-station' || locationType === 'structure') {
      return {
        locationId: currentLocationId,
        locationType: locationType,
        containerPath: containerPath.reverse(),
      };
    }

    // Find the asset that has this location_id as its item_id
    // This means we're IN this asset (it's a container)
    const containerAsset = assets.find((a) => a.itemId === currentLocationId);

    if (!containerAsset) {
      // No parent container found - this might be the ultimate location
      return {
        locationId: currentLocationId,
        locationType: locationType,
        containerPath: containerPath.reverse(),
      };
    }

    // Add this container to the path
    containerPath.push({
      itemId: containerAsset.itemId,
      typeId: containerAsset.typeId,
      locationFlag: containerAsset.locationFlag,
    });

    // Move up to the parent location
    currentLocationId = containerAsset.locationId;
  }

  return null;
}

/**
 * Resolve container names from type IDs
 * @param {Array} containerPath - Array of container objects with typeId
 * @returns {Promise<Array<string>>} Array of container type names
 */
async function resolveContainerNames(containerPath) {
  const names = [];

  for (const container of containerPath) {
    try {
      const typeName = await getTypeName(container.typeId);
      names.push(typeName);
    } catch (error) {
      console.error(`Error resolving type name for ${container.typeId}:`, error);
      names.push('Container');
    }
  }

  return names;
}

/**
 * Resolve location information for a blueprint
 * @param {number} locationId - Blueprint's location ID
 * @param {number} characterId - Character ID who owns the blueprint
 * @param {boolean} isCorporation - Whether this is a corporation blueprint
 * @returns {Promise<Object>} Location info { systemName, stationName, containerNames, fullPath }
 */
async function resolveLocationInfo(locationId, characterId, isCorporation = false) {
  // Check cache first
  const cacheKey = getCacheKey(locationId, characterId, isCorporation);
  const cached = locationInfoCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const locationType = detectLocationType(locationId);

    // Handle NPC stations directly (no asset traversal needed)
    if (locationType === 'npc-station') {
      const stationName = await getLocationName(locationId);
      const systemName = await getSystemNameFromStation(locationId);

      const result = {
        systemName: systemName || 'Unknown System',
        stationName: stationName || 'Unknown Station',
        containerNames: [],
        fullPath: stationName || 'Unknown Station',
        locationType: 'npc-station',
      };

      // Cache the result
      locationInfoCache.set(cacheKey, result);
      return result;
    }

    // Handle system IDs
    if (locationType === 'system') {
      const systemName = await getSystemName(locationId);
      const result = {
        systemName: systemName || 'Unknown System',
        stationName: null,
        containerNames: [],
        fullPath: systemName || 'Unknown System',
        locationType: 'system',
      };

      // Cache the result
      locationInfoCache.set(cacheKey, result);
      return result;
    }

    // For assets/containers, we need to traverse the asset tree
    if (locationType === 'asset') {
      // Fetch all assets for this character
      const assets = getAssets(characterId, isCorporation);

      if (!assets || assets.length === 0) {
        const result = {
          systemName: 'Unknown',
          stationName: 'Unknown',
          containerNames: [],
          fullPath: 'Unknown',
          locationType: 'asset',
        };
        // Cache the result
        locationInfoCache.set(cacheKey, result);
        return result;
      }

      // Traverse to find ultimate location
      const ultimateLocation = findUltimateLocation(locationId, assets);

      if (!ultimateLocation) {
        const result = {
          systemName: 'Unknown',
          stationName: 'Unknown Asset',
          containerNames: [],
          fullPath: 'Unknown Asset',
          locationType: 'unknown',
        };
        // Cache the result
        locationInfoCache.set(cacheKey, result);
        return result;
      }

      // Resolve the ultimate station/structure name and system
      let stationName = null;
      let systemName = null;

      if (ultimateLocation.locationType === 'npc-station') {
        stationName = await getLocationName(ultimateLocation.locationId);
        systemName = await getSystemNameFromStation(ultimateLocation.locationId);
      } else if (ultimateLocation.locationType === 'structure') {
        // Player structures don't have names in SDE
        stationName = `Player Structure (ID: ${ultimateLocation.locationId})`;
        systemName = 'Unknown'; // Would need ESI call to get structure info
      }

      // Resolve container type names from SDE
      const containerNames = await resolveContainerNames(ultimateLocation.containerPath);

      // Build full path
      const pathParts = [stationName];
      if (containerNames.length > 0) {
        pathParts.push(...containerNames);
      }
      const fullPath = pathParts.filter((p) => p).join(' - ');

      const result = {
        systemName: systemName || 'Unknown System',
        stationName: stationName || 'Unknown',
        containerNames: containerNames,
        fullPath: fullPath,
        locationType: ultimateLocation.locationType,
      };

      // Cache the result
      locationInfoCache.set(cacheKey, result);
      return result;
    }

    // Unknown location type
    const unknownResult = {
      systemName: 'Unknown',
      stationName: 'Unknown Location',
      containerNames: [],
      fullPath: 'Unknown Location',
      locationType: 'unknown',
    };

    // Cache the result
    locationInfoCache.set(cacheKey, unknownResult);
    return unknownResult;
  } catch (error) {
    console.error('Error resolving location info:', error);
    const errorResult = {
      systemName: 'Error',
      stationName: 'Error',
      containerNames: [],
      fullPath: 'Error',
      locationType: 'error',
    };

    // Cache the error result too (to avoid repeated failures)
    locationInfoCache.set(cacheKey, errorResult);
    return errorResult;
  }
}

module.exports = {
  findUltimateLocation,
  resolveLocationInfo,
  clearLocationCache,
  clearAllLocationCache,
  getLocationCacheStats,
};
