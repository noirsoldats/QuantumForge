const { getCharacter } = require('./settings-manager');
const { esiFetch } = require('./esi-fetch');

/**
 * Fetch corporation division names from ESI
 * @param {number} characterId - Character ID
 * @param {number} corporationId - Corporation ID
 * @returns {Promise<Object>} Division names with metadata
 */
async function fetchCorporationDivisions(characterId, corporationId) {
  const callKey = `character_${characterId}_corporation_divisions`;
  const emptyResult = {
    hasScope: false,
    divisions: {},
    characterId,
    corporationId,
    lastUpdated: Date.now(),
    cacheExpiresAt: null,
  };

  // Cheap scope pre-check — avoids a guaranteed-403 network call.
  const character = getCharacter(characterId);
  if (!character) {
    throw Object.assign(new Error('Character not found'), { code: 'NOT_FOUND', characterId });
  }
  if (!character.scopes || !character.scopes.includes('esi-corporations.read_divisions.v1')) {
    console.log('[ESI Divisions] Character missing divisions scope, using generic names');
    return emptyResult;
  }

  const url = `https://esi.evetech.net/latest/corporations/${corporationId}/divisions/?datasource=tranquility`;

  try {
    const result = await esiFetch('corporation_divisions', callKey, url, {
      characterId,
      corporationId,
      category: 'character',
      endpointLabel: 'Corporation Divisions',
    });

    if (result.skipped) {
      return { ...emptyResult, skipped: true };
    }
    // Role-based 403 (not a director) — esiFetch returns empty silently.
    if (result.roleForbidden) {
      console.log('[ESI Divisions] Character does not have permission to view corporation divisions');
      return emptyResult;
    }

    const data = result.data || {};

    // Transform to object: { "1": "Mining", "2": "Manufacturing", ... }
    const divisionNames = {};
    if (data.hangar) {
      data.hangar.forEach(div => {
        divisionNames[div.division.toString()] = div.name;
      });
    }

    console.log(`[ESI Divisions] Fetched ${Object.keys(divisionNames).length} division names for corp ${corporationId}`);

    return {
      hasScope: true,
      divisions: divisionNames,
      characterId,
      corporationId,
      lastUpdated: Date.now(),
      cacheExpiresAt: result.cacheExpiresAt,
    };
  } catch (error) {
    // Re-throw auth errors so IPC handlers can broadcast them to renderers
    if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
      throw error;
    }
    console.error('[ESI Divisions] Error fetching corporation divisions:', error);
    // Return empty divisions on error, not an error state
    return { ...emptyResult, error: error.message };
  }
}

/**
 * Get generic division name fallback
 * @param {number} divisionId - Division ID (1-7)
 * @returns {string} Generic division name
 */
function getGenericDivisionName(divisionId) {
  const names = {
    1: 'Division 1',
    2: 'Division 2',
    3: 'Division 3',
    4: 'Division 4',
    5: 'Division 5',
    6: 'Division 6',
    7: 'Division 7',
  };
  return names[divisionId] || `Division ${divisionId}`;
}

module.exports = {
  fetchCorporationDivisions,
  getGenericDivisionName,
};
