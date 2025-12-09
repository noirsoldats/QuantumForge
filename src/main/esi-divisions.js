const { refreshAccessToken, isTokenExpired } = require('./esi-auth');
const { getCharacter, updateCharacterTokens } = require('./settings-manager');
const { getUserAgent } = require('./user-agent');

/**
 * Fetch corporation division names from ESI
 * @param {number} characterId - Character ID
 * @param {number} corporationId - Corporation ID
 * @returns {Promise<Object>} Division names with metadata
 */
async function fetchCorporationDivisions(characterId, corporationId) {
  try {
    let character = getCharacter(characterId);

    if (!character) {
      throw new Error('Character not found');
    }

    // Check if token is expired and refresh if needed
    if (isTokenExpired(character.expiresAt)) {
      console.log('[ESI Divisions] Token expired, refreshing...');
      const newTokens = await refreshAccessToken(character.refreshToken);
      updateCharacterTokens(characterId, newTokens);
      character = getCharacter(characterId);
    }

    // Check if character has the required scope
    const hasScope = character.scopes &&
                    character.scopes.includes('esi-corporations.read_divisions.v1');

    if (!hasScope) {
      console.log('[ESI Divisions] Character missing divisions scope, using generic names');
      return {
        hasScope: false,
        divisions: {},
        characterId: characterId,
        corporationId: corporationId,
        lastUpdated: Date.now(),
        cacheExpiresAt: null,
      };
    }

    // Fetch corporation divisions from ESI
    const response = await fetch(
      `https://esi.evetech.net/latest/corporations/${corporationId}/divisions/?datasource=tranquility`,
      {
        headers: {
          'Authorization': `Bearer ${character.accessToken}`,
          'User-Agent': getUserAgent(),
        },
      }
    );

    if (!response.ok) {
      // If we get a 403, the character doesn't have permission
      if (response.status === 403) {
        console.log('[ESI Divisions] Character does not have permission to view corporation divisions');
        return {
          hasScope: false,
          divisions: {},
          characterId: characterId,
          corporationId: corporationId,
          lastUpdated: Date.now(),
          cacheExpiresAt: null,
        };
      }

      const errorText = await response.text();
      throw new Error(`Failed to fetch corporation divisions: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    // Get cache expiry from response headers
    let cacheExpiresAt = null;
    const expiresHeader = response.headers.get('expires');
    if (expiresHeader) {
      const expiresDate = new Date(expiresHeader);
      cacheExpiresAt = expiresDate.getTime();
      console.log('[ESI Divisions] Cache expires at:', expiresDate.toISOString());
    }

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
      characterId: characterId,
      corporationId: corporationId,
      lastUpdated: Date.now(),
      cacheExpiresAt: cacheExpiresAt,
    };
  } catch (error) {
    console.error('[ESI Divisions] Error fetching corporation divisions:', error);
    // Return empty divisions on error, not an error state
    return {
      hasScope: false,
      divisions: {},
      characterId: characterId,
      corporationId: corporationId,
      lastUpdated: Date.now(),
      cacheExpiresAt: null,
      error: error.message,
    };
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
