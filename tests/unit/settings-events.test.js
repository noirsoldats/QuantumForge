/**
 * settings:changed event
 *
 * Before this channel existed, a screen showing the state of a setting had no
 * way to learn it had been written in another window - the Audit Log polled
 * `getSummary()` every 5 seconds to notice a value that changes only on a user
 * toggle.
 *
 * `settings:update` is the single chokepoint every write passes through, so
 * one emit there covers the whole app. These guard the payload shape that
 * listeners filter on: a subscriber checks `category` and `keys` before doing
 * work, so getting either wrong makes every listener either deaf or
 * hyperactive.
 */

const path = require('path');

const DATA_EVENTS = path.join(__dirname, '../../src/main/data-events.js');

let dataEvents;

beforeEach(() => {
  jest.resetModules();
  dataEvents = require(DATA_EVENTS);
});

afterEach(() => {
  dataEvents.bus.removeAllListeners();
});

describe('emitSettingsChanged', () => {
  test('publishes on the settings:changed channel', () => {
    const seen = [];
    dataEvents.bus.on(dataEvents.CHANNELS.SETTINGS_CHANGED, (p) => seen.push(p));

    dataEvents.emitSettingsChanged({ category: 'general', updates: { auditModeEnabled: true } });

    expect(seen).toHaveLength(1);
    expect(seen[0].category).toBe('general');
  });

  test('carries the changed keys so listeners can filter cheaply', () => {
    const seen = [];
    dataEvents.bus.on(dataEvents.CHANNELS.SETTINGS_CHANGED, (p) => seen.push(p));

    dataEvents.emitSettingsChanged({
      category: 'general',
      updates: { auditModeEnabled: true, theme: 'dark' },
    });

    expect(seen[0].keys).toEqual(['auditModeEnabled', 'theme']);
  });

  test('carries the values too, so a listener need not re-read settings', () => {
    const seen = [];
    dataEvents.bus.on(dataEvents.CHANNELS.SETTINGS_CHANGED, (p) => seen.push(p));

    dataEvents.emitSettingsChanged({
      category: 'general',
      updates: { auditModeEnabled: false },
    });

    expect(seen[0].updates).toEqual({ auditModeEnabled: false });
  });

  test('stamps the time', () => {
    const seen = [];
    dataEvents.bus.on(dataEvents.CHANNELS.SETTINGS_CHANGED, (p) => seen.push(p));

    const before = Date.now();
    dataEvents.emitSettingsChanged({ category: 'market', updates: {} });

    expect(seen[0].at).toBeGreaterThanOrEqual(before);
  });

  test('an absent updates object yields empty keys, not a throw', () => {
    const seen = [];
    dataEvents.bus.on(dataEvents.CHANNELS.SETTINGS_CHANGED, (p) => seen.push(p));

    expect(() => dataEvents.emitSettingsChanged({ category: 'general' })).not.toThrow();
    expect(seen[0].keys).toEqual([]);
  });

  test('called with nothing at all does not throw', () => {
    expect(() => dataEvents.emitSettingsChanged()).not.toThrow();
  });
});

describe('broadcast registration', () => {
  test('settings:changed is forwarded to renderers like every other channel', () => {
    // A channel that is emitted but never registered for broadcast reaches the
    // main process only - the exact silent failure this bus exists to avoid.
    jest.resetModules();

    const sent = [];
    jest.doMock(path.join(__dirname, '../../src/main/broadcast.js'), () => ({
      broadcast: (channel, payload) => sent.push({ channel, payload }),
      sendToWindow: () => {},
    }));

    const de = require(DATA_EVENTS);
    de.registerDataEventBroadcast();
    de.emitSettingsChanged({ category: 'general', updates: { auditModeEnabled: true } });

    expect(sent.map((s) => s.channel)).toContain('settings:changed');
    expect(sent.find((s) => s.channel === 'settings:changed').payload.category).toBe('general');

    de.bus.removeAllListeners();
    jest.dontMock(path.join(__dirname, '../../src/main/broadcast.js'));
  });

  test('every declared channel is registered for broadcast', () => {
    jest.resetModules();

    const sent = [];
    jest.doMock(path.join(__dirname, '../../src/main/broadcast.js'), () => ({
      broadcast: (channel) => sent.push(channel),
      sendToWindow: () => {},
    }));

    const de = require(DATA_EVENTS);
    de.registerDataEventBroadcast();

    // Emit on each channel directly; anything unregistered simply never
    // reaches broadcast.
    Object.values(de.CHANNELS).forEach((channel) => de.bus.emit(channel, {}));

    Object.values(de.CHANNELS).forEach((channel) => {
      expect(sent).toContain(channel);
    });

    de.bus.removeAllListeners();
    jest.dontMock(path.join(__dirname, '../../src/main/broadcast.js'));
  });
});
