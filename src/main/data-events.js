/**
 * Data-change event bus (main process).
 *
 * The app had no way to tell an open window that data had changed. Every
 * `webContents.send` was splash progress, an updater notification, a one-shot
 * character-ID handoff, or a progress bar on a user-initiated fetch. So a
 * screen that computed "market data is 3h old" at load time kept saying that
 * forever, even after a refresh landed.
 *
 * This is the single place that knows when data changed. Emitters call it from
 * the chokepoints; `registerDataEventBroadcast()` forwards everything to every
 * renderer frame in every window.
 *
 * Channels
 * --------
 *   esi:data-changed    One ESI endpoint was fetched successfully.
 *                       { endpointType, callKey, characterId, corporationId, category, at }
 *   esi:cycle-complete  The background refresh cycle finished a pass.
 *                       { characters, corporations, errors, finishedAt, ... }
 *   market:data-changed Market data for one or more regions was refreshed.
 *                       { regionIds, scope, at }
 *   settings:changed    A settings category was written.
 *                       { category, keys, updates, at }
 */

const { EventEmitter } = require('events');

const bus = new EventEmitter();
// Many windows x many frames can listen; the default limit of 10 is too low and
// its warning would be noise.
bus.setMaxListeners(0);

const CHANNELS = {
  ESI_DATA_CHANGED: 'esi:data-changed',
  ESI_CYCLE_COMPLETE: 'esi:cycle-complete',
  MARKET_DATA_CHANGED: 'market:data-changed',
  SETTINGS_CHANGED: 'settings:changed',
};

/**
 * A single ESI endpoint was fetched successfully.
 * Called from esi-fetch.js right after the call is recorded, so it covers every
 * successful fetch in the app without per-caller plumbing.
 *
 * @param {Object} info
 * @param {string} info.endpointType
 * @param {string} info.callKey
 * @param {number|null} [info.characterId]
 * @param {number|null} [info.corporationId]
 * @param {string} [info.category]
 */
function emitDataChanged(info) {
  bus.emit(CHANNELS.ESI_DATA_CHANGED, { ...info, at: Date.now() });
}

/**
 * The background refresh cycle finished.
 * `esi-background-refresh.js` already builds this summary and used to discard
 * it - the callers only had a `.catch()`.
 * @param {Object} summary
 */
function emitCycleComplete(summary) {
  bus.emit(CHANNELS.ESI_CYCLE_COMPLETE, { ...summary, at: Date.now() });
}

/**
 * Market data changed for one or more regions.
 * @param {Object} info
 * @param {number[]} [info.regionIds]
 * @param {string} [info.scope]  e.g. 'orders' | 'history' | 'all'
 */
function emitMarketChanged(info = {}) {
  bus.emit(CHANNELS.MARKET_DATA_CHANGED, {
    regionIds: info.regionIds || [],
    scope: info.scope || 'all',
    at: Date.now(),
  });
}

/**
 * A settings category was written.
 *
 * Emitted from the `settings:update` handler, which is the single chokepoint
 * every write passes through, so this covers the whole app without per-caller
 * plumbing.
 *
 * `keys` is carried alongside `updates` so a listener can cheaply ask "did the
 * thing I care about change?" without inspecting values. Note `settings:update`
 * merges only ONE level deep, so `keys` are the top-level keys of that
 * category's update - not a deep diff.
 *
 * @param {Object} info
 * @param {string} info.category   e.g. 'general', 'market'
 * @param {Object} [info.updates]  the patch that was applied
 */
function emitSettingsChanged(info = {}) {
  const updates = info.updates || {};
  bus.emit(CHANNELS.SETTINGS_CHANGED, {
    category: info.category,
    keys: Object.keys(updates),
    updates,
    at: Date.now(),
  });
}

/**
 * Forward every bus event to every renderer frame in every window.
 *
 * Call once during app startup, AFTER the broadcast helper is available.
 * Uses broadcast() (not webContents.send) so framed legacy views receive
 * events too - a plain send reaches only the main frame and fails silently.
 */
function registerDataEventBroadcast() {
  const { broadcast } = require('./broadcast');

  // The error-budget governor has its own emitter. Forward it on the same
  // path so a renderer can warn the user - and name the offending endpoint -
  // instead of the app silently going quiet.
  try {
    const errorBudget = require('./esi-error-budget');
    errorBudget.bus.on('low', (payload) => broadcast('esi:budget-low', payload));
    errorBudget.bus.on('blocked', (payload) => broadcast('esi:budget-blocked', payload));
  } catch (error) {
    console.error('[data-events] could not wire the error budget:', error);
  }
  Object.values(CHANNELS).forEach((channel) => {
    bus.on(channel, (payload) => broadcast(channel, payload));
  });
}

module.exports = {
  bus,
  CHANNELS,
  emitDataChanged,
  emitCycleComplete,
  emitMarketChanged,
  emitSettingsChanged,
  registerDataEventBroadcast,
};
