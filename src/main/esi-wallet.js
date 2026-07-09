const { getCharacterDatabase } = require('./character-database');
const { getCharacter } = require('./settings-manager');
const { esiFetch } = require('./esi-fetch');

const CORP_WALLET_SCOPE = 'esi-wallet.read_corporation_wallets.v1';

/**
 * Fetch character wallet transactions from ESI
 * @param {number} characterId - Character ID
 * @param {number} fromId - Optional transaction ID to fetch from (for incremental fetching)
 * @returns {Promise<Object>} Wallet transactions data with metadata
 */
async function fetchCharacterWalletTransactions(characterId, fromId = null) {
  const callKey = `character_${characterId}_wallet_transactions`;

  const fromIdParam = fromId ? `from_id=${fromId}` : '';
  const url = `https://esi.evetech.net/latest/characters/${characterId}/wallet/transactions/?datasource=tranquility${fromIdParam ? '&' + fromIdParam : ''}`;

  console.log(`Fetching character wallet transactions${fromId ? ` from ID ${fromId}` : ''}...`);

  const result = await esiFetch('wallet_transactions', callKey, url, {
    characterId,
    category: 'character',
    endpointLabel: 'Wallet Transactions',
  });

  if (result.skipped) {
    return {
      transactions: [],
      characterId,
      lastUpdated: Date.now(),
      cacheExpiresAt: null,
      skipped: true,
    };
  }

  const transactions = result.data || [];
  console.log(`Fetched ${transactions.length} wallet transactions`);

  return {
    transactions,
    characterId,
    lastUpdated: Date.now(),
    cacheExpiresAt: result.cacheExpiresAt,
  };
}

/**
 * Fetch corporation wallet transactions from ESI (per division).
 * Routes through esiFetch (endpoint type corporation_wallet_transactions).
 * Requires esi-wallet.read_corporation_wallets.v1 scope + accountant/director role.
 * @param {number} characterId - Authenticating character
 * @param {number} corporationId - Corporation ID
 * @param {number} division - Wallet division (1-7)
 * @returns {Promise<Object>} Transactions data with metadata
 */
async function fetchCorporationWalletTransactions(characterId, corporationId, division) {
  const callKey = `corporation_${corporationId}_${division}_wallet_transactions`;
  const emptyResult = {
    transactions: [], characterId, corporationId, division,
    isCorporation: true, lastUpdated: Date.now(), cacheExpiresAt: null,
  };

  // Cheap scope pre-check — avoids a guaranteed-403 network call.
  const character = getCharacter(characterId);
  if (!character) {
    throw Object.assign(new Error('Character not found'), { code: 'NOT_FOUND', characterId });
  }
  if (!character.scopes || !character.scopes.includes(CORP_WALLET_SCOPE)) {
    console.log('Character does not have corporation wallet scope, skipping...');
    return emptyResult;
  }

  const url = `https://esi.evetech.net/latest/corporations/${corporationId}/wallets/${division}/transactions/?datasource=tranquility`;

  console.log(`Fetching corporation ${corporationId} division ${division} wallet transactions...`);

  try {
    const result = await esiFetch('corporation_wallet_transactions', callKey, url, {
      characterId,
      corporationId,
      category: 'corporation',
      endpointLabel: `Corporation Wallet Transactions (Div ${division})`,
    });

    if (result.skipped) return { ...emptyResult, skipped: true };
    if (result.roleForbidden) {
      console.log('Character does not have permission to view corporation wallet (requires accountant/director role)');
      return emptyResult;
    }

    const transactions = result.data || [];
    console.log(`Fetched ${transactions.length} corp wallet transactions (div ${division}) across ${result.pages} page(s)`);

    return {
      transactions, characterId, corporationId, division,
      isCorporation: true, lastUpdated: Date.now(), cacheExpiresAt: result.cacheExpiresAt,
    };
  } catch (error) {
    if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
      throw error;
    }
    console.error('Error fetching corporation wallet transactions:', error);
    return emptyResult;
  }
}

