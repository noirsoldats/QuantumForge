/**
 * Preload subscription contract.
 *
 * Every `on*` method on `electronAPI` MUST return an unsubscribe function.
 *
 * Why this matters: the application shell mounts and unmounts views inside a
 * single document. A subscription with no disposer accumulates, so mounting a
 * view twice makes its handler fire twice per event (a doubled progress bar, a
 * doubled refresh). The old page-per-navigation model hid this because every
 * navigation destroyed the document; the persistent shell does not.
 *
 * These tests load the real preload with `electron` mocked, capture what it
 * passes to contextBridge, and exercise the contract.
 */

const path = require('path');

const PRELOAD = path.join(__dirname, '../../src/preload/preload.js');

/** Load preload.js against a mock electron and return the exposed API. */
function loadPreload() {
  const listeners = new Map(); // channel -> handler[]
  let exposed = null;

  const ipcRenderer = {
    on: jest.fn((channel, handler) => {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(handler);
    }),
    removeListener: jest.fn((channel, handler) => {
      const arr = listeners.get(channel) || [];
      const i = arr.indexOf(handler);
      if (i !== -1) arr.splice(i, 1);
    }),
    removeAllListeners: jest.fn((channel) => listeners.set(channel, [])),
    invoke: jest.fn(() => Promise.resolve()),
    send: jest.fn(),
  };

  jest.isolateModules(() => {
    jest.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
      ipcRenderer,
    }));
    require(PRELOAD);
  });

  const emit = (channel, ...args) => {
    (listeners.get(channel) || []).slice().forEach((h) => h({}, ...args));
  };
  const countFor = (channel) => (listeners.get(channel) || []).length;

  return { api: exposed, ipcRenderer, emit, countFor, listeners };
}

/** Walk the API and collect every `on*` function as [path, fn]. */
function collectSubscriptions(api) {
  const found = [];
  Object.entries(api).forEach(([nsName, ns]) => {
    if (!ns || typeof ns !== 'object') return;
    Object.entries(ns).forEach(([key, value]) => {
      if (typeof value === 'function' && /^on[A-Z]/.test(key)) {
        found.push([`${nsName}.${key}`, value]);
      }
    });
  });
  return found;
}

describe('preload subscription contract', () => {
  test('preload exposes an API', () => {
    const { api } = loadPreload();
    expect(api).toBeTruthy();
    expect(typeof api).toBe('object');
  });

  test('every on* method returns an unsubscribe function', () => {
    const { api } = loadPreload();
    const subs = collectSubscriptions(api);

    // Guard against the walker silently finding nothing.
    expect(subs.length).toBeGreaterThanOrEqual(20);

    const missing = [];
    subs.forEach(([name, fn]) => {
      const result = fn(() => {});
      if (typeof result !== 'function') missing.push(name);
    });

    expect(missing).toEqual([]);
  });

  test('the returned disposer actually removes the listener', () => {
    const { api, countFor } = loadPreload();

    const before = countFor('market:fetchProgress');
    const dispose = api.market.onFetchProgress(() => {});
    expect(countFor('market:fetchProgress')).toBe(before + 1);

    dispose();
    expect(countFor('market:fetchProgress')).toBe(before);
  });

  test('mount -> unmount -> mount leaves exactly ONE live handler', () => {
    // This is the duplicate-subscription regression the shell is exposed to.
    const { api, emit } = loadPreload();
    const calls = [];

    const disposeA = api.market.onFetchProgress((p) => calls.push(`A:${p}`));
    disposeA();
    const disposeB = api.market.onFetchProgress((p) => calls.push(`B:${p}`));

    emit('market:fetchProgress', 42);

    expect(calls).toEqual(['B:42']);
    disposeB();
  });

  test('two concurrent subscribers both fire, and disposing one leaves the other', () => {
    const { api, emit } = loadPreload();
    const calls = [];

    const d1 = api.market.onFetchProgress((p) => calls.push(`one:${p}`));
    const d2 = api.market.onFetchProgress((p) => calls.push(`two:${p}`));

    emit('market:fetchProgress', 1);
    expect(calls).toEqual(['one:1', 'two:1']);

    // Disposing one subscriber must NOT tear down the other - this is why
    // removeListener is used rather than removeAllListeners.
    d1();
    calls.length = 0;
    emit('market:fetchProgress', 2);
    expect(calls).toEqual(['two:2']);

    d2();
  });

  test('callbacks receive the payload, not the IpcRendererEvent', () => {
    const { api, emit } = loadPreload();
    const received = [];

    const dispose = api.sde.onProgress((...args) => received.push(args));
    emit('sde:progress', { percent: 50 });
    dispose();

    expect(received).toHaveLength(1);
    expect(received[0][0]).toEqual({ percent: 50 });
  });

  test('disposing twice is safe', () => {
    const { api } = loadPreload();
    const dispose = api.app.onUpdateDownloaded(() => {});
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });

  test('window.onMaximizeChanged follows the same contract', () => {
    const { api, emit } = loadPreload();
    const seen = [];
    const dispose = api.window.onMaximizeChanged((s) => seen.push(s));

    emit('window:maximize-changed', { maximized: true });
    expect(seen).toEqual([{ maximized: true }]);

    dispose();
    emit('window:maximize-changed', { maximized: false });
    expect(seen).toHaveLength(1);
  });

  test('audit.onRecordAdded (the pre-existing reference impl) still conforms', () => {
    const { api, emit } = loadPreload();
    const records = [];
    const dispose = api.audit.onRecordAdded((r) => records.push(r));

    emit('audit:recordAdded', { id: 1 });
    expect(records).toEqual([{ id: 1 }]);

    dispose();
    emit('audit:recordAdded', { id: 2 });
    expect(records).toHaveLength(1);
  });
});
