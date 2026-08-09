const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getDataPath } = require('./portable-mode');

let db = null;

/**
 * Get the path to the ESI status database
 */
function getESIStatusDatabasePath() {
  const userDataPath = getDataPath();
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

  // Guarded, idempotent column additions for the rate-limit layer.
  // This DB is NOT part of the numbered character-DB migration system, so we
  // upgrade existing esi-status.db files in place here (pragma-checked ALTERs).
  addColumnIfMissing('esi_call_status', 'ratelimit_remaining', 'INTEGER');
  addColumnIfMissing('esi_call_status', 'ratelimit_limit', 'TEXT');
  addColumnIfMissing('esi_call_status', 'ratelimit_group', 'TEXT');
  addColumnIfMissing('esi_call_status', 'ratelimit_reset_at', 'INTEGER');
  addColumnIfMissing('esi_call_status', 'retry_after_at', 'INTEGER');
  // Conditional-request support. call_key is already the stable unique id for
  // every logical ESI request in the app, so an ETag needs no new keying - just
  // a column on the row that already exists.
  addColumnIfMissing('esi_call_status', 'etag', 'TEXT');
  // Tokens the last call consumed under the bucket limiter (4xx cost 5, vs 2
  // for a success), so the cost of a failing endpoint is visible.
  addColumnIfMissing('esi_call_status', 'ratelimit_used', 'INTEGER');

  console.log('[ESI Status] Database tables created successfully');
}

