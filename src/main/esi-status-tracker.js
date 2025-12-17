const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const fs = require('fs');

let db = null;

/**
 * Get the path to the ESI status database
 */
function getESIStatusDatabasePath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'esi-status.db');
}

/**
 * Initialize the ESI status database
 */
function initializeESIStatusDatabase() {
  try {
    const dbPath = getESIStatusDatabasePath();
    console.log('[ESI Status] Opening ESI status database:', dbPath);

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    // Create tables
    createTables();

    console.log('[ESI Status] ESI status database initialized successfully');
    return true;
  } catch (error) {
    console.error('[ESI Status] Error initializing ESI status database:', error);
    return false;
  }
}

/**
 * Create database tables
 */
function createTables() {
  // ESI call status table
  db.exec(`
    CREATE TABLE IF NOT EXISTS esi_call_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_key TEXT NOT NULL UNIQUE,
      call_category TEXT NOT NULL,
      character_id INTEGER,
      endpoint_type TEXT NOT NULL,
      endpoint_label TEXT NOT NULL,
      status TEXT NOT NULL,
      last_query_at INTEGER,
      cache_expires_at INTEGER,
      next_allowed_at INTEGER,
      error_message TEXT,
      error_code TEXT,
      request_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_call_status_category ON esi_call_status(call_category);
    CREATE INDEX IF NOT EXISTS idx_call_status_character ON esi_call_status(character_id);
    CREATE INDEX IF NOT EXISTS idx_call_status_status ON esi_call_status(status);
  `);

  // ESI call history table (last 50 calls per endpoint)
  db.exec(`
    CREATE TABLE IF NOT EXISTS esi_call_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_key TEXT NOT NULL,
      status TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      duration_ms INTEGER,
      error_message TEXT,
      error_code TEXT,
      response_size INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_call_history_key ON esi_call_history(call_key);
    CREATE INDEX IF NOT EXISTS idx_call_history_timestamp ON esi_call_history(timestamp);
  `);

  console.log('[ESI Status] Database tables created successfully');
}

/**
 * Get the database instance
 */
function getDatabase() {
  if (!db) {
    initializeESIStatusDatabase();
  }
  return db;
}

/**
 * Initialize expected ESI endpoints for a character
 * This creates placeholder records for all possible character endpoints
 * @param {number} characterId - Character ID
 * @param {string} characterName - Character name
 */
function initializeCharacterEndpoints(characterId, characterName) {
  try {
    const database = getDatabase();
    const now = Date.now();

    const endpoints = [
      { type: 'skills', label: 'Skills' },
      { type: 'blueprints', label: 'Blueprints' },
      { type: 'corporation_blueprints', label: 'Corporation Blueprints' },
      { type: 'assets', label: 'Assets' },
      { type: 'corporation_assets', label: 'Corporation Assets' },
      { type: 'industry_jobs', label: 'Industry Jobs' },
      { type: 'wallet_transactions', label: 'Wallet Transactions' },
      { type: 'corporation_divisions', label: 'Corporation Divisions' },
    ];

    for (const endpoint of endpoints) {
      const callKey = `character_${characterId}_${endpoint.type}`;

      // Check if already exists
      const existing = database.prepare('SELECT id FROM esi_call_status WHERE call_key = ?').get(callKey);

      if (!existing) {
        database.prepare(`
          INSERT INTO esi_call_status (
            call_key, call_category, character_id, endpoint_type, endpoint_label,
            status, last_query_at, updated_at, request_count, success_count, error_count
          ) VALUES (?, 'character', ?, ?, ?, 'pending', NULL, ?, 0, 0, 0)
        `).run(callKey, characterId, endpoint.type, endpoint.label, now);
      }
    }

    console.log(`[ESI Status] Initialized ${endpoints.length} endpoints for character ${characterId}`);
  } catch (error) {
    console.error(`[ESI Status] Error initializing character endpoints:`, error);
  }
}

