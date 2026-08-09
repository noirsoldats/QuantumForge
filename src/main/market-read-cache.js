/**
 * Per-calculation cache for market-data DATABASE READS.
 *
 * The problem this solves, measured on a Cerberus invention run:
 * `findBestDecryptor` evaluates 9 options (8 decryptors + none), each calling
 * `calculateManufacturingCost` twice, each pricing ~11 materials - roughly 198
 * calls to `calculateRealisticPrice`, of which only ~11 are for DISTINCT
 * items. The other ~187 re-read the same order book from SQLite and recompute
 * the same aggregates, microseconds apart.
 *
 * WHY THIS CACHES READS AND NOT PRICES
 * ------------------------------------
 * The obvious fix - memoise `calculateRealisticPrice` - needs a key covering
 * every input that changes the answer: quantity, priceMethod, percentile,
 * minVolume, priceModifier, priceType, skipHistory, location... The more of
 * those go into the key, the fewer calls actually collide, and the less the
 * cache does. Quantity alone nearly kills it: the two
 * `calculateManufacturingCost` calls per option deliberately price the same
 * materials at DIFFERENT quantities (ME rounding is applied per run-batch, so
 * a 5-run batch is not 5x a 1-run batch and must be calculated separately).
 *
 * But every one of those variables is applied AFTER the fetch, as arithmetic
 * over the same fetched arrays. The expensive part - the SQLite read - depends
 * only on (regionId, typeId, locationFilter). So caching one layer down gives
 * a tiny key, a high hit rate, and leaves every price calculation genuinely
 * recomputed. A 5-run batch and a 1-run batch share the order book and still
 * get their own VWAP.
 *
 * LIFETIME
 * --------
 * A session lasts ONE calculation. It is opened at the start, closed at the
 * end, and never survives to the next - so a cached read can never be served
 * to a later calculation, and a market refresh between two calculations is
 * always seen. There is deliberately no TTL and no invalidation hook: a cache
 * that cannot outlive the operation that created it needs neither.
 *
 * Nesting is reference-counted, so an inner `withPriceCache` inside an outer
 * one shares the outer session rather than tearing it down early.
 */

/**
 * Sessions live in async context, NOT in a module-level variable.
 *
 * This matters because several windows can run the same tool at once - two
 * Manufacturing Summaries, or a popped-out What Can I Build? alongside one in
 * the main window. A single shared variable made those calculations join each
 * OTHER's session: the second caller saw `session` set, treated itself as
 * nested, and inherited the first one's cached reads. Since a market refresh
 * can land between two windows' runs, that let one window serve another stale
 * order books - the exact failure the per-calculation lifetime exists to
 * prevent. The mismatched depth counting on completion was the second bug.
 *
 * `AsyncLocalStorage` scopes the session to the async call tree that opened it,
 * so it survives the `await`/`setImmediate` yields the engines use for
 * cancellation while staying invisible to every other caller.
 *
 * Still not threaded through the call chain: `calculateRealisticPrice` has 27
 * call sites across 6 files and the reads happen several frames below them, so
 * passing a cache object down every intermediate signature would be far more
 * invasive than the problem warrants - and one missed site would silently lose
 * caching.
 */
const { AsyncLocalStorage } = require('async_hooks');

const sessionStore = new AsyncLocalStorage();

/** The session for the CURRENT async context, or null. */
function currentSession() {
  return sessionStore.getStore() || null;
}

/** Stats for the current session, surfaced for logging and tests. */
function emptyStats() {
  return { orderHits: 0, orderMisses: 0, historyHits: 0, historyMisses: 0 };
}

/**
 * Run `fn` with a read cache active.
 *
 * @param {Function} fn  async () => T
 * @param {string} [label]  identifies the calculation in the summary log
 * @returns {Promise<T>}
 */
async function withPriceCache(fn, label = 'calculation') {
  // A genuinely nested call - one operation calling another that also opens a
  // session - joins the outer one. Because the store is async-scoped, this can
  // only be a call INSIDE the same operation; a different window's concurrent
  // calculation has its own context and never lands here.
  const existing = currentSession();
  if (existing) return fn();

  const session = {
    label,
    orders: new Map(),
    history: new Map(),
    stats: emptyStats(),
    startedAt: Date.now(),
  };

  return sessionStore.run(session, async () => {
    try {
      return await fn();
    } finally {
      const { stats, startedAt } = session;
      const hits = stats.orderHits + stats.historyHits;
      const misses = stats.orderMisses + stats.historyMisses;
      if (hits + misses > 0) {
        console.log(
          `[Price Cache] ${label}: ${hits} hits, ${misses} reads ` +
            `(${Math.round((hits / (hits + misses)) * 100)}% avoided) in ${Date.now() - startedAt}ms`
        );
      }
      // Nothing to null out: the store is discarded with the async context, so
      // the cache cannot outlive its calculation even if something throws.
    }
  });
}

/** True when a session is active in the current async context. */
function isActive() {
  return currentSession() !== null;
}

/**
 * Key for an order-book read.
 *
 * `locationFilter` is part of the read - it becomes a WHERE clause - so two
 * calls differing only by station must not share an entry.
 */
function orderKey(regionId, typeId, locationFilter) {
  const loc = locationFilter
    ? `${locationFilter.stationId || ''}:${locationFilter.systemId || ''}`
    : '';
  return `${regionId}|${typeId == null ? 'all' : typeId}|${loc}`;
}

function historyKey(regionId, typeId, days) {
  return `${regionId}|${typeId}|${days == null ? 'all' : days}`;
}

/**
 * Memoise an order-book read for the current session.
 *
 * With no session active this is a straight pass-through, so callers outside a
 * calculation are completely unaffected.
 *
 * @param {Function} read  () => orders[]  the real database read
 */
function cachedOrders(regionId, typeId, locationFilter, read) {
  const session = currentSession();
  if (!session) return read();

  const key = orderKey(regionId, typeId, locationFilter);
  if (session.orders.has(key)) {
    session.stats.orderHits += 1;
    return session.orders.get(key).slice();
  }

  session.stats.orderMisses += 1;
  const value = read();
  session.orders.set(key, value);
  // A COPY, never the cached array itself. Callers sort and filter these -
  // today always on a `filter()` result, but handing out the cached array
  // makes an in-place `.sort()` in future code corrupt every later hit, which
  // would surface as wrong prices with nothing pointing back to this cache.
  return value.slice();
}

/** Memoise a history read for the current session. */
function cachedHistory(regionId, typeId, days, read) {
  const session = currentSession();
  if (!session) return read();

  const key = historyKey(regionId, typeId, days);
  if (session.history.has(key)) {
    session.stats.historyHits += 1;
    return session.history.get(key).slice();
  }

  session.stats.historyMisses += 1;
  const value = read();
  session.history.set(key, value);
  return value.slice();
}

/** Current session's stats, or null. Used by tests and diagnostics. */
function getStats() {
  const session = currentSession();
  return session ? { ...session.stats } : null;
}

/**
 * No-op, retained for callers that used to force a reset.
 *
 * A session now lives in its async context and is discarded with it, so there
 * is nothing global left to clear - and clearing another context's session was
 * never safe anyway once more than one window could be calculating.
 */
function reset() {
  /* nothing to do - see the note above */
}

module.exports = {
  withPriceCache,
  cachedOrders,
  cachedHistory,
  isActive,
  getStats,
  reset,
};
