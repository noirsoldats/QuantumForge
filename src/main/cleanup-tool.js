/**
 * Cleanup Tool - Main process logic for What Can I Build? Tool
 * Provides asset aggregation and buildability calculations
 */

const { getCharacter, getCharacterDivisionSettings } = require('./settings-manager');
const {
  isInEnabledDivision,
  divisionFromLocationFlag,
  unionDivisionsByCorp,
} = require('./corp-divisions');
const { getAssets, fetchCharacterAssets, fetchCorporationAssets, saveAssets } = require('./esi-assets');
const { getCharacterDatabase } = require('./character-database');

/**
 * Check if an asset is in an enabled corporation division
 *
 * BEHAVIOUR CHANGE: this used to include corp assets when no divisions were
 * configured, or when the location flag would not parse. That was a bug - it
 * surfaced corp holdings the user never opted into. A corp asset now counts
 * only when its division is explicitly enabled.
 *
 * @param {Object} asset - Asset object with locationFlag
 * @param {number[]} enabledDivisions - Array of enabled division IDs (1-7)
 * @returns {boolean} True if asset is in an enabled division
 */
function isAssetInEnabledDivision(asset, enabledDivisions) {
  return isInEnabledDivision(asset.locationFlag, enabledDivisions);
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

    // Corporation names are not stored locally, so resolve them from ESI in
    // one deduped, session-cached call. Characters often share a corp, so
    // this is usually far fewer requests than characters.
    const { resolveCorporationNames } = require('./esi-corporations');
    const corpNames = await resolveCorporationNames(
      characters.map(c => c.corporationId)
    );

    const sources = [];

    for (const character of characters) {
      const characterSource = {
        characterId: character.characterId,
        characterName: character.characterName,
        corporationId: character.corporationId,
        // Falls back to the bare ID: a rate-limited or deleted corporation
        // must still be identifiable.
        corporationName: corpNames[character.corporationId]
          || `Corporation ${character.corporationId}`,
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

    // Process personal assets
    if (sources.personal && sources.personal.length > 0) {
      for (const source of sources.personal) {
        const personalAssets = getAssets(source.characterId, false);
        for (const asset of personalAssets) {
          aggregatedAssets[asset.typeId] = (aggregatedAssets[asset.typeId] || 0) + asset.quantity;
        }
      }
    }

    // Process corporation assets with division filtering.
    //
    // Read each corp ONCE using the union of its characters' enabled divisions.
    // Corp assets are stored per character who can see them, so reading every
    // character double-counts; the old guard deduped by skipping the corp after
    // the first character, which silently discarded the other characters'
    // division choices.
    if (sources.corporation && sources.corporation.length > 0) {
      const corpEntries = [];
      for (const source of sources.corporation) {
        const character = getCharacter(source.characterId);
        if (!character || !character.corporationId) continue;
        corpEntries.push({
          characterId: source.characterId,
          corporationId: character.corporationId,
          divisions: source.divisions || [],
        });
      }

      for (const corp of unionDivisionsByCorp(corpEntries)) {
        const corpAssets = getAssets(corp.readerCharacterId, true);
        for (const asset of corpAssets) {
          if (isAssetInEnabledDivision(asset, corp.divisions)) {
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

/*
 * `calculateBuildableRuns` used to live here. It was never imported, never
 * wired to IPC, and computed `percentOnHand` as a weighted AVERAGE across
 * materials - so holding 100% of one material and 0% of another reported 50%
 * buildable when nothing could be built. The live figure has always come from
 * the renderer's minimum-based version, which is now in what-can-i-build.js
 * as `calculateBuildable`. Deleted rather than left as a second, wrong answer.
 */

module.exports = {
  getAssetSources,
  refreshAssets,
  aggregateAssets,
  isAssetInEnabledDivision,
  // Re-exported so this module's public surface is unchanged; the
  // implementation now lives in corp-divisions.js.
  extractDivisionId: divisionFromLocationFlag,
};