/**
 * Initialize expected universe ESI endpoints
 * This creates placeholder records for all possible universe endpoints
 */
function initializeUniverseEndpoints() {
  try {
    const database = getDatabase();
    const now = Date.now();

    const endpoints = [
      { key: 'universe_server_status', type: 'server_status', label: 'Server Status' },
      { key: 'universe_market_orders_10000002', type: 'market_orders', label: 'Market Orders' },
      { key: 'universe_market_history_10000002', type: 'market_history', label: 'Market History' },
      { key: 'universe_adjusted_prices', type: 'adjusted_prices', label: 'Adjusted Prices' },
      { key: 'universe_cost_indices', type: 'cost_indices', label: 'Cost Indices' },
    ];

    for (const endpoint of endpoints) {
      // Check if already exists
      const existing = database.prepare('SELECT id FROM esi_call_status WHERE call_key = ?').get(endpoint.key);

      if (!existing) {
        database.prepare(`
          INSERT INTO esi_call_status (
            call_key, call_category, character_id, endpoint_type, endpoint_label,
            status, last_query_at, updated_at, request_count, success_count, error_count
          ) VALUES (?, 'universe', NULL, ?, ?, 'pending', NULL, ?, 0, 0, 0)
        `).run(endpoint.key, endpoint.type, endpoint.label, now);
      }
    }

    console.log(`[ESI Status] Initialized ${endpoints.length} universe endpoints`);
  } catch (error) {
    console.error(`[ESI Status] Error initializing universe endpoints:`, error);
  }
}

/**
 * Record the start of an ESI call
 * @param {string} callKey - Unique identifier for the call (e.g., "character_123_skills")
 * @param {Object} metadata - Call metadata
 * @param {string} metadata.category - "character" or "universe"
 * @param {number} metadata.characterId - Character ID (null for universe calls)
 * @param {string} metadata.endpointType - Endpoint type (e.g., "skills", "blueprints")
 * @param {string} metadata.endpointLabel - Human-readable label (e.g., "Skills", "Blueprints")
 */
function recordESICallStart(callKey, metadata) {
  try {
    const database = getDatabase();
    const now = Date.now();

    // Check if record exists
    const existing = database.prepare('SELECT * FROM esi_call_status WHERE call_key = ?').get(callKey);

    if (existing) {
      // Update existing record to in_progress
      database.prepare(`
        UPDATE esi_call_status
        SET status = 'in_progress',
            last_query_at = ?,
            updated_at = ?,
            request_count = request_count + 1
        WHERE call_key = ?
      `).run(now, now, callKey);
    } else {
      // Insert new record
      database.prepare(`
        INSERT INTO esi_call_status (
          call_key, call_category, character_id, endpoint_type, endpoint_label,
          status, last_query_at, updated_at, request_count
        ) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, 1)
      `).run(
        callKey,
        metadata.category,
        metadata.characterId || null,
        metadata.endpointType,
        metadata.endpointLabel,
        now,
        now
      );
    }

    console.log(`[ESI Status] Call started: ${callKey}`);
  } catch (error) {
    console.error(`[ESI Status] Error recording call start for ${callKey}:`, error);
  }
}

/**
 * Record a successful ESI call
 * @param {string} callKey - Unique identifier for the call
 * @param {number} cacheExpiresAt - When cached data expires (timestamp)
 * @param {number} nextAllowedAt - Next allowed query time (timestamp)
 * @param {number} responseSize - Response size in bytes
 * @param {number} startTime - When the call started (for duration calculation)
 */
