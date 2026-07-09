const { getCharacter } = require('./settings-manager');
const { getCharacterDatabase } = require('./character-database');
const { esiFetch } = require('./esi-fetch');

/**
 * Fetch character assets from ESI
 * @param {number} characterId - Character ID
 * @returns {Promise<Object>} Assets data with metadata
 */
async function fetchCharacterAssets(characterId) {
  const callKey = `character_${characterId}_assets`;
  const url = `https://esi.evetech.net/latest/characters/${characterId}/assets/?datasource=tranquility`;

  console.log('Fetching character assets...');

  const result = await esiFetch('assets', callKey, url, {
    characterId,
    category: 'character',
    endpointLabel: 'Assets',
  });

  if (result.skipped) {
    return {
      assets: [],
      characterId,
      isCorporation: false,
      lastUpdated: Date.now(),
      cacheExpiresAt: null,
      skipped: true,
    };
  }

  const assets = result.data || [];
  console.log(`Fetched ${assets.length} character assets across ${result.pages} page(s)`);

  return {
    assets,
    characterId,
    isCorporation: false,
    lastUpdated: Date.now(),
    cacheExpiresAt: result.cacheExpiresAt,
  };
}

/**
 * Fetch corporation assets from ESI
 * @param {number} characterId - Character ID
 * @param {number} corporationId - Corporation ID
 * @returns {Promise<Object>} Assets data with metadata
 */
async function fetchCorporationAssets(characterId, corporationId) {
  const callKey = `character_${characterId}_corporation_assets`;
  const emptyResult = {
    assets: [],
    characterId,
    corporationId,
    isCorporation: true,
    lastUpdated: Date.now(),
    cacheExpiresAt: null,
  };

  // Cheap scope pre-check — avoids a guaranteed-403 network call.
  const character = getCharacter(characterId);
  if (!character) {
    throw Object.assign(new Error('Character not found'), { code: 'NOT_FOUND', characterId });
  }
  if (!character.scopes || !character.scopes.includes('esi-assets.read_corporation_assets.v1')) {
    console.log('Character does not have corporation assets scope, skipping...');
    return emptyResult;
  }

  const url = `https://esi.evetech.net/latest/corporations/${corporationId}/assets/?datasource=tranquility`;

  console.log('Fetching corporation assets...');

  try {
    const result = await esiFetch('corporation_assets', callKey, url, {
      characterId,
      corporationId,
      category: 'character',
      endpointLabel: 'Corporation Assets',
    });

    if (result.skipped) {
      return { ...emptyResult, skipped: true };
    }
    // Role-based 403 (not a director) — esiFetch returns empty silently.
    if (result.roleForbidden) {
      console.log('Character does not have permission to view corporation assets');
      return emptyResult;
    }

    const assets = result.data || [];
    console.log(`Fetched ${assets.length} corporation assets across ${result.pages} page(s)`);

    return {
      assets,
      characterId,
      corporationId,
      isCorporation: true,
      lastUpdated: Date.now(),
      cacheExpiresAt: result.cacheExpiresAt,
    };
  } catch (error) {
    // Re-throw auth errors so IPC handlers can broadcast them to renderers
    if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
      throw error;
    }
    console.error('Error fetching corporation assets:', error);
    // Don't throw - just return empty array so character assets still work
    return emptyResult;
  }
}

/**
 * Save assets to database
 * @param {Object} assetsData - Assets data from ESI
 * @returns {boolean} Success status
 */
function saveAssets(assetsData) {
  try {
    const db = getCharacterDatabase();

    // Begin transaction
    db.exec('BEGIN TRANSACTION');

    try {
      // Delete existing assets for this character/corporation
      if (assetsData.isCorporation) {
        db.prepare('DELETE FROM assets WHERE character_id = ? AND is_corporation = 1').run(assetsData.characterId);
      } else {
        db.prepare('DELETE FROM assets WHERE character_id = ? AND is_corporation = 0').run(assetsData.characterId);
      }

      // Insert new assets
      const insertAsset = db.prepare(`
        INSERT INTO assets (
          item_id, character_id, type_id, location_id, location_flag,
          location_type_id, quantity, is_singleton, is_blueprint_copy,
          is_corporation, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const asset of assetsData.assets) {
        insertAsset.run(
          String(Math.floor(asset.item_id)),
          assetsData.characterId,
          asset.type_id,
          asset.location_id,
          asset.location_flag || null,
          asset.location_type || null,
          asset.quantity,
          asset.is_singleton ? 1 : 0,
          asset.is_blueprint_copy ? 1 : 0,
          assetsData.isCorporation ? 1 : 0,
          assetsData.lastUpdated,
          assetsData.cacheExpiresAt || null
        );
      }

      db.exec('COMMIT');
      console.log(`Saved ${assetsData.assets.length} ${assetsData.isCorporation ? 'corporation' : 'character'} assets for character ${assetsData.characterId}`);

      // Clear location cache for this character since assets changed
      try {
        const { clearLocationCache } = require('./location-resolver');
        clearLocationCache(assetsData.characterId, assetsData.isCorporation);
      } catch (error) {
        console.error('Error clearing location cache:', error);
      }

      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error saving assets to database:', error);
    return false;
  }
}

/**
 * Get assets from database
 * @param {number} characterId - Character ID
 * @param {boolean} isCorporation - Whether to get corporation assets
 * @returns {Array} Assets
 */
function getAssets(characterId, isCorporation = false) {
  try {
    const db = getCharacterDatabase();

    const rows = db.prepare(`
      SELECT * FROM assets
      WHERE character_id = ? AND is_corporation = ?
      ORDER BY type_id
    `).all(characterId, isCorporation ? 1 : 0);

    return rows.map(row => ({
      itemId: row.item_id,
      characterId: row.character_id,
      typeId: row.type_id,
      locationId: row.location_id,
      locationFlag: row.location_flag,
      locationTypeId: row.location_type_id,
      quantity: row.quantity,
      isSingleton: row.is_singleton === 1,
      isBlueprintCopy: row.is_blueprint_copy === 1,
      isCorporation: row.is_corporation === 1,
      lastUpdated: row.last_updated,
      cacheExpiresAt: row.cache_expires_at,
    }));
  } catch (error) {
    console.error('Error getting assets from database:', error);
    return [];
  }
}

/**
 * Get assets cache status for a character
 * @param {number} characterId - Character ID
 * @param {boolean} isCorporation - Whether to check corporation assets
 * @returns {Object} Cache status with isCached, expiresAt, and remainingSeconds
 */
function getAssetsCacheStatus(characterId, isCorporation = false) {
  try {
    const db = getCharacterDatabase();

    const asset = db.prepare(`
      SELECT cache_expires_at
      FROM assets
      WHERE character_id = ? AND is_corporation = ? AND cache_expires_at IS NOT NULL
      LIMIT 1
    `).get(characterId, isCorporation ? 1 : 0);

    if (!asset || !asset.cache_expires_at) {
      return { isCached: false, expiresAt: null, remainingSeconds: 0 };
    }

    const now = Date.now();
    const expiresAt = asset.cache_expires_at;
    const remainingMs = expiresAt - now;
    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));

    return {
      isCached: remainingMs > 0,
      expiresAt: expiresAt,
      remainingSeconds: remainingSeconds,
    };
  } catch (error) {
    console.error('Error getting assets cache status:', error);
    return { isCached: false, expiresAt: null, remainingSeconds: 0 };
  }
}

module.exports = {
  fetchCharacterAssets,
  fetchCorporationAssets,
  saveAssets,
  getAssets,
  getAssetsCacheStatus,
};