/**
 * Add a column to a table if it does not already exist (idempotent).
 * @param {string} table - Table name
 * @param {string} column - Column name
 * @param {string} definition - Column type/definition (e.g. "INTEGER")
 */
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[ESI Status] Added column ${table}.${column}`);
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
 * How long to refuse an endpoint after a failure.
 *
 * Without this, `next_allowed_at` was only ever set on SUCCESS, so a failing
 * endpoint stayed permanently eligible and was re-tried on every background
 * cycle. That is worst exactly where it hurts most: a 4xx costs 2.5x a success
 * against ESI's rate bucket (see rateLimitTokenCost in esi-fetch.js) AND spends
 * the app-wide error budget, so one permanently-broken endpoint - a revoked
 * scope, a structure the character can no longer dock at - degrades every other
 * caller indefinitely.
 *
 * Backoff is exponential in consecutive failures, and the ceiling depends on
 * what kind of error it is:
 *
 *   4xx  - the request itself is wrong and will keep being wrong. Retrying
 *          soon cannot help, so these back off hard (up to 6 hours).
 *   5xx / network - ESI is unwell, not the request. These recover on their
 *          own, so they back off gently (up to 15 minutes) and free.
 *
 * @param {string|number|null} errorCode
 * @param {number} consecutiveErrors - failures in a row, including this one
 * @returns {number} milliseconds to wait
 */
function errorBackoffMs(errorCode, consecutiveErrors) {
  const code = parseInt(errorCode, 10);
  const isClientError = Number.isFinite(code) && code >= 400 && code < 500;

  // 420/429 are rate-limit responses; esi-fetch already honours Retry-After
  // for those, so they are treated as transient here rather than punished.
  const isRateLimit = code === 420 || code === 429;

  const base = isClientError && !isRateLimit ? 5 * 60 * 1000 : 30 * 1000;
  const ceiling = isClientError && !isRateLimit ? 6 * 60 * 60 * 1000 : 15 * 60 * 1000;

  // Exponential, capped. `- 1` so the first failure waits `base`, not double.
  const grown = base * Math.pow(2, Math.max(0, consecutiveErrors - 1));
  return Math.min(grown, ceiling);
}

/**
 * How many failures in a row this endpoint has had, including the one being
 * recorded now.
 *
 * Derived from the history rather than a counter column: `error_count` is
 * CUMULATIVE and never reset by a success, so using it would push a
 * long-running endpoint to the backoff ceiling on the strength of failures it
 * recovered from months ago. History is capped at 50 rows per endpoint, which
 * bounds the scan and is far more streak than any sane backoff needs.
 *
 * @param {Object} database
 * @param {string} callKey
 * @returns {number} at least 1
 */
function consecutiveErrorCount(database, callKey) {
  try {
    const rows = database.prepare(`
      SELECT status FROM esi_call_history
      WHERE call_key = ?
      ORDER BY timestamp DESC
      LIMIT 20
    `).all(callKey);

    let streak = 1; // the failure being recorded now
    for (const row of rows) {
      if (row.status !== 'error') break;
      streak += 1;
    }
    return streak;
  } catch (error) {
    // A failed count must not stop the failure being recorded.
    return 1;
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

    // Counted BEFORE this failure is inserted below, so the history scan sees
    // the previous streak and this one is added explicitly.
    const streak = consecutiveErrorCount(database, callKey);
    const nextAllowedAt = now + errorBackoffMs(errorCode, streak);

    // Update status record.
    //
    // `next_allowed_at` is the point of this: without it the endpoint stayed
    // permanently eligible and every background cycle re-tried a call that
    // could not succeed, spending rate-limit tokens and error budget that are
    // shared with every other caller in the app.
    database.prepare(`
      UPDATE esi_call_status
      SET status = 'error',
          error_message = ?,
          error_code = ?,
          error_count = error_count + 1,
          next_allowed_at = ?,
          updated_at = ?
      WHERE call_key = ?
    `).run(errorMessage, errorCode, nextAllowedAt, now, callKey);

    // Add to history
    database.prepare(`
      INSERT INTO esi_call_history (call_key, status, timestamp, duration_ms, error_message, error_code)
      VALUES (?, 'error', ?, ?, ?, ?)
    `).run(callKey, now, duration, errorMessage, errorCode);

    // Cleanup old history (keep last 50 per endpoint)
    cleanupCallHistory(callKey);

    const waitMins = Math.round((nextAllowedAt - now) / 60000);
    console.log(
      `[ESI Status] Call failed: ${callKey} - ${errorMessage} ` +
      `(failure ${streak}; next attempt in ${waitMins >= 1 ? `${waitMins}m` : '<1m'})`
    );
  } catch (error) {
    console.error(`[ESI Status] Error recording call failure for ${callKey}:`, error);
  }
}

/**
 * Record rate-limit header state for an ESI call.
 * Parses the X-Ratelimit-* headers (and any Retry-After deadline) and persists
 * them on the call's status row. Called by esiFetch after every response.
 * @param {string} callKey - Unique identifier for the call
 * @param {Object} rateLimit - Parsed rate-limit fields
 * @param {number} [rateLimit.remaining] - X-Ratelimit-Remaining (tokens left)
 * @param {string} [rateLimit.limit] - X-Ratelimit-Limit (e.g. "150/15m")
 * @param {string} [rateLimit.group] - X-Ratelimit-Group
 * @param {number} [rateLimit.resetAt] - When the token window resets (timestamp)
 * @param {number} [rateLimit.retryAfterAt] - Retry-After deadline (timestamp, from 429/420)
 */
function recordRateLimit(callKey, rateLimit = {}) {
  try {
    const database = getDatabase();
    database.prepare(`
      UPDATE esi_call_status
      SET ratelimit_remaining = COALESCE(?, ratelimit_remaining),
          ratelimit_limit = COALESCE(?, ratelimit_limit),
          ratelimit_group = COALESCE(?, ratelimit_group),
          ratelimit_reset_at = COALESCE(?, ratelimit_reset_at),
          retry_after_at = COALESCE(?, retry_after_at),
          ratelimit_used = COALESCE(?, ratelimit_used)
      WHERE call_key = ?
    `).run(
      rateLimit.remaining ?? null,
      rateLimit.limit ?? null,
      rateLimit.group ?? null,
      rateLimit.resetAt ?? null,
      rateLimit.retryAfterAt ?? null,
      rateLimit.used ?? null,
      callKey
    );
  } catch (error) {
    console.error(`[ESI Status] Error recording rate limit for ${callKey}:`, error);
  }
}

/**
 * The stored ETag for a call, or null.
 *
 * ESI supports conditional requests: send this back as If-None-Match and an
 * unchanged resource answers 304 with no body. Under the bucket limiter a 304
 * costs 1 token instead of 2, transfers nothing, and (being 3xx) spends no
 * error budget at all.
 *
 * @param {string} callKey
 * @returns {string|null}
 */
function getETag(callKey) {
  try {
    const database = getDatabase();
    const row = database.prepare(
      'SELECT etag FROM esi_call_status WHERE call_key = ?'
    ).get(callKey);
    return row && row.etag ? row.etag : null;
  } catch (error) {
    // An ETag is an optimisation; a read failure must not break the fetch.
    return null;
  }
}

/**
 * Store the ETag from a response.
 * @param {string} callKey
 * @param {string|null} etag
 */
function recordETag(callKey, etag) {
  if (!etag) return;
  try {
    const database = getDatabase();
    database.prepare(
      'UPDATE esi_call_status SET etag = ? WHERE call_key = ?'
    ).run(etag, callKey);
  } catch (error) {
    console.error(`[ESI Status] Error recording ETag for ${callKey}:`, error);
  }
}

/**
 * Whether an endpoint is eligible to be fetched right now.
 * True when there is no recorded next_allowed_at, or it is in the past.
 * next_allowed_at folds in cache TTL, the client-side minInterval floor, and
 * any active Retry-After deadline. This is the single gate the background cycle
 * and on-demand callers consult.
 * @param {string} callKey - Unique identifier for the call
 * @returns {boolean}
 */
function canFetchEndpoint(callKey) {
  try {
    const database = getDatabase();
    const row = database.prepare(
      'SELECT next_allowed_at FROM esi_call_status WHERE call_key = ?'
    ).get(callKey);
    if (!row || row.next_allowed_at == null) {
      return true;
    }
    return Date.now() >= row.next_allowed_at;
  } catch (error) {
    console.error(`[ESI Status] Error checking fetch eligibility for ${callKey}:`, error);
    // Fail open — don't block fetching because the status DB hiccuped.
    return true;
  }
}

/**
 * When the soonest-eligible endpoint of the given types becomes fetchable.
 *
 * Lets the background cycle schedule its next tick for the moment something
 * is actually due, instead of running on a fixed period. A fixed period both
 * delays fast endpoints (a 1-minute floor polled every 5) and beats against
 * slow ones (a 5-minute floor polled every 5 wastes every other tick).
 *
 * `endpointTypes` MATTERS: most tracked endpoints are fetched on demand by
 * their own screens (assets, market orders, skills...), not by the cycle.
 * Without this filter the cycle would wake for endpoints it never fetches and
 * immediately go back to sleep.
 *
 * Rows with a NULL next_allowed_at are IGNORED: those are placeholders that
 * have never been fetched, and they carry no deadline to wait for. The cycle
 * fetches them on its next pass whenever that lands - they do not need to pull
 * the tick earlier, and treating them as overdue pinned the scheduler at its
 * floor forever.
 *
 * @param {string[]} endpointTypes - endpoint_type values the caller fetches.
 * @returns {number|null} epoch-ms of the soonest real deadline, or null when
 *   none of those types has ever been fetched.
 */
function getNextEligibleAt(endpointTypes) {
  if (!Array.isArray(endpointTypes) || endpointTypes.length === 0) return null;

  try {
    const database = getDatabase();
    const placeholders = endpointTypes.map(() => '?').join(',');

    // Only rows that have ACTUALLY been fetched carry a meaningful deadline.
    //
    // initializeCharacterEndpoints() inserts placeholder rows with status
    // 'pending' and next_allowed_at NULL. Treating NULL as "due since epoch"
    // made MIN() return 0 forever, pinning the scheduler at its floor - and
    // permanently so, because a placeholder for an endpoint this cycle cannot
    // fetch (no scope, no corp role) is never updated and stays NULL for good.
    // Also ignore deadlines already in the PAST. Those are endpoints the cycle
    // wants but cannot complete - a missing scope or corp role fails every
    // attempt, and recordESICallError does not move next_allowed_at, so the
    // deadline stays stale forever. Waking "when it is due" is meaningless for
    // those; they are simply retried on whatever pass comes next.
    const row = database.prepare(`
      SELECT MIN(next_allowed_at) AS soonest, COUNT(*) AS tracked
      FROM esi_call_status
      WHERE endpoint_type IN (${placeholders})
        AND next_allowed_at IS NOT NULL
        AND next_allowed_at > ?
    `).get(...endpointTypes, Date.now());

    if (!row || !row.tracked || row.soonest == null) return null;
    return row.soonest;
  } catch (error) {
    console.error('[ESI Status] Error finding next eligible endpoint:', error);
    // Fail open: the caller falls back to its default cadence.
    return null;
  }
}

/**
 * Get per-endpoint freshness/eligibility info for a call.
 * Used by the global-refresh status IPC to report "next eligible at T".
 * @param {string} callKey - Unique identifier for the call
 * @returns {Object|null} { callKey, status, lastQueryAt, cacheExpiresAt, nextAllowedAt, eligible, ratelimit* } or null
 */
function getEndpointFreshness(callKey) {
  try {
    const database = getDatabase();
    const row = database.prepare(`
      SELECT call_key, endpoint_type, endpoint_label, character_id, status,
             last_query_at, cache_expires_at, next_allowed_at,
             ratelimit_remaining, ratelimit_limit, ratelimit_group,
             ratelimit_reset_at, retry_after_at
      FROM esi_call_status WHERE call_key = ?
    `).get(callKey);
    if (!row) {
      return null;
    }
    return {
      callKey: row.call_key,
      endpointType: row.endpoint_type,
      endpointLabel: row.endpoint_label,
      characterId: row.character_id,
      status: row.status,
      lastQueryAt: row.last_query_at,
      cacheExpiresAt: row.cache_expires_at,
      nextAllowedAt: row.next_allowed_at,
      eligible: row.next_allowed_at == null || Date.now() >= row.next_allowed_at,
      ratelimitRemaining: row.ratelimit_remaining,
      ratelimitLimit: row.ratelimit_limit,
      ratelimitGroup: row.ratelimit_group,
      ratelimitResetAt: row.ratelimit_reset_at,
      retryAfterAt: row.retry_after_at,
    };
  } catch (error) {
    console.error(`[ESI Status] Error getting endpoint freshness for ${callKey}:`, error);
    return null;
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
        // Counted for reporting, but NOT a warning. A call being in flight is
        // normal operation - treating it as one made the footer flash amber
        // every refresh cycle, which trains the user to ignore the indicator.
        inProgressCount++;
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

    // Determine overall status based on MOST RECENT calls only. In-progress
    // calls deliberately do not colour this - only actual failures do.
    let overall = 'green';
    if (recentErrors > 0) {
      overall = 'red'; // Error: Recent errors (within last hour)
    } else if (warningCount > 0) {
      overall = 'yellow'; // Warning: errors older than an hour
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
  recordRateLimit,
  getETag,
  recordETag,
  canFetchEndpoint,
  getNextEligibleAt,
  getEndpointFreshness,
  getESICallStatus,
  getAllCharacterCallStatuses,
  getAllUniverseCallStatuses,
  getAggregatedStatus,
  getCallHistory,
  cleanupOldHistory,
  closeDatabase,
};
