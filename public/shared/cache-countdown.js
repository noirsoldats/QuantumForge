/**
 * ESI cache countdown for "Refresh" buttons.
 *
 * The blueprints and skills screens each polled `getCacheStatus` over IPC
 * **once per second** purely to decrement a displayed clock ("Cached (4m 32s)").
 * That is 3600 IPC round-trips an hour, per open window, to render a number the
 * renderer can compute itself: the handler already returns an absolute
 * `expiresAt`.
 *
 * This fetches the expiry once, ticks locally, and re-fetches only when the main
 * process reports that the underlying data actually changed.
 */

(function () {
  'use strict';

  /**
   * Format a remaining duration the way the refresh buttons already did.
   * @param {number} seconds
   * @returns {string}
   */
  function formatRemaining(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(s / 60);
    const rem = s % 60;
    return mins > 0 ? `${mins}m ${rem}s` : `${rem}s`;
  }

  /**
   * Set a button's label without destroying its icon, creating the span if a
   * legacy `innerHTML` write removed it.
   * @param {HTMLElement} btn
   * @param {string} text
   */
  function setLabel(btn, text) {
    if (!btn) return;
    let label = btn.querySelector('.btn-label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'btn-label';
      btn.appendChild(label);
    }
    label.textContent = text;
  }

  /**
   * Keep a refresh button in sync with an ESI cache window.
   *
   * @param {Object} config
   * @param {() => Promise<{isCached: boolean, expiresAt: number|null}>} config.getStatus
   *   Reads cache status over IPC. Called on start, on data-change events, and
   *   when the window lapses - NOT on every tick.
   * @param {(state: {cached: boolean, label: string, remaining: number}) => void} config.render
   *   Applies the state to the DOM.
   * @param {string[]} [config.endpointTypes]
   *   Only re-fetch when an `esi:data-changed` event names one of these
   *   endpointTypes. Omit to re-fetch on any change.
   * @param {number} [config.tickMs=1000]
   * @returns {() => void} dispose
   */
  function attach(config) {
    const { getStatus, render, endpointTypes = null, tickMs = 1000 } = config;

    let expiresAt = null;
    let disposed = false;
    const disposers = [];

    /** Re-read the authoritative expiry over IPC. */
    async function sync() {
      if (disposed) return;
      try {
        const status = await getStatus();
        expiresAt = status && status.isCached ? status.expiresAt : null;
        paint();
      } catch (error) {
        console.error('[cache-countdown] failed to read cache status:', error);
        expiresAt = null;
        paint();
      }
    }

    /** Render from the local clock - no IPC. */
    function paint() {
      if (disposed) return;
      const remaining = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;
      const cached = remaining > 0;
      render({ cached, remaining, label: formatRemaining(remaining) });

      // The window just lapsed: confirm with the main process once, rather than
      // trusting a local clock that may have drifted.
      if (expiresAt && !cached) {
        expiresAt = null;
        sync();
      }
    }

    const id = window.setInterval(paint, tickMs);
    disposers.push(() => window.clearInterval(id));

    // Re-sync when the data behind the cache actually changes.
    const api = window.electronAPI && window.electronAPI.data;
    if (api && api.onChanged) {
      disposers.push(api.onChanged((info) => {
        if (!endpointTypes) return sync();
        if (info && endpointTypes.includes(info.endpointType)) sync();
      }));
    }

    sync();

    return function dispose() {
      disposed = true;
      disposers.forEach((d) => {
        try { d(); } catch (_) { /* already gone */ }
      });
      disposers.length = 0;
    };
  }

  window.QFCacheCountdown = { attach, formatRemaining, setLabel };
})();
