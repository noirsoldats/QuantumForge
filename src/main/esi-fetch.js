/**
 * Central ESI fetch + rate-limit layer.
 *
 * Every ESI module routes network calls through `esiFetch`. It is the single
 * chokepoint for:
 *   - OAuth token refresh (folds in the block previously copy-pasted across 7 modules)
 *   - per-endpoint pre-flight gating (cache TTL + client-side floor + Retry-After)
 *   - the X-Pages pagination loop
 *   - network-error retry that HONORS Retry-After (replaces the 3 copies of retryFetch)
 *   - cache + rate-limit header parsing and status recording
 *   - 429/420 rate-limit handling and the ESI error taxonomy
 *     (ESI_TOKEN_REFRESH_FAILED, ESI_SCOPE_ERROR, role-403 -> empty, ESI_RATE_LIMITED)
 *
 * Cache TTL is NOT hardcoded here — the live `expires` header drives freshness.
 * `minIntervalMs` in ENDPOINT_POLICY is only a client-side floor (a hard minimum
 * ESI itself can't express); `next_allowed_at` is the max of (cacheExpiresAt,
 * now + floor, retryAfterAt).
 */

const { refreshAccessToken, isTokenExpired } = require('./esi-auth');
const { getCharacter, updateCharacterTokens } = require('./settings-manager');
const { getUserAgent } = require('./user-agent');
const {
  recordESICallStart,
  recordESICallSuccess,
  recordESICallError,
  recordRateLimit,
  canFetchEndpoint,
} = require('./esi-status-tracker');

const MINUTE = 60 * 1000;

/**
 * Declarative per-endpoint policy. Keyed by the exact `endpointType` strings the
 * modules already pass to recordESICallStart. `group` is the ESI rate-limit
 * group; `minIntervalMs` is the client-side floor; `paginated` drives the
 * X-Pages loop.
 */
const ENDPOINT_POLICY = {
  // Industry — 300s ESI cache
  industry_jobs:              { group: 'industry', minIntervalMs: 5 * MINUTE,  paginated: false },
  corporation_industry_jobs:  { group: 'industry', minIntervalMs: 5 * MINUTE,  paginated: true  },

  // Wallet — 3600s ESI cache; 30-min client floor (rarely binds under the 1-hr cache,
  // but protects us if ESI ever shortens it)
  // NOTE: char wallet transactions currently fetch a single page via `from_id`
  // (not `page`). Kept paginated:false to preserve today's exact behavior; Plan B
  // switches this to the page-based spec when it builds full wallet/journal support.
  wallet_transactions:        { group: 'wallet',   minIntervalMs: 30 * MINUTE, paginated: false },
  corporation_wallet_transactions: { group: 'wallet', minIntervalMs: 30 * MINUTE, paginated: true },
  wallet_journal:             { group: 'wallet',   minIntervalMs: 30 * MINUTE, paginated: true  },
  corporation_wallet_journal: { group: 'wallet',   minIntervalMs: 30 * MINUTE, paginated: true  },

  // Character / corp assets, blueprints, skills, divisions
  skills:                     { group: 'character', minIntervalMs: 5 * MINUTE,  paginated: false },
  assets:                     { group: 'character', minIntervalMs: 5 * MINUTE,  paginated: true  },
  corporation_assets:         { group: 'corporation', minIntervalMs: 5 * MINUTE, paginated: true },
  blueprints:                 { group: 'character', minIntervalMs: 5 * MINUTE,  paginated: true  },
  corporation_blueprints:     { group: 'corporation', minIntervalMs: 5 * MINUTE, paginated: true },
  corporation_divisions:      { group: 'corporation', minIntervalMs: 5 * MINUTE, paginated: false },

  // Universe / market (no per-character token)
  market_orders:              { group: 'market',   minIntervalMs: 5 * MINUTE,  paginated: true  },
  market_history:             { group: 'market',   minIntervalMs: 5 * MINUTE,  paginated: false },
  adjusted_prices:            { group: 'market',   minIntervalMs: 5 * MINUTE,  paginated: false },
  cost_indices:               { group: 'market',   minIntervalMs: 5 * MINUTE,  paginated: false },
  server_status:              { group: 'universe', minIntervalMs: 1 * MINUTE,  paginated: false },
};

