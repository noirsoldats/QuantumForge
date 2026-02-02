/**
 * Cleanup Tool - Main process logic for What Can I Build? Tool
 * Provides asset aggregation and buildability calculations
 */

const { getCharacter, getCharacterDivisionSettings } = require('./settings-manager');
const { getAssets, fetchCharacterAssets, fetchCorporationAssets, saveAssets } = require('./esi-assets');
const { getCharacterDatabase } = require('./character-database');

/**
 * Extract division ID from location flag
 * @param {string} locationFlag - Location flag (e.g., "CorpSAG2")
 * @returns {number|null} Division ID (1-7) or null
 */
function extractDivisionId(locationFlag) {
  if (!locationFlag) return null;

  const match = locationFlag.match(/CorpSAG(\d)/);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }

  return null;
}

/**
 * Check if an asset is in an enabled corporation division
 * @param {Object} asset - Asset object with locationFlag
 * @param {number[]} enabledDivisions - Array of enabled division IDs (1-7)
 * @returns {boolean} True if asset is in an enabled division
 */
function isAssetInEnabledDivision(asset, enabledDivisions) {
  // If no divisions are enabled, include all corp assets (backward compatibility)
  if (!enabledDivisions || enabledDivisions.length === 0) {
    return true;
  }

  const locationFlag = asset.locationFlag;
  if (!locationFlag || !locationFlag.startsWith('CorpSAG')) {
    // Asset is not in a corporation hangar division - include it
    return true;
  }

  const divisionId = extractDivisionId(locationFlag);
  if (divisionId === null) {
    return true; // Can't parse, include to be safe
  }

  return enabledDivisions.includes(divisionId);
}

/**
 * Get available asset sources for the cleanup tool
 * Returns a structure describing all characters and their available asset sources
 * @returns {Promise<Array>} Array of asset source descriptors
 */
async function getAssetSources() {
  try {
    const { getCharacters } = require('./settings-manager');
    const characters = getCharacters();

    if (!characters || characters.length === 0) {
      return [];
    }

    const sources = [];

    for (const character of characters) {
      const characterSource = {
        characterId: character.characterId,
        characterName: character.characterName,
        corporationId: character.corporationId,
        corporationName: character.corporationName || `Corporation ${character.corporationId}`,
        portrait: character.portrait,
        hasPersonalAssets: true,
        hasCorpAssets: false,
        divisions: [],
      };

      // Check if character has corporation assets scope
      if (character.scopes && character.scopes.includes('esi-assets.read_corporation_assets.v1')) {
        characterSource.hasCorpAssets = true;

        // Get division settings for this character
        const divisionSettings = getCharacterDivisionSettings(character.characterId);

        // Get division names (1-7)
        for (let i = 1; i <= 7; i++) {
          const divisionName = divisionSettings.divisionNames?.[i] || `Division ${i}`;
          characterSource.divisions.push({
            id: i,
            name: divisionName,
            enabled: divisionSettings.enabledDivisions?.includes(i) || false,
          });
        }
      }

      sources.push(characterSource);
    }

    return sources;
  } catch (error) {
    console.error('[Cleanup Tool] Error getting asset sources:', error);
    return [];
  }
}

/**
 * Refresh assets from ESI for specified characters
 * @param {number[]} characterIds - Array of character IDs to refresh
 * @returns {Promise<Object>} Result with success status and details
 */
async function refreshAssets(characterIds) {
  const results = {
    success: true,
    refreshed: [],
    errors: [],
  };

  for (const characterId of characterIds) {
    try {
      const character = getCharacter(characterId);
      if (!character) {
        results.errors.push({ characterId, error: 'Character not found' });
        continue;
      }

      // Fetch personal assets
      const personalAssets = await fetchCharacterAssets(characterId);
      saveAssets(personalAssets);
      results.refreshed.push({
        characterId,
        characterName: character.characterName,
        type: 'personal',
        count: personalAssets.assets.length,
      });

      // Fetch corporation assets if available
      if (character.corporationId &&
          character.scopes?.includes('esi-assets.read_corporation_assets.v1')) {
        const corpAssets = await fetchCorporationAssets(characterId, character.corporationId);
        if (corpAssets.assets.length > 0) {
          saveAssets(corpAssets);
          results.refreshed.push({
            characterId,
            characterName: character.characterName,
            type: 'corporation',
            count: corpAssets.assets.length,
          });
        }
      }
    } catch (error) {
      console.error(`[Cleanup Tool] Error refreshing assets for character ${characterId}:`, error);
      results.errors.push({ characterId, error: error.message });
    }
  }

  results.success = results.errors.length === 0;
  return results;
}

