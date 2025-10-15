const { refreshAccessToken, isTokenExpired } = require('./esi-auth');
const { getCharacter, updateCharacterTokens } = require('./settings-manager');

/**
 * Fetch corporation blueprints from ESI
 * @param {number} characterId - Character ID
 * @param {number} corporationId - Corporation ID
 * @returns {Promise<Array>} Corporation blueprints data
 */
async function fetchCorporationBlueprints(characterId, corporationId) {
  try {
    let character = getCharacter(characterId);

    if (!character) {
      throw new Error('Character not found');
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
      return [];
    }

    // Fetch corporation blueprints from ESI
    const response = await fetch(
      `https://esi.evetech.net/latest/corporations/${corporationId}/blueprints/?datasource=tranquility`,
      {
        headers: {
          'Authorization': `Bearer ${character.accessToken}`,
          'User-Agent': 'Quantum Forge Industry Tool',
        },
      }
    );

    if (!response.ok) {
      // If we get a 403, the character doesn't have permission
      if (response.status === 403) {
        console.log('Character does not have permission to view corporation blueprints');
        return [];
      }
      const errorText = await response.text();
      throw new Error(`Failed to fetch corporation blueprints: ${response.status} ${errorText}`);
    }

    const blueprintsData = await response.json();

    // Transform blueprints data
    const blueprints = blueprintsData.map(bp => {
      return {
        itemId: bp.item_id,
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

    return blueprints;
  } catch (error) {
    console.error('Error fetching corporation blueprints:', error);
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
  try {
    let character = getCharacter(characterId);

    if (!character) {
      throw new Error('Character not found');
    }

    // Check if token is expired and refresh if needed
    if (isTokenExpired(character.expiresAt)) {
      console.log('Token expired, refreshing...');
      const newTokens = await refreshAccessToken(character.refreshToken);
      updateCharacterTokens(characterId, newTokens);
      character = getCharacter(characterId);
    }

    // Fetch character blueprints from ESI
    const response = await fetch(
      `https://esi.evetech.net/latest/characters/${characterId}/blueprints/?datasource=tranquility`,
      {
        headers: {
          'Authorization': `Bearer ${character.accessToken}`,
          'User-Agent': 'Quantum Forge Industry Tool',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch blueprints: ${response.status} ${errorText}`);
    }

    const blueprintsData = await response.json();

    // Get cache expiry from response headers
    const expiresHeader = response.headers.get('expires');
    let cacheExpiresAt = null;

    if (expiresHeader) {
      const expiresDate = new Date(expiresHeader);
      cacheExpiresAt = expiresDate.getTime();
      console.log('ESI character blueprints cache expires at:', expiresDate.toISOString());
    }

    // Transform character blueprints data
    const characterBlueprints = blueprintsData.map(bp => {
      return {
        itemId: bp.item_id,
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

    return {
      blueprints: allBlueprints,
      lastUpdated: Date.now(),
      cacheExpiresAt: cacheExpiresAt,
      characterId: characterId,
    };
  } catch (error) {
    console.error('Error fetching character blueprints:', error);
    throw error;
  }
}

module.exports = {
  fetchCharacterBlueprints,
};
