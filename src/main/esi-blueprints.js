const { getCharacter } = require('./settings-manager');
const { esiFetch } = require('./esi-fetch');

/**
 * Fetch corporation blueprints from ESI
 * @param {number} characterId - Character ID
 * @param {number} corporationId - Corporation ID
 * @returns {Promise<Array>} Corporation blueprints data
 */
async function fetchCorporationBlueprints(characterId, corporationId) {
  const callKey = `character_${characterId}_corporation_blueprints`;

  // Cheap scope pre-check — avoids a guaranteed-403 network call.
  const character = getCharacter(characterId);
  if (!character) {
    throw Object.assign(new Error('Character not found'), { code: 'NOT_FOUND', characterId });
  }
  if (!character.scopes || !character.scopes.includes('esi-corporations.read_blueprints.v1')) {
    console.log('Character does not have corporation blueprints scope, skipping...');
    return [];
  }

  const url = `https://esi.evetech.net/latest/corporations/${corporationId}/blueprints/?datasource=tranquility`;

  console.log('Fetching corporation blueprints...');

  try {
    const result = await esiFetch('corporation_blueprints', callKey, url, {
      characterId,
      corporationId,
      category: 'character',
      endpointLabel: 'Corporation Blueprints',
    });

    if (result.skipped) {
      return [];
    }
    // Role-based 403 (not a director) — esiFetch returns empty silently.
    if (result.roleForbidden) {
      console.log('Character does not have permission to view corporation blueprints');
      return [];
    }

    const allBlueprintsData = result.data || [];
    console.log(`Fetched ${allBlueprintsData.length} corporation blueprints across ${result.pages} page(s)`);

    // Transform blueprints data
    return allBlueprintsData.map(bp => ({
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
      characterId,
      corporationId,
      fetchedAt: Date.now(),
    }));
  } catch (error) {
    // Re-throw auth errors so IPC handlers can broadcast them to renderers
    if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
      throw error;
    }
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
  const callKey = `character_${characterId}_blueprints`;
  const url = `https://esi.evetech.net/latest/characters/${characterId}/blueprints/?datasource=tranquility`;

  console.log('Fetching character blueprints...');

  const result = await esiFetch('blueprints', callKey, url, {
    characterId,
    category: 'character',
    endpointLabel: 'Blueprints',
  });

  if (result.skipped) {
    return {
      blueprints: [],
      lastUpdated: Date.now(),
      cacheExpiresAt: null,
      characterId,
      skipped: true,
    };
  }

  const allBlueprintsData = result.data || [];
  console.log(`Fetched ${allBlueprintsData.length} character blueprints across ${result.pages} page(s)`);

  // Transform character blueprints data
  const characterBlueprints = allBlueprintsData.map(bp => ({
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
    characterId,
    fetchedAt: Date.now(),
  }));

  // Fetch corporation blueprints if character is in a corporation
  let corporationBlueprints = [];
  const character = getCharacter(characterId);
  if (character && character.corporationId) {
    console.log(`Fetching corporation blueprints for corp ${character.corporationId}...`);
    corporationBlueprints = await fetchCorporationBlueprints(characterId, character.corporationId);
    console.log(`Found ${corporationBlueprints.length} corporation blueprints`);
  }

  // Combine character and corporation blueprints
  const allBlueprints = [...characterBlueprints, ...corporationBlueprints];

  return {
    blueprints: allBlueprints,
    lastUpdated: Date.now(),
    cacheExpiresAt: result.cacheExpiresAt,
    characterId,
  };
}

module.exports = {
  fetchCharacterBlueprints,
  fetchCorporationBlueprints,
};
