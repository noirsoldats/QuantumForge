const { refreshAccessToken, isTokenExpired } = require('./esi-auth');
const { getCharacter, updateCharacterTokens } = require('./settings-manager');
const { getUserAgent } = require('./user-agent');
const { getCharacterDatabase } = require('./character-database');
const { recordESICallStart, recordESICallSuccess, recordESICallError } = require('./esi-status-tracker');

/**
 * Fetch character assets from ESI
 * @param {number} characterId - Character ID
 * @returns {Promise<Object>} Assets data with metadata
 */
async function fetchCharacterAssets(characterId) {
  const callKey = `character_${characterId}_assets`;

  recordESICallStart(callKey, {
    category: 'character',
    characterId: characterId,
    endpointType: 'assets',
    endpointLabel: 'Assets'
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

    // Fetch all pages of character assets from ESI
    let allAssetsData = [];
    let page = 1;
    let totalPages = 1;
    let cacheExpiresAt = null;

    do {
      console.log(`Fetching character assets page ${page} of ${totalPages}...`);

      const response = await fetch(
        `https://esi.evetech.net/latest/characters/${characterId}/assets/?datasource=tranquility&page=${page}`,
        {
          headers: {
            'Authorization': `Bearer ${character.accessToken}`,
            'User-Agent': getUserAgent(),
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        const errorMsg = `Failed to fetch assets: ${response.status} ${errorText}`;
        recordESICallError(callKey, errorMsg, response.status.toString(), startTime);
        throw new Error(errorMsg);
      }

      const assetsData = await response.json();
      allAssetsData = allAssetsData.concat(assetsData);

      // Get cache expiry from response headers (from first page)
      if (page === 1) {
        const expiresHeader = response.headers.get('expires');
        if (expiresHeader) {
          const expiresDate = new Date(expiresHeader);
          cacheExpiresAt = expiresDate.getTime();
          console.log('ESI character assets cache expires at:', expiresDate.toISOString());
        }
      }

      // Check if there are more pages
      const xPagesHeader = response.headers.get('X-Pages');
      if (xPagesHeader) {
        totalPages = parseInt(xPagesHeader, 10);
      }

      page++;
    } while (page <= totalPages);

    console.log(`Fetched ${allAssetsData.length} character assets across ${totalPages} page(s)`);

    const responseSize = JSON.stringify(allAssetsData).length;
    recordESICallSuccess(callKey, cacheExpiresAt, null, responseSize, startTime);

    return {
      assets: allAssetsData,
      characterId: characterId,
      isCorporation: false,
      lastUpdated: Date.now(),
      cacheExpiresAt: cacheExpiresAt,
    };
  } catch (error) {
    console.error('Error fetching character assets:', error);
    if (!error.message.includes('Character not found') && !error.message.includes('Failed to fetch')) {
      recordESICallError(callKey, error.message, 'NETWORK_ERROR', startTime);
    }
    throw error;
  }
}

/**
 * Fetch corporation assets from ESI
 * @param {number} characterId - Character ID
 * @param {number} corporationId - Corporation ID
 * @returns {Promise<Object>} Assets data with metadata
 */
async function fetchCorporationAssets(characterId, corporationId) {
  const callKey = `character_${characterId}_corporation_assets`;

  recordESICallStart(callKey, {
    category: 'character',
    characterId: characterId,
    endpointType: 'corporation_assets',
    endpointLabel: 'Corporation Assets'
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
    if (!character.scopes || !character.scopes.includes('esi-assets.read_corporation_assets.v1')) {
      console.log('Character does not have corporation assets scope, skipping...');
      recordESICallSuccess(callKey, null, null, 0, startTime);
      return {
        assets: [],
        characterId: characterId,
        corporationId: corporationId,
        isCorporation: true,
        lastUpdated: Date.now(),
        cacheExpiresAt: null,
      };
    }

    // Fetch all pages of corporation assets from ESI
    let allAssetsData = [];
    let page = 1;
    let totalPages = 1;
    let cacheExpiresAt = null;

    do {
      console.log(`Fetching corporation assets page ${page} of ${totalPages}...`);

      const response = await fetch(
        `https://esi.evetech.net/latest/corporations/${corporationId}/assets/?datasource=tranquility&page=${page}`,
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
          console.log('Character does not have permission to view corporation assets');
          recordESICallSuccess(callKey, null, null, 0, startTime);
          return {
            assets: [],
            characterId: characterId,
            corporationId: corporationId,
            isCorporation: true,
            lastUpdated: Date.now(),
            cacheExpiresAt: null,
          };
        }
        const errorText = await response.text();
        const errorMsg = `Failed to fetch corporation assets: ${response.status} ${errorText}`;
        recordESICallError(callKey, errorMsg, response.status.toString(), startTime);
        throw new Error(errorMsg);
      }

      const assetsData = await response.json();
      allAssetsData = allAssetsData.concat(assetsData);

      // Get cache expiry from response headers (from first page)
      if (page === 1) {
        const expiresHeader = response.headers.get('expires');
        if (expiresHeader) {
          const expiresDate = new Date(expiresHeader);
          cacheExpiresAt = expiresDate.getTime();
          console.log('ESI corporation assets cache expires at:', expiresDate.toISOString());
        }
      }

      // Check if there are more pages
      const xPagesHeader = response.headers.get('X-Pages');
      if (xPagesHeader) {
        totalPages = parseInt(xPagesHeader, 10);
      }

      page++;
    } while (page <= totalPages);

    console.log(`Fetched ${allAssetsData.length} corporation assets across ${totalPages} page(s)`);

    const responseSize = JSON.stringify(allAssetsData).length;
    recordESICallSuccess(callKey, cacheExpiresAt, null, responseSize, startTime);

    return {
      assets: allAssetsData,
      characterId: characterId,
      corporationId: corporationId,
      isCorporation: true,
      lastUpdated: Date.now(),
      cacheExpiresAt: cacheExpiresAt,
    };
  } catch (error) {
    console.error('Error fetching corporation assets:', error);
    if (!error.message.includes('Character not found') && !error.message.includes('Failed to fetch')) {
      recordESICallError(callKey, error.message, 'NETWORK_ERROR', startTime);
    }
    // Don't throw - just return empty array so character assets still work
    return {
      assets: [],
      characterId: characterId,
      corporationId: corporationId,
      isCorporation: true,
      lastUpdated: Date.now(),
      cacheExpiresAt: null,
    };
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