/**
 * Aggregate assets from selected sources
 * @param {Object} sources - Source selection configuration
 * @param {Array} sources.personal - Array of { characterId } for personal assets
 * @param {Array} sources.corporation - Array of { characterId, divisions } for corp assets
 * @returns {Object} Aggregated assets map { typeId: quantity }
 */
function aggregateAssets(sources) {
  try {
    const aggregatedAssets = {}; // { typeId: totalQuantity }
    const processedCorps = new Set(); // Track corporations to avoid double-counting

    // Process personal assets
    if (sources.personal && sources.personal.length > 0) {
      for (const source of sources.personal) {
        const personalAssets = getAssets(source.characterId, false);
        for (const asset of personalAssets) {
          aggregatedAssets[asset.typeId] = (aggregatedAssets[asset.typeId] || 0) + asset.quantity;
        }
      }
    }

    // Process corporation assets with division filtering
    if (sources.corporation && sources.corporation.length > 0) {
      for (const source of sources.corporation) {
        const character = getCharacter(source.characterId);
        if (!character) continue;

        const corpId = character.corporationId;
        if (!corpId || processedCorps.has(corpId)) continue;

        processedCorps.add(corpId);

        const corpAssets = getAssets(source.characterId, true);
        const enabledDivisions = source.divisions || [];

        for (const asset of corpAssets) {
          if (isAssetInEnabledDivision(asset, enabledDivisions)) {
            aggregatedAssets[asset.typeId] = (aggregatedAssets[asset.typeId] || 0) + asset.quantity;
          }
        }
      }
    }

    return aggregatedAssets;
  } catch (error) {
    console.error('[Cleanup Tool] Error aggregating assets:', error);
    return {};
  }
}

/**
 * Calculate buildable runs and on-hand percentage for a blueprint
 * @param {Object} params - Calculation parameters
 * @param {number} params.blueprintTypeId - Blueprint type ID
 * @param {Object} params.materials - Materials required per run { typeId: quantity }
 * @param {Object} params.assets - Available assets { typeId: quantity }
 * @returns {Object} Result with buildableRuns and percentOnHand
 */
function calculateBuildableRuns(params) {
  const { materials, assets } = params;

  if (!materials || Object.keys(materials).length === 0) {
    return { buildableRuns: 0, percentOnHand: 0, materialBreakdown: [] };
  }

  let minRuns = Infinity;
  let totalRequired = 0;
  let totalAvailable = 0;
  const materialBreakdown = [];

  for (const [typeId, quantityPerRun] of Object.entries(materials)) {
    const typeIdNum = parseInt(typeId, 10);
    const available = assets[typeIdNum] || 0;
    const runsFromMaterial = Math.floor(available / quantityPerRun);

    minRuns = Math.min(minRuns, runsFromMaterial);
    totalRequired += quantityPerRun;
    totalAvailable += Math.min(available, quantityPerRun); // Cap at what's needed per run

    materialBreakdown.push({
      typeId: typeIdNum,
      required: quantityPerRun,
      available: available,
      runsSupported: runsFromMaterial,
    });
  }

  const buildableRuns = minRuns === Infinity ? 0 : minRuns;
  const percentOnHand = totalRequired > 0 ? (totalAvailable / totalRequired) * 100 : 0;

  return {
    buildableRuns,
    percentOnHand: Math.min(100, percentOnHand), // Cap at 100%
    materialBreakdown,
  };
}

module.exports = {
  getAssetSources,
  refreshAssets,
  aggregateAssets,
  calculateBuildableRuns,
  isAssetInEnabledDivision,
  extractDivisionId,
};