function recordESICallSuccess(callKey, cacheExpiresAt = null, nextAllowedAt = null, responseSize = null, startTime = null) {
  try {
    const database = getDatabase();
    const now = Date.now();
    const duration = startTime ? now - startTime : null;

    // Update status record
    database.prepare(`
      UPDATE esi_call_status
      SET status = 'success',
          cache_expires_at = ?,
          next_allowed_at = ?,
          error_message = NULL,
          error_code = NULL,
          success_count = success_count + 1,
          updated_at = ?
      WHERE call_key = ?
    `).run(cacheExpiresAt, nextAllowedAt, now, callKey);

    // Add to history
    database.prepare(`
      INSERT INTO esi_call_history (call_key, status, timestamp, duration_ms, response_size)
      VALUES (?, 'success', ?, ?, ?)
    `).run(callKey, now, duration, responseSize);

    // Cleanup old history (keep last 50 per endpoint)
    cleanupCallHistory(callKey);

    console.log(`[ESI Status] Call succeeded: ${callKey}`);
  } catch (error) {
    console.error(`[ESI Status] Error recording call success for ${callKey}:`, error);
  }
}

/**
 * Record a failed ESI call
 * @param {string} callKey - Unique identifier for the call
 * @param {string} errorMessage - Error message
 * @param {string} errorCode - Error code (HTTP status or error type)
 * @param {number} startTime - When the call started (for duration calculation)
 */
function recordESICallError(callKey, errorMessage, errorCode = null, startTime = null) {
  try {
    const database = getDatabase();
    const now = Date.now();
    const duration = startTime ? now - startTime : null;

    // Update status record
    database.prepare(`
      UPDATE esi_call_status
      SET status = 'error',
          error_message = ?,
          error_code = ?,
          error_count = error_count + 1,
          updated_at = ?
      WHERE call_key = ?
    `).run(errorMessage, errorCode, now, callKey);

    // Add to history
    database.prepare(`
      INSERT INTO esi_call_history (call_key, status, timestamp, duration_ms, error_message, error_code)
      VALUES (?, 'error', ?, ?, ?, ?)
    `).run(callKey, now, duration, errorMessage, errorCode);

    // Cleanup old history (keep last 50 per endpoint)
    cleanupCallHistory(callKey);

    console.log(`[ESI Status] Call failed: ${callKey} - ${errorMessage}`);
  } catch (error) {
    console.error(`[ESI Status] Error recording call failure for ${callKey}:`, error);
  }
}

/**
 * Cleanup old history for a specific call key (keep last 50)
 * @param {string} callKey - Call key to cleanup
 */
function cleanupCallHistory(callKey) {
  try {
    const database = getDatabase();
    database.prepare(`
      DELETE FROM esi_call_history
      WHERE call_key = ?
      AND id NOT IN (
        SELECT id FROM esi_call_history
        WHERE call_key = ?
        ORDER BY timestamp DESC
        LIMIT 50
      )
    `).run(callKey, callKey);
  } catch (error) {
    console.error(`[ESI Status] Error cleaning up history for ${callKey}:`, error);
  }
}

/**
 * Get status for a specific ESI call
 * @param {string} callKey - Call key
 * @returns {Object|null} Call status or null if not found
 */
function getESICallStatus(callKey) {
  try {
    const database = getDatabase();
    return database.prepare('SELECT * FROM esi_call_status WHERE call_key = ?').get(callKey);
  } catch (error) {
    console.error(`[ESI Status] Error getting call status for ${callKey}:`, error);
    return null;
  }
}

/**
 * Get all ESI call statuses for a character
 * @param {number} characterId - Character ID
 * @returns {Array} Array of call statuses
 */
function getAllCharacterCallStatuses(characterId) {
  try {
    const database = getDatabase();
    return database.prepare(`
      SELECT * FROM esi_call_status
      WHERE character_id = ?
      ORDER BY endpoint_label ASC
    `).all(characterId);
  } catch (error) {
    console.error(`[ESI Status] Error getting character call statuses for ${characterId}:`, error);
    return [];
  }
}

/**
 * Get all universe-wide ESI call statuses
 * @returns {Array} Array of call statuses
 */
