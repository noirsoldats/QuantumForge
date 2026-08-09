/**
 * ESI error-budget governor.
 *
 * ESI enforces an ERROR limit that is separate from the rate limit: roughly
 * 100 errored requests per 60-second window, across the whole application.
 * Exceed it and ESI returns 420 for EVERYTHING - including calls that would
 * have succeeded - until the window resets.
 *
 * Every response carries the current state:
 *   X-ESI-Error-Limit-Remain  errors left in this window
 *   X-ESI-Error-Limit-Reset   seconds until the window resets
 *
 * Nothing read those headers before, so the app had no way to know it was
 * approaching the ceiling until it was already over. A screen that resolved
 * one structure per asset could burn the entire budget on 403s (no docking
 * access) and take the background refresh cycle down with it - which is
 * exactly what happened.
 *
 * This module keeps that state and answers one question: may a call go out?
 *
 * Two deliberate properties:
 *
 *   1. RESERVE. Calls are gated well above zero, not at the last error. The
 *      reserve exists so a user-initiated action still has budget when the
 *      background layer has been spending it.
 *   2. ATTRIBUTION. Errors are counted per endpoint so a repeat offender can
 *      be surfaced to the user with enough detail to report it, rather than
 *      the app silently degrading.
 */

const { EventEmitter } = require('events');

/** Errors that must remain before non-essential calls are refused. */
const RESERVE_THRESHOLD = 30;
/** Below this, even user-initiated calls are refused - 420 is imminent. */
const CRITICAL_THRESHOLD = 10;
/** Assumed window length when ESI does not tell us. */
const DEFAULT_WINDOW_MS = 60 * 1000;

const bus = new EventEmitter();
bus.setMaxListeners(0);

const state = {
  /** Errors left in the current window; null until ESI first tells us. */
  remaining: null,
  /** When the current window resets (epoch ms). */
  resetAt: null,
  /** Set when a 420 lands: nothing goes out until this passes. */
  blockedUntil: null,
  /** endpointType -> { count, lastMessage, lastAt, callKeys:Set } */
  offenders: new Map(),
  /** Whether we have already warned about the current low-budget episode. */
  warned: false,
};

/**
 * Record the error-limit headers from any ESI response.
 * @param {Headers} headers
 * @param {number} now
 */
function recordHeaders(headers, now = Date.now()) {
  const get = (h) => (headers && headers.get ? headers.get(h) : null);

  // Roll over FIRST, using the previous window's deadline. Doing this after
  // applying the new values would immediately discard them - the response we
  // are reading belongs to the new window, not the expired one.
  if (state.resetAt && now >= state.resetAt) resetWindow(now);

  const remainRaw = get('X-ESI-Error-Limit-Remain');
  const resetRaw = get('X-ESI-Error-Limit-Reset');

  if (remainRaw != null) {
    const remaining = parseInt(remainRaw, 10);
    if (!Number.isNaN(remaining)) state.remaining = remaining;
  }

  if (resetRaw != null) {
    const seconds = parseInt(resetRaw, 10);
    if (!Number.isNaN(seconds)) state.resetAt = now + seconds * 1000;
  }

  emitIfLow();
}

/** Note that a call errored, so the offender can be named later. */
function recordError(endpointType, callKey, message) {
  const key = endpointType || 'unknown';
  const entry = state.offenders.get(key)
    || { endpointType: key, count: 0, callKeys: new Set(), lastMessage: null, lastAt: null };

  entry.count += 1;
  entry.lastMessage = message || entry.lastMessage;
  entry.lastAt = Date.now();
  if (callKey) entry.callKeys.add(callKey);

  state.offenders.set(key, entry);
}

/**
 * A 420 landed. Stop everything until the window resets - continuing to call
 * only deepens the hole, since every refusal is itself an error.
 */
function recordBlocked(retryAfterAt, now = Date.now()) {
  state.blockedUntil = retryAfterAt || (now + DEFAULT_WINDOW_MS);
  state.remaining = 0;

  bus.emit('blocked', {
    until: state.blockedUntil,
    offenders: topOffenders(),
    at: now,
  });
}

function resetWindow(now = Date.now()) {
  state.remaining = null;
  state.resetAt = null;
  state.offenders.clear();
  state.warned = false;
  if (state.blockedUntil && now >= state.blockedUntil) state.blockedUntil = null;
}

/**
 * May a call go out?
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.userInitiated=false] - true when the user explicitly
 *   asked for this. Those keep going until the CRITICAL threshold, so the app
 *   does not refuse an action someone just took while a background sweep is
 *   spending the budget.
 * @returns {{ allowed: boolean, reason: string|null, remaining: number|null }}
 */
function canSpend(opts = {}) {
  const now = Date.now();

  if (state.blockedUntil) {
    if (now < state.blockedUntil) {
      return { allowed: false, reason: 'blocked', remaining: 0 };
    }
    resetWindow(now);
  }

  if (state.resetAt && now >= state.resetAt) resetWindow(now);

  // Nothing observed yet - let it through so the first call can tell us.
  if (state.remaining == null) {
    return { allowed: true, reason: null, remaining: null };
  }

  const floor = opts.userInitiated ? CRITICAL_THRESHOLD : RESERVE_THRESHOLD;
  if (state.remaining <= floor) {
    return {
      allowed: false,
      reason: opts.userInitiated ? 'critical' : 'reserved',
      remaining: state.remaining,
    };
  }

  return { allowed: true, reason: null, remaining: state.remaining };
}

/** Emit a warning the first time a window drops into the reserve. */
function emitIfLow() {
  if (state.warned) return;
  if (state.remaining == null || state.remaining > RESERVE_THRESHOLD) return;

  state.warned = true;
  bus.emit('low', {
    remaining: state.remaining,
    resetAt: state.resetAt,
    offenders: topOffenders(),
    at: Date.now(),
  });
}

/** The endpoints responsible for the most errors this window. */
function topOffenders(limit = 5) {
  return [...state.offenders.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((o) => ({
      endpointType: o.endpointType,
      count: o.count,
      // A couple of examples is enough to reproduce; the full set could be
      // thousands of ids.
      sampleCallKeys: [...o.callKeys].slice(0, 3),
      lastMessage: o.lastMessage,
      lastAt: o.lastAt,
    }));
}

/** Everything a user would need to report a problem. */
function getStatus() {
  return {
    remaining: state.remaining,
    resetAt: state.resetAt,
    blockedUntil: state.blockedUntil,
    reserveThreshold: RESERVE_THRESHOLD,
    criticalThreshold: CRITICAL_THRESHOLD,
    isLow: state.remaining != null && state.remaining <= RESERVE_THRESHOLD,
    isBlocked: !!(state.blockedUntil && Date.now() < state.blockedUntil),
    offenders: topOffenders(),
  };
}

/** Testing hook. */
function reset() {
  state.remaining = null;
  state.resetAt = null;
  state.blockedUntil = null;
  state.offenders.clear();
  state.warned = false;
}

module.exports = {
  bus,
  recordHeaders,
  recordError,
  recordBlocked,
  canSpend,
  getStatus,
  topOffenders,
  reset,
  RESERVE_THRESHOLD,
  CRITICAL_THRESHOLD,
};
