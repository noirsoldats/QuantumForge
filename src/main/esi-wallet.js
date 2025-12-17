const { refreshAccessToken, isTokenExpired } = require('./esi-auth');
const { getCharacter, updateCharacterTokens } = require('./settings-manager');
const { getUserAgent } = require('./user-agent');
const { getCharacterDatabase } = require('./character-database');
const { recordESICallStart, recordESICallSuccess, recordESICallError } = require('./esi-status-tracker');

/**
 * Fetch character wallet transactions from ESI
 * @param {number} characterId - Character ID
 * @param {number} fromId - Optional transaction ID to fetch from (for incremental fetching)
 * @returns {Promise<Object>} Wallet transactions data with metadata
 */
async function fetchCharacterWalletTransactions(characterId, fromId = null) {
  const callKey = `character_${characterId}_wallet_transactions`;

  recordESICallStart(callKey, {
    category: 'character',
    characterId: characterId,
    endpointType: 'wallet_transactions',
    endpointLabel: 'Wallet Transactions'
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

    // Fetch wallet transactions from ESI
    let allTransactionsData = [];
    let cacheExpiresAt = null;

    const fromIdParam = fromId ? `from_id=${fromId}` : '';
    const url = `https://esi.evetech.net/latest/characters/${characterId}/wallet/transactions/?datasource=tranquility${fromIdParam ? '&' + fromIdParam : ''}`;

    console.log(`Fetching character wallet transactions${fromId ? ` from ID ${fromId}` : ''}...`);

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${character.accessToken}`,
        'User-Agent': getUserAgent(),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errorMsg = `Failed to fetch wallet transactions: ${response.status} ${errorText}`;
      recordESICallError(callKey, errorMsg, response.status.toString(), startTime);
      throw new Error(errorMsg);
    }

    const transactionsData = await response.json();
    allTransactionsData = transactionsData;

    // Get cache expiry from response headers
    const expiresHeader = response.headers.get('expires');
    if (expiresHeader) {
      const expiresDate = new Date(expiresHeader);
      cacheExpiresAt = expiresDate.getTime();
      console.log('ESI wallet transactions cache expires at:', expiresDate.toISOString());
    }

    console.log(`Fetched ${allTransactionsData.length} wallet transactions`);

    const responseSize = JSON.stringify(allTransactionsData).length;
    recordESICallSuccess(callKey, cacheExpiresAt, null, responseSize, startTime);

    return {
      transactions: allTransactionsData,
      characterId: characterId,
      lastUpdated: Date.now(),
      cacheExpiresAt: cacheExpiresAt,
    };
  } catch (error) {
    console.error('Error fetching character wallet transactions:', error);
    if (!error.message.includes('Character not found') && !error.message.includes('Failed to fetch')) {
      recordESICallError(callKey, error.message, 'NETWORK_ERROR', startTime);
    }
    throw error;
  }
}

/**
 * Save wallet transactions to database
 * @param {Object} transactionsData - Transactions data from ESI
 * @returns {boolean} Success status
 */
function saveWalletTransactions(transactionsData) {
  try {
    const db = getCharacterDatabase();

    // Begin transaction
    db.exec('BEGIN TRANSACTION');

    try {
      // Use INSERT OR REPLACE to handle incremental updates
      const insertTransaction = db.prepare(`
        INSERT OR REPLACE INTO esi_wallet_transactions (
          transaction_id, character_id, date, type_id, quantity,
          unit_price, location_id, is_buy, is_personal,
          last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const transaction of transactionsData.transactions) {
        // Convert date string to Unix timestamp (milliseconds)
        const transactionDate = new Date(transaction.date).getTime();

        insertTransaction.run(
          transaction.transaction_id,
          transactionsData.characterId,
          transactionDate,
          transaction.type_id,
          transaction.quantity,
          transaction.unit_price,
          transaction.location_id,
          transaction.is_buy ? 1 : 0,
          transaction.is_personal ? 1 : 0,
          transactionsData.lastUpdated,
          transactionsData.cacheExpiresAt || null
        );
      }

      db.exec('COMMIT');
      console.log(`Saved ${transactionsData.transactions.length} wallet transactions for character ${transactionsData.characterId}`);

      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error saving wallet transactions to database:', error);
    return false;
  }
}

/**
 * Get wallet transactions from database
 * @param {number} characterId - Character ID
 * @param {Object} filters - Optional filters (typeId, isBuy, isPersonal, startDate, endDate)
 * @returns {Array} Wallet transactions
 */
function getWalletTransactions(characterId, filters = {}) {
  try {
    const db = getCharacterDatabase();

    let query = 'SELECT * FROM esi_wallet_transactions WHERE character_id = ?';
    const params = [characterId];

    // Apply filters
    if (filters.typeId) {
      query += ' AND type_id = ?';
      params.push(filters.typeId);
    }

    if (filters.isBuy !== undefined) {
      query += ' AND is_buy = ?';
      params.push(filters.isBuy ? 1 : 0);
    }

    if (filters.isPersonal !== undefined) {
      query += ' AND is_personal = ?';
      params.push(filters.isPersonal ? 1 : 0);
    }

    if (filters.startDate) {
      query += ' AND date >= ?';
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      query += ' AND date <= ?';
      params.push(filters.endDate);
    }

    query += ' ORDER BY date DESC';

    const rows = db.prepare(query).all(...params);

    return rows.map(row => ({
      transactionId: row.transaction_id,
      characterId: row.character_id,
      date: row.date,
      typeId: row.type_id,
      quantity: row.quantity,
      unitPrice: row.unit_price,
      locationId: row.location_id,
      isBuy: row.is_buy === 1,
      isPersonal: row.is_personal === 1,
      lastUpdated: row.last_updated,
      cacheExpiresAt: row.cache_expires_at,
    }));
  } catch (error) {
    console.error('Error getting wallet transactions from database:', error);
    return [];
  }
}

/**
 * Get wallet transactions cache status for a character
 * @param {number} characterId - Character ID
 * @returns {Object} Cache status with isCached, expiresAt, remainingSeconds, and latestTransactionId
 */
function getWalletTransactionsCacheStatus(characterId) {
  try {
    const db = getCharacterDatabase();

    const result = db.prepare(`
      SELECT cache_expires_at, transaction_id
      FROM esi_wallet_transactions
      WHERE character_id = ? AND cache_expires_at IS NOT NULL
      ORDER BY transaction_id DESC
      LIMIT 1
    `).get(characterId);

    if (!result || !result.cache_expires_at) {
      return {
        isCached: false,
        expiresAt: null,
        remainingSeconds: 0,
        latestTransactionId: null,
      };
    }

    const now = Date.now();
    const expiresAt = result.cache_expires_at;
    const remainingMs = expiresAt - now;
    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));

    return {
      isCached: remainingMs > 0,
      expiresAt: expiresAt,
      remainingSeconds: remainingSeconds,
      latestTransactionId: result.transaction_id,
    };
  } catch (error) {
    console.error('Error getting wallet transactions cache status:', error);
    return {
      isCached: false,
      expiresAt: null,
      remainingSeconds: 0,
      latestTransactionId: null,
    };
  }
}

module.exports = {
  fetchCharacterWalletTransactions,
  saveWalletTransactions,
  getWalletTransactions,
  getWalletTransactionsCacheStatus,
};