function getAllUniverseCallStatuses() {
  try {
    const database = getDatabase();
    return database.prepare(`
      SELECT * FROM esi_call_status
      WHERE call_category = 'universe'
      ORDER BY endpoint_label ASC
    `).all();
  } catch (error) {
    console.error('[ESI Status] Error getting universe call statuses:', error);
    return [];
  }
}

/**
 * Get aggregated status (Green/Yellow/Red)
 * Only considers endpoints that have been called at least once (ignores "pending" status)
 * Only the most recent status of each endpoint matters
 * @returns {Object} Aggregated status with overall status and counts
 */
function getAggregatedStatus() {
  try {
    const database = getDatabase();
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);

    // Get all statuses, excluding pending (never called) endpoints
    const allStatuses = database.prepare(`
      SELECT * FROM esi_call_status
      WHERE status != 'pending'
    `).all();

    if (allStatuses.length === 0) {
      return {
        overall: 'green',
        successCount: 0,
        warningCount: 0,
        errorCount: 0,
        totalCount: 0,
      };
    }

    let successCount = 0;
    let warningCount = 0;
    let errorCount = 0;
    let recentErrors = 0;
    let inProgressCount = 0;

    for (const status of allStatuses) {
      // Only consider the MOST RECENT status of each endpoint
      if (status.status === 'success') {
        successCount++;
      } else if (status.status === 'in_progress') {
        inProgressCount++;
        warningCount++;
      } else if (status.status === 'error') {
        errorCount++;
        // Check if error is recent (within last hour)
        if (status.updated_at && status.updated_at > oneHourAgo) {
          recentErrors++;
        } else {
          warningCount++;
        }
      }
    }

    // Determine overall status based on MOST RECENT calls only
    let overall = 'green';
    if (recentErrors > 0) {
      overall = 'red'; // Error: Recent errors (within last hour)
    } else if (warningCount > 0 || inProgressCount > 0) {
      overall = 'yellow'; // Warning: Old errors or calls in progress
    }

    return {
      overall,
      successCount,
      warningCount,
      errorCount: recentErrors,
      totalCount: allStatuses.length,
      inProgressCount,
    };
  } catch (error) {
    console.error('[ESI Status] Error getting aggregated status:', error);
    return {
      overall: 'yellow',
      successCount: 0,
      warningCount: 0,
      errorCount: 0,
      totalCount: 0,
    };
  }
}

/**
 * Get call history for a specific call key
 * @param {string} callKey - Call key
 * @param {number} limit - Maximum number of records to return
 * @returns {Array} Array of history records
 */
function getCallHistory(callKey, limit = 10) {
  try {
    const database = getDatabase();
    return database.prepare(`
      SELECT * FROM esi_call_history
      WHERE call_key = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(callKey, limit);
  } catch (error) {
    console.error(`[ESI Status] Error getting call history for ${callKey}:`, error);
    return [];
  }
}

/**
 * Cleanup old history records
 * @param {number} daysToKeep - Number of days to keep (default: 7)
 * @returns {number} Number of records deleted
 */
function cleanupOldHistory(daysToKeep = 7) {
  try {
    const database = getDatabase();
    const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

    const result = database.prepare(`
      DELETE FROM esi_call_history
      WHERE timestamp < ?
    `).run(cutoffTime);

    console.log(`[ESI Status] Cleaned up ${result.changes} old history records`);
    return result.changes;
  } catch (error) {
    console.error('[ESI Status] Error cleaning up old history:', error);
    return 0;
  }
}

/**
 * Close the database connection
 */
function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    console.log('[ESI Status] Database closed');
  }
}

module.exports = {
  initializeESIStatusDatabase,
  initializeCharacterEndpoints,
  initializeUniverseEndpoints,
  recordESICallStart,
  recordESICallSuccess,
  recordESICallError,
  getESICallStatus,
  getAllCharacterCallStatuses,
  getAllUniverseCallStatuses,
  getAggregatedStatus,
  getCallHistory,
  cleanupOldHistory,
  closeDatabase,
};