/**
 * Tag an error with an ESI code (and optional characterId), preserving the message.
 */
function taggedError(message, code, characterId) {
  const err = new Error(message);
  err.code = code;
  if (characterId != null) err.characterId = characterId;
  return err;
}

/**
 * Parse an `expires` header into an epoch-ms timestamp, or null.
 */
function parseExpires(headers) {
  const raw = headers && headers.get ? headers.get('expires') : null;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Parse the X-Ratelimit-* headers and any Retry-After deadline.
 */
function parseRateLimit(headers, now) {
  const get = (h) => (headers && headers.get ? headers.get(h) : null);

  const remainingRaw = get('X-Ratelimit-Remaining');
  const resetRaw = get('X-Ratelimit-Reset'); // seconds until window reset (when present)
  const retryAfterRaw = get('Retry-After');

  const remaining = remainingRaw != null ? parseInt(remainingRaw, 10) : null;
  const resetAt = resetRaw != null && !Number.isNaN(parseInt(resetRaw, 10))
    ? now + parseInt(resetRaw, 10) * 1000
    : null;

  let retryAfterAt = null;
  if (retryAfterRaw != null) {
    const asInt = parseInt(retryAfterRaw, 10);
    if (!Number.isNaN(asInt)) {
      // Retry-After is delta-seconds in ESI's usage
      retryAfterAt = now + asInt * 1000;
    } else {
      const asDate = new Date(retryAfterRaw).getTime();
      if (Number.isFinite(asDate)) retryAfterAt = asDate;
    }
  }

  return {
    remaining: Number.isNaN(remaining) ? null : remaining,
    limit: get('X-Ratelimit-Limit'),
    group: get('X-Ratelimit-Group'),
    resetAt,
    retryAfterAt,
  };
}

/**
 * Network-error retry with exponential backoff. Replaces the 3 copies of
 * `retryFetch`. Unlike the old copies, this is only for transport-level
 * failures (thrown fetch errors) — HTTP 429/420 are NOT retried here; they are
 * surfaced so the caller records Retry-After and skips until the endpoint clears.
 */
async function fetchWithRetry(url, options, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      const delay = initialDelay * Math.pow(2, attempt);
      console.log(`[esiFetch] transport error (attempt ${attempt + 1}): ${error.message}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error(`Failed after ${maxRetries + 1} attempts: ${lastError.message}`);
}

/**
 * Ensure a fresh access token for an authenticated call. Folds in the
 * isTokenExpired -> refreshAccessToken -> updateCharacterTokens -> re-getCharacter
 * block. Returns the (possibly refreshed) character. Throws ESI_TOKEN_REFRESH_FAILED.
 */
async function ensureFreshToken(characterId, character) {
  let char = character || getCharacter(characterId);
  if (!char) {
    throw taggedError('Character not found', 'NOT_FOUND', characterId);
  }
  if (isTokenExpired(char.expiresAt)) {
    console.log('[esiFetch] Token expired, refreshing...');
    try {
      const newTokens = await refreshAccessToken(char.refreshToken);
      updateCharacterTokens(characterId, newTokens);
      char = getCharacter(characterId);
    } catch (refreshErr) {
      throw taggedError(refreshErr.message, 'ESI_TOKEN_REFRESH_FAILED', characterId);
    }
  }
  return char;
}

/**
 * Build the request URL with a page param appended (for the pagination loop).
 */
function withPage(url, page) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}page=${page}`;
}

/**
 * Central ESI fetch.
 *
 * @param {string} endpointType - Key into ENDPOINT_POLICY (e.g. 'industry_jobs')
 * @param {string} callKey - Status-tracker call key (e.g. 'character_123_industry_jobs')
 * @param {string} url - Fully-formed ESI URL (query params already applied, except `page`)
 * @param {Object} opts
 * @param {number} [opts.characterId] - Character ID (for authed calls)
 * @param {Object} [opts.character] - Pre-fetched character object (optional; else looked up)
 * @param {boolean} [opts.requiresAuth=true] - False for universe/market endpoints (no token)
 * @param {boolean} [opts.skipGate=false] - Bypass the pre-flight eligibility gate
 * @param {number} [opts.corporationId] - For status metadata
 * @param {Object} [opts.recordMetadata] - Extra fields for recordESICallStart metadata
 * @param {string} [opts.category] - Status category ('character' | 'corporation' | 'universe')
 * @param {string} [opts.endpointLabel] - Human label for the status row
 * @returns {Promise<Object>} On success: { data, cacheExpiresAt, nextAllowedAt, rateLimit, status, pages }.
 *   When gated: { skipped: true, reason, nextAllowedAt }.
 *   Throws tagged errors (ESI_TOKEN_REFRESH_FAILED, ESI_SCOPE_ERROR, ESI_RATE_LIMITED).
 *   Role-403 returns { data: [], roleForbidden: true } (caller maps to empty).
 */
async function esiFetch(endpointType, callKey, url, opts = {}) {
  const policy = ENDPOINT_POLICY[endpointType];
  if (!policy) {
    throw new Error(`[esiFetch] No ENDPOINT_POLICY entry for endpointType "${endpointType}"`);
  }

  const {
    characterId = null,
    character = null,
    requiresAuth = true,
    skipGate = false,
    corporationId = null,
    category = requiresAuth ? 'character' : 'universe',
    endpointLabel = endpointType,
    recordMetadata = {},
    // Market-style extras (opt-in): fetch pages 2..N concurrently, emit a
    // per-page progress callback, and treat certain HTTP statuses as
    // non-retryable "empty" results (e.g. 400/404 = item not on market).
    parallelPages = false,
    onProgress = null,
    emptyStatuses = [],
  } = opts;

  // Pre-flight gate — do not even record a start if we're not eligible.
  if (!skipGate && !canFetchEndpoint(callKey)) {
    return { skipped: true, reason: 'gated', nextAllowedAt: null };
  }

  recordESICallStart(callKey, {
    category,
    characterId,
    endpointType,
    endpointLabel,
    corporationId,
    ...recordMetadata,
  });

  const startTime = Date.now();

  try {
    // Resolve auth header (authed calls refresh the token first).
    let authHeader = null;
    if (requiresAuth) {
      const char = await ensureFreshToken(characterId, character);
      authHeader = `Bearer ${char.accessToken}`;
    }

    const baseHeaders = { 'User-Agent': getUserAgent() };
    if (authHeader) baseHeaders['Authorization'] = authHeader;

    let cacheExpiresAt = null;
    let rateLimit = null;

    // Fetch a single page/URL and return its parsed body plus the raw response
    // (needed for X-Pages / expires on the first page). Handles the shared error
    // taxonomy: 429/420 rate-limit, 403 scope-vs-role, and emptyStatuses.
    const fetchOne = async (pageUrl) => {
      const response = await fetchWithRetry(pageUrl, { headers: baseHeaders });
      const now = Date.now();
      rateLimit = parseRateLimit(response.headers, now);

      if (response.status === 429 || response.status === 420) {
        const retryAfterAt = rateLimit.retryAfterAt || (now + policy.minIntervalMs);
        recordRateLimit(callKey, { ...rateLimit, retryAfterAt });
        recordESICallSuccess(callKey, cacheExpiresAt, retryAfterAt, 0, startTime);
        throw taggedError(
          `ESI rate limited (${response.status}) on ${endpointType}`,
          'ESI_RATE_LIMITED',
          characterId
        );
      }

      // Caller-declared "expected empty" statuses (e.g. 400/404 not on market).
      if (emptyStatuses.includes(response.status)) {
        return { response, body: null, empty: true };
      }

      if (!response.ok) {
        if (response.status === 403) {
          const errorText = await response.text();
          const lower = errorText.toLowerCase();
          if (lower.includes('token not valid for scope') || lower.includes('invalid scope')) {
            throw taggedError(`ESI scope error: ${errorText}`, 'ESI_SCOPE_ERROR', characterId);
          }
          return { response, body: null, roleForbidden: true };
        }
        const errorText = await response.text();
        const errorMsg = `Failed to fetch ${endpointType}: ${response.status} ${errorText}`;
        recordESICallError(callKey, errorMsg, response.status.toString(), startTime);
        throw new Error(errorMsg);
      }

      return { response, body: await response.json(), empty: false };
    };

    // First page.
    const first = await fetchOne(policy.paginated ? withPage(url, 1) : url);
    let lastStatus = first.response.status;

    if (first.empty) {
      // Expected-empty (e.g. item not on market): record success, return [].
      recordESICallSuccess(callKey, null, null, 0, startTime);
      return { data: [], empty: true, status: lastStatus };
    }
    if (first.roleForbidden) {
      // Role-based 403 — expected; return empty silently.
      recordESICallSuccess(callKey, null, null, 0, startTime);
      return { data: [], roleForbidden: true, status: 403 };
    }

    cacheExpiresAt = parseExpires(first.response.headers);
    let totalPages = 1;
    if (policy.paginated) {
      const xPages = first.response.headers.get ? first.response.headers.get('X-Pages') : null;
      if (xPages) totalPages = parseInt(xPages, 10) || 1;
    }

    let allData;
    if (Array.isArray(first.body)) {
      allData = [...first.body];

      if (policy.paginated && totalPages > 1) {
        const fetchPage = async (p) => {
          const r = await fetchOne(withPage(url, p));
          if (onProgress) {
            try { onProgress({ currentPage: p, totalPages, progress: (p / totalPages) * 100 }); } catch (_) { /* ignore */ }
          }
          return (r.body && Array.isArray(r.body)) ? r.body : [];
        };

        if (parallelPages) {
          // Fetch pages 2..N concurrently; a failed page yields [] (tolerated).
          const promises = [];
          for (let p = 2; p <= totalPages; p++) {
            promises.push(fetchPage(p).catch((err) => {
              // Propagate rate-limit/scope errors; swallow per-page transient failures.
              if (err.code === 'ESI_RATE_LIMITED' || err.code === 'ESI_SCOPE_ERROR') throw err;
              console.error(`[esiFetch] page fetch failed for ${endpointType}: ${err.message}`);
              return [];
            }));
          }
          const pages = await Promise.all(promises);
          pages.forEach(pg => { allData = allData.concat(pg); });
        } else {
          for (let p = 2; p <= totalPages; p++) {
            allData = allData.concat(await fetchPage(p));
          }
        }
      }
    } else {
      // Non-array payload (e.g. server status, skills) — single response.
      allData = first.body;
    }

    const now = Date.now();
    const nextAllowedAt = Math.max(
      cacheExpiresAt || 0,
      now + policy.minIntervalMs,
      rateLimit && rateLimit.retryAfterAt ? rateLimit.retryAfterAt : 0
    );

    if (rateLimit) recordRateLimit(callKey, rateLimit);

    const responseSize = JSON.stringify(allData).length;
    recordESICallSuccess(callKey, cacheExpiresAt, nextAllowedAt, responseSize, startTime);

    return {
      data: allData,
      cacheExpiresAt,
      nextAllowedAt,
      rateLimit,
      status: lastStatus,
      pages: totalPages,
    };
  } catch (error) {
    // Preserve tagged errors for callers/IPC to broadcast; record network errors.
    if (
      error.code === 'ESI_TOKEN_REFRESH_FAILED' ||
      error.code === 'ESI_SCOPE_ERROR' ||
      error.code === 'ESI_RATE_LIMITED' ||
      error.code === 'NOT_FOUND'
    ) {
      throw error;
    }
    if (!error.message.includes('Failed to fetch')) {
      recordESICallError(callKey, error.message, 'NETWORK_ERROR', startTime);
    }
    throw error;
  }
}

module.exports = {
  esiFetch,
  canFetchEndpoint,
  ENDPOINT_POLICY,
  // exported for unit tests
  parseRateLimit,
  parseExpires,
};
