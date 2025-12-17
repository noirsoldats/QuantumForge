const { refreshAccessToken, isTokenExpired } = require('./esi-auth');
const { getCharacter, updateCharacterTokens } = require('./settings-manager');
const { getUserAgent } = require('./user-agent');
const { recordESICallStart, recordESICallSuccess, recordESICallError } = require('./esi-status-tracker');

/**
 * Fetch corporation blueprints from ESI
 * @param {number} characterId - Character ID
 * @param {number} corporationId - Corporation ID
 * @returns {Promise<Array>} Corporation blueprints data
 */
async function fetchCorporationBlueprints(characterId, corporationId) {
  const callKey = `character_${characterId}_corporation_blueprints`;

  // Record call start
  recordESICallStart(callKey, {
    category: 'character',
    characterId: characterId,
    endpointType: 'corporation_blueprints',
    endpointLabel: 'Corporation Blueprints'
  });

  const startTime = Date.now();

  try {
    let character = getCharacter(characterId);

    if (!character) {
      const errorMsg = 'Character not found';
      recordESICallError(callKey, errorMsg, 'NOT_FOUND', startTime);
      throw new Error(errorMsg);
    }

    // Check if token is expired and refresh if needed
    if (isTokenExpired(character.expiresAt)) {
      console.log('Token expired, refreshing...');
      const newTokens = await refreshAccessToken(character.refreshToken);
      updateCharacterTokens(characterId, newTokens);
      character = getCharacter(characterId);
    }

    // Check if character has the required scope
    if (!character.scopes || !character.scopes.includes('esi-corporations.read_blueprints.v1')) {
      console.log('Character does not have corporation blueprints scope, skipping...');
      recordESICallSuccess(callKey, null, null, 0, startTime);
      return [];
    }

    // Fetch all pages of corporation blueprints from ESI
    let allBlueprintsData = [];
    let page = 1;
    let totalPages = 1;

    do {
      console.log(`Fetching corporation blueprints page ${page} of ${totalPages}...`);

      const response = await fetch(
        `https://esi.evetech.net/latest/corporations/${corporationId}/blueprints/?datasource=tranquility&page=${page}`,
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
          console.log('Character does not have permission to view corporation blueprints');
          recordESICallSuccess(callKey, null, null, 0, startTime);
          return [];
        }
        const errorText = await response.text();
        const errorMsg = `Failed to fetch corporation blueprints: ${response.status} ${errorText}`;
        recordESICallError(callKey, errorMsg, response.status.toString(), startTime);
        throw new Error(errorMsg);
      }

      const blueprintsData = await response.json();
      allBlueprintsData = allBlueprintsData.concat(blueprintsData);

      // Check if there are more pages
      const xPagesHeader = response.headers.get('X-Pages');
      if (xPagesHeader) {
        totalPages = parseInt(xPagesHeader, 10);
      }

      page++;
    } while (page <= totalPages);

    console.log(`Fetched ${allBlueprintsData.length} corporation blueprints across ${totalPages} page(s)`);

    // Transform blueprints data
    const blueprints = allBlueprintsData.map(bp => {
      return {
        itemId: String(Math.floor(bp.item_id)),
        typeId: bp.type_id,
        locationId: bp.location_id,
        locationFlag: bp.location_flag,
        quantity: bp.quantity,
        timeEfficiency: bp.time_efficiency,
        materialEfficiency: bp.material_efficiency,
        runs: bp.runs,
        isCopy: bp.quantity === -2,
        isCorporation: true, // Always true for corporation blueprints
        source: 'esi',
        characterId: characterId,
        corporationId: corporationId,
        fetchedAt: Date.now(),
      };
    });

    // Record success
    const responseSize = JSON.stringify(allBlueprintsData).length;
    recordESICallSuccess(callKey, null, null, responseSize, startTime);

    return blueprints;
  } catch (error) {
    console.error('Error fetching corporation blueprints:', error);
    if (!error.message.includes('Character not found') && !error.message.includes('Failed to fetch')) {
      recordESICallError(callKey, error.message, 'NETWORK_ERROR', startTime);
    }
    // Don't throw - just return empty array so character blueprints still work
    return [];
  }
}

/**
 * Fetch character blueprints from ESI
 * @param {number} characterId - Character ID
 * @returns {Promise<Array>} Blueprints data
 */
