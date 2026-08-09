/**
 * Data freshness — one threshold scheme for the whole app.
 *
 * Before this, four screens each computed staleness their own way, with four
 * different thresholds and three different DOM patterns:
 *
 *   manufacturing-summary-renderer.js   2h warn / 6h stale
 *   loot-analyzer-renderer.js           2h warn / 6h stale
 *   market-renderer.js                  1h fresh / 3h stale
 *   settings-renderer.js                1h stale
 *
 * Worse, all of them computed it ONCE at load, so a warning never cleared even
 * after a refresh landed. `subscribe()` below fixes that half: it re-evaluates
 * whenever the main process reports new data.
 *
 * Thresholds are deliberately shared: if market data is "stale" on one screen it
 * is stale on all of them.
 */

(function () {
  'use strict';

  /** Fresh below this age. */
  const WARN_MS = 60 * 60 * 1000;   // 1 hour
  /** Stale at or above this age. */
  const STALE_MS = 3 * 60 * 60 * 1000; // 3 hours

  /**
   * Classify a timestamp.
   *
   * @param {number|string|Date|null} lastFetch
   * @returns {{level: 'none'|'fresh'|'warn'|'stale', ageMs: number|null, label: string}}
   *   `level: 'none'` means there is no data at all - distinct from stale data,
   *   and usually worth different wording.
   */
  function getFreshness(lastFetch) {
    if (lastFetch === null || lastFetch === undefined || lastFetch === '') {
      return { level: 'none', ageMs: null, label: 'Never' };
    }

    const ts = lastFetch instanceof Date ? lastFetch.getTime() : Number(new Date(lastFetch).getTime());
    if (!Number.isFinite(ts)) {
      return { level: 'none', ageMs: null, label: 'Never' };
    }

    const ageMs = Date.now() - ts;
    if (ageMs < 0) {
      // Clock skew or a future timestamp - treat as just-fetched.
      return { level: 'fresh', ageMs: 0, label: 'Just now' };
    }

    const level = ageMs < WARN_MS ? 'fresh' : ageMs < STALE_MS ? 'warn' : 'stale';
    return { level, ageMs, label: formatAge(ageMs) };
  }

  /**
   * Human-readable age. Kept here so every screen words it identically.
   * @param {number} ms
   * @returns {string}
   */
  function formatAge(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '--';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  /**
   * Re-evaluate freshness whenever the main process reports new data.
   *
   * This is what stops a staleness warning from being stuck at load-time truth.
   * The callback also fires immediately, so callers do not have to render once
   * themselves and then subscribe.
   *
   * @param {() => (number|string|Date|null) | Promise<number|string|Date|null>} getTimestamp
   *   Re-read the timestamp. Must re-query rather than close over a cached
   *   value, or the recomputation is meaningless.
   * @param {(state: {level: string, ageMs: number|null, label: string}) => void} onChange
   * @param {Object} [options]
   * @param {boolean} [options.market=true]  React to market:data-changed.
   * @param {boolean} [options.esi=false]    React to every esi:data-changed.
   * @param {boolean} [options.cycle=true]   React to esi:cycle-complete.
   * @param {number}  [options.tickMs=60000] Re-render cadence so a displayed age
   *   ("2h 14m") keeps counting up between events. 0 disables.
   * @returns {() => void} dispose
   */
  function subscribe(getTimestamp, onChange, options = {}) {
    const { market = true, esi = false, cycle = true, tickMs = 60000 } = options;
    const disposers = [];
    let disposed = false;

    const evaluate = async () => {
      if (disposed) return;
      try {
        const ts = await getTimestamp();
        if (!disposed) onChange(getFreshness(ts));
      } catch (error) {
        console.error('[freshness] failed to read timestamp:', error);
      }
    };

    const api = window.electronAPI && window.electronAPI.data;
    if (api) {
      if (market && api.onMarketChanged) disposers.push(api.onMarketChanged(evaluate));
      if (cycle && api.onCycleComplete) disposers.push(api.onCycleComplete(evaluate));
      if (esi && api.onChanged) disposers.push(api.onChanged(evaluate));
    }

    if (tickMs > 0) {
      const id = window.setInterval(evaluate, tickMs);
      disposers.push(() => window.clearInterval(id));
    }

    evaluate();

    return function dispose() {
      disposed = true;
      disposers.forEach((d) => {
        try { d(); } catch (_) { /* already gone */ }
      });
      disposers.length = 0;
    };
  }

  window.QFFreshness = {
    WARN_MS,
    STALE_MS,
    getFreshness,
    formatAge,
    subscribe,
  };
})();