/**
 * Save wallet transactions to database (character or corporation).
 * Durable-log upsert on the composite key (transaction_id, character_id,
 * is_corporation) — never blind-delete (older transactions must persist).
 * Persists corp columns + the previously-dropped client_id/journal_ref_id.
 * @param {Object} transactionsData - Transactions data from ESI
 * @returns {boolean} Success status
 */
function saveWalletTransactions(transactionsData) {
  try {
    const db = getCharacterDatabase();
    const isCorporation = transactionsData.isCorporation ? 1 : 0;
    const corporationId = transactionsData.corporationId || null;
    const division = transactionsData.division || null;

    db.exec('BEGIN TRANSACTION');
    try {
      const insertTransaction = db.prepare(`
        INSERT INTO esi_wallet_transactions (
          transaction_id, character_id, is_corporation, corporation_id, division,
          date, type_id, quantity, unit_price, location_id, is_buy, is_personal,
          client_id, journal_ref_id, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(transaction_id, character_id, is_corporation) DO UPDATE SET
          corporation_id = excluded.corporation_id,
          division = excluded.division,
          client_id = excluded.client_id,
          journal_ref_id = excluded.journal_ref_id,
          last_updated = excluded.last_updated,
          cache_expires_at = excluded.cache_expires_at
      `);

      for (const transaction of transactionsData.transactions) {
        const transactionDate = new Date(transaction.date).getTime();
        // Corp transactions lack is_personal; store null for those.
        const isPersonal = transaction.is_personal == null
          ? null
          : (transaction.is_personal ? 1 : 0);

        insertTransaction.run(
          transaction.transaction_id,
          transactionsData.characterId,
          isCorporation,
          corporationId,
          division,
          transactionDate,
          transaction.type_id,
          transaction.quantity,
          transaction.unit_price,
          transaction.location_id,
          transaction.is_buy ? 1 : 0,
          isPersonal,
          transaction.client_id != null ? transaction.client_id : null,
          transaction.journal_ref_id != null ? transaction.journal_ref_id : null,
          transactionsData.lastUpdated,
          transactionsData.cacheExpiresAt || null
        );
      }

      db.exec('COMMIT');
      const label = isCorporation ? `corp ${corporationId} div ${division}` : `character ${transactionsData.characterId}`;
      console.log(`Saved ${transactionsData.transactions.length} wallet transactions for ${label}`);

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

    let query;
    const params = [];

    // Corp vs character scoping, mirroring getIndustryJobs.
    if (filters.includeCorporation && filters.corporationIds && filters.corporationIds.length > 0) {
      const corpPlaceholders = filters.corporationIds.map(() => '?').join(',');
      query = `SELECT * FROM esi_wallet_transactions WHERE (
        (character_id = ? AND is_corporation = 0)
        OR (corporation_id IN (${corpPlaceholders}) AND is_corporation = 1)
      )`;
      params.push(characterId, ...filters.corporationIds);
    } else if (filters.corporationId) {
      query = 'SELECT * FROM esi_wallet_transactions WHERE corporation_id = ? AND is_corporation = 1';
      params.push(filters.corporationId);
    } else {
      query = 'SELECT * FROM esi_wallet_transactions WHERE character_id = ? AND is_corporation = 0';
      params.push(characterId);
    }

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
      isCorporation: row.is_corporation === 1,
      corporationId: row.corporation_id,
      division: row.division,
      date: row.date,
      typeId: row.type_id,
      quantity: row.quantity,
      unitPrice: row.unit_price,
      locationId: row.location_id,
      isBuy: row.is_buy === 1,
      isPersonal: row.is_personal == null ? null : row.is_personal === 1,
      clientId: row.client_id,
      journalRefId: row.journal_ref_id,
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

// ─── Wallet Journal ──────────────────────────────────────────────────────────

/**
 * Fetch character wallet journal from ESI. Paginated, 3600s cache.
 * No new scope — esi-wallet.read_character_wallet.v1 covers the character journal.
 * @param {number} characterId - Character ID
 * @returns {Promise<Object>} Journal data with metadata
 */
async function fetchCharacterWalletJournal(characterId) {
  const callKey = `character_${characterId}_wallet_journal`;
  const url = `https://esi.evetech.net/latest/characters/${characterId}/wallet/journal/?datasource=tranquility`;

  console.log('Fetching character wallet journal...');

  const result = await esiFetch('wallet_journal', callKey, url, {
    characterId,
    category: 'character',
    endpointLabel: 'Wallet Journal',
  });

  if (result.skipped) {
    return { entries: [], characterId, lastUpdated: Date.now(), cacheExpiresAt: null, skipped: true };
  }

  const entries = result.data || [];
  console.log(`Fetched ${entries.length} wallet journal entries across ${result.pages} page(s)`);

  return { entries, characterId, lastUpdated: Date.now(), cacheExpiresAt: result.cacheExpiresAt };
}

/**
 * Fetch corporation wallet journal from ESI (per division). Paginated, 3600s cache.
 * Covered by esi-wallet.read_corporation_wallets.v1 — no additional scope.
 * @param {number} characterId - Authenticating character
 * @param {number} corporationId - Corporation ID
 * @param {number} division - Wallet division (1-7)
 * @returns {Promise<Object>} Journal data with metadata
 */
async function fetchCorporationWalletJournal(characterId, corporationId, division) {
  const callKey = `corporation_${corporationId}_${division}_wallet_journal`;
  const emptyResult = {
    entries: [], characterId, corporationId, division,
    isCorporation: true, lastUpdated: Date.now(), cacheExpiresAt: null,
  };

  const character = getCharacter(characterId);
  if (!character) {
    throw Object.assign(new Error('Character not found'), { code: 'NOT_FOUND', characterId });
  }
  if (!character.scopes || !character.scopes.includes(CORP_WALLET_SCOPE)) {
    console.log('Character does not have corporation wallet scope, skipping journal...');
    return emptyResult;
  }

  const url = `https://esi.evetech.net/latest/corporations/${corporationId}/wallets/${division}/journal/?datasource=tranquility`;

  console.log(`Fetching corporation ${corporationId} division ${division} wallet journal...`);

  try {
    const result = await esiFetch('corporation_wallet_journal', callKey, url, {
      characterId,
      corporationId,
      category: 'corporation',
      endpointLabel: `Corporation Wallet Journal (Div ${division})`,
    });

    if (result.skipped) return { ...emptyResult, skipped: true };
    if (result.roleForbidden) {
      console.log('Character does not have permission to view corporation journal (requires accountant/director role)');
      return emptyResult;
    }

    const entries = result.data || [];
    console.log(`Fetched ${entries.length} corp journal entries (div ${division}) across ${result.pages} page(s)`);

    return {
      entries, characterId, corporationId, division,
      isCorporation: true, lastUpdated: Date.now(), cacheExpiresAt: result.cacheExpiresAt,
    };
  } catch (error) {
    if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
      throw error;
    }
    console.error('Error fetching corporation wallet journal:', error);
    return emptyResult;
  }
}

/**
 * Save wallet journal entries (character or corporation).
 * Durable-log upsert on the composite key (id, character_id, is_corporation) —
 * never blind-delete. The journal is append-only in EVE, so this is a pure
 * accumulate-and-refresh; old fee rows are never lost.
 * @param {Object} journalData - Journal data from ESI
 * @returns {boolean} Success status
 */
function saveWalletJournal(journalData) {
  try {
    const db = getCharacterDatabase();
    const isCorporation = journalData.isCorporation ? 1 : 0;
    const corporationId = journalData.corporationId || null;
    const division = journalData.division || null;

    db.exec('BEGIN TRANSACTION');
    try {
      const insertEntry = db.prepare(`
        INSERT INTO esi_wallet_journal (
          id, character_id, is_corporation, corporation_id, division,
          date, ref_type, amount, balance, context_id, context_id_type,
          first_party_id, second_party_id, reason, tax, tax_receiver_id,
          last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, character_id, is_corporation) DO UPDATE SET
          corporation_id = excluded.corporation_id,
          division = excluded.division,
          balance = excluded.balance,
          last_updated = excluded.last_updated,
          cache_expires_at = excluded.cache_expires_at
      `);

      for (const entry of journalData.entries) {
        const entryDate = entry.date ? new Date(entry.date).getTime() : null;
        insertEntry.run(
          entry.id,
          journalData.characterId,
          isCorporation,
          corporationId,
          division,
          entryDate,
          entry.ref_type,
          entry.amount != null ? entry.amount : null,
          entry.balance != null ? entry.balance : null,
          entry.context_id != null ? entry.context_id : null,
          entry.context_id_type || null,
          entry.first_party_id != null ? entry.first_party_id : null,
          entry.second_party_id != null ? entry.second_party_id : null,
          entry.reason || null,
          entry.tax != null ? entry.tax : null,
          entry.tax_receiver_id != null ? entry.tax_receiver_id : null,
          journalData.lastUpdated,
          journalData.cacheExpiresAt || null
        );
      }

      db.exec('COMMIT');
      const label = isCorporation ? `corp ${corporationId} div ${division}` : `character ${journalData.characterId}`;
      console.log(`Saved ${journalData.entries.length} wallet journal entries for ${label}`);

      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error saving wallet journal to database:', error);
    return false;
  }
}

/**
 * Get wallet journal entries from database.
 * @param {number} characterId - Character ID
 * @param {Object} filters - refType, contextId, startDate, endDate, includeCorporation/corporationIds/corporationId
 * @returns {Array} Journal entries
 */
function getWalletJournal(characterId, filters = {}) {
  try {
    const db = getCharacterDatabase();

    let query;
    const params = [];

    if (filters.includeCorporation && filters.corporationIds && filters.corporationIds.length > 0) {
      const corpPlaceholders = filters.corporationIds.map(() => '?').join(',');
      query = `SELECT * FROM esi_wallet_journal WHERE (
        (character_id = ? AND is_corporation = 0)
        OR (corporation_id IN (${corpPlaceholders}) AND is_corporation = 1)
      )`;
      params.push(characterId, ...filters.corporationIds);
    } else if (filters.corporationId) {
      query = 'SELECT * FROM esi_wallet_journal WHERE corporation_id = ? AND is_corporation = 1';
      params.push(filters.corporationId);
    } else {
      query = 'SELECT * FROM esi_wallet_journal WHERE character_id = ? AND is_corporation = 0';
      params.push(characterId);
    }

    if (filters.refType) {
      query += ' AND ref_type = ?';
      params.push(filters.refType);
    }
    if (filters.contextId) {
      query += ' AND context_id = ?';
      params.push(filters.contextId);
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
      id: row.id,
      characterId: row.character_id,
      isCorporation: row.is_corporation === 1,
      corporationId: row.corporation_id,
      division: row.division,
      date: row.date,
      refType: row.ref_type,
      amount: row.amount,
      balance: row.balance,
      contextId: row.context_id,
      contextIdType: row.context_id_type,
      firstPartyId: row.first_party_id,
      secondPartyId: row.second_party_id,
      reason: row.reason,
      tax: row.tax,
      taxReceiverId: row.tax_receiver_id,
      lastUpdated: row.last_updated,
      cacheExpiresAt: row.cache_expires_at,
    }));
  } catch (error) {
    console.error('Error getting wallet journal from database:', error);
    return [];
  }
}

module.exports = {
  fetchCharacterWalletTransactions,
  fetchCorporationWalletTransactions,
  fetchCharacterWalletJournal,
  fetchCorporationWalletJournal,
  saveWalletTransactions,
  saveWalletJournal,
  getWalletTransactions,
  getWalletJournal,
  getWalletTransactionsCacheStatus,
};