async function fetchCharacterBlueprints(characterId) {
  const callKey = `character_${characterId}_blueprints`;

  // Record call start
  recordESICallStart(callKey, {
    category: 'character',
    characterId: characterId,
    endpointType: 'blueprints',
    endpointLabel: 'Blueprints'
  });

  const startTime = Date.now();

  try {
    let character = getCharacter(characterId);

    if (!character) {
      const errorMsg = 'Character not found';
      recordESICallError(callKey, errorMsg, 'NOT_FOUND', startTime);
      throw new Error(errorMsg);
    }

    // Check if token is expired and refresh if needed
    if (isTokenExpired(character.expiresAt)) {
      console.log('Token expired, refreshing...');
      const newTokens = await refreshAccessToken(character.refreshToken);
      updateCharacterTokens(characterId, newTokens);
      character = getCharacter(characterId);
    }

    // Fetch all pages of character blueprints from ESI
    let allBlueprintsData = [];
    let page = 1;
    let totalPages = 1;
    let cacheExpiresAt = null;

    do {
      console.log(`Fetching character blueprints page ${page} of ${totalPages}...`);

      const response = await fetch(
        `https://esi.evetech.net/latest/characters/${characterId}/blueprints/?datasource=tranquility&page=${page}`,
        {
          headers: {
            'Authorization': `Bearer ${character.accessToken}`,
            'User-Agent': getUserAgent(),
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        const errorMsg = `Failed to fetch blueprints: ${response.status} ${errorText}`;
        recordESICallError(callKey, errorMsg, response.status.toString(), startTime);
        throw new Error(errorMsg);
      }

      const blueprintsData = await response.json();
      allBlueprintsData = allBlueprintsData.concat(blueprintsData);

      // Get cache expiry from response headers (from first page)
      if (page === 1) {
        const expiresHeader = response.headers.get('expires');
        if (expiresHeader) {
          const expiresDate = new Date(expiresHeader);
          cacheExpiresAt = expiresDate.getTime();
          console.log('ESI character blueprints cache expires at:', expiresDate.toISOString());
        }
      }

      // Check if there are more pages
      const xPagesHeader = response.headers.get('X-Pages');
      if (xPagesHeader) {
        totalPages = parseInt(xPagesHeader, 10);
      }

      page++;
    } while (page <= totalPages);

    console.log(`Fetched ${allBlueprintsData.length} character blueprints across ${totalPages} page(s)`);

    // Transform character blueprints data
    const characterBlueprints = allBlueprintsData.map(bp => {
      return {
        itemId: String(Math.floor(bp.item_id)),
        typeId: bp.type_id,
        locationId: bp.location_id,
        locationFlag: bp.location_flag,
        quantity: bp.quantity,
        timeEfficiency: bp.time_efficiency,
        materialEfficiency: bp.material_efficiency,
        runs: bp.runs,
        isCopy: bp.quantity === -2,
        isCorporation: false, // Character blueprints are not corporation blueprints
        source: 'esi',
        characterId: characterId,
        fetchedAt: Date.now(),
      };
    });

    // Fetch corporation blueprints if character is in a corporation
    let corporationBlueprints = [];
    if (character.corporationId) {
      console.log(`Fetching corporation blueprints for corp ${character.corporationId}...`);
      corporationBlueprints = await fetchCorporationBlueprints(characterId, character.corporationId);
      console.log(`Found ${corporationBlueprints.length} corporation blueprints`);
    }

    // Combine character and corporation blueprints
    const allBlueprints = [...characterBlueprints, ...corporationBlueprints];

    // Record success
    const responseSize = JSON.stringify(allBlueprintsData).length;
    recordESICallSuccess(callKey, cacheExpiresAt, null, responseSize, startTime);

    return {
      blueprints: allBlueprints,
      lastUpdated: Date.now(),
      cacheExpiresAt: cacheExpiresAt,
      characterId: characterId,
    };
  } catch (error) {
    console.error('Error fetching character blueprints:', error);
    if (!error.message.includes('Character not found') && !error.message.includes('Failed to fetch')) {
      recordESICallError(callKey, error.message, 'NETWORK_ERROR', startTime);
    }
    throw error;
  }
}

module.exports = {
  fetchCharacterBlueprints,
};
