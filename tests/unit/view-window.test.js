/**
 * Generic view-window host.
 *
 * ONE module opens every screen that gets its own window. This is deliberately
 * not a per-screen `<x>-window.js` - ten of those had accumulated, each
 * hand-rolling the same BrowserWindow boilerplate against a bespoke page, and
 * that is the legacy pattern this migration replaces.
 *
 * Every window loads the SAME shell document with
 * `?role=standalone&view=<id>&params=<json>`, so a windowed screen runs the
 * identical view code it runs mounted in the main window. That is what makes
 * the upcoming pop-out feature universal: any registered view is poppable with
 * no new main-process code.
 *
 * The identity rule - windows keyed on (viewId, params) - is what pop-out needs
 * so "Assets for character A" and "Assets for character B" are two windows
 * while a repeat request focuses the existing one.
 */

const created = [];

jest.mock('../../src/main/window-factory', () => ({
  createAppWindow: jest.fn((config) => {
    const listeners = {};
    const win = {
      config,
      destroyed: false,
      minimized: false,
      focused: false,
      isDestroyed: () => win.destroyed,
      isMinimized: () => win.minimized,
      restore: () => { win.minimized = false; },
      focus: () => { win.focused = true; },
      close: () => {
        win.destroyed = true;
        (listeners.closed || []).forEach((fn) => fn());
      },
      on: (event, fn) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
      },
    };
    created.push(win);
    return win;
  }),
  PRELOAD: '/preload.js',
}));

jest.mock('electron', () => ({
  app: { getVersion: () => '0.11.0' },
}));

// Opening or closing a view window announces the new set to every renderer, so
// rails can mark popped tools. Captured rather than stubbed silently: the
// announcements are part of the contract and are asserted below.
const announcements = [];
jest.mock('../../src/main/broadcast', () => ({
  broadcast: (channel, payload) => announcements.push({ channel, payload }),
  sendToWindow: () => {},
}));

const viewWindow = require('../../src/main/view-window');
const { createAppWindow } = require('../../src/main/window-factory');

beforeEach(() => {
  created.length = 0;
  announcements.length = 0;
  jest.clearAllMocks();
  viewWindow.closeAllViewWindows();
});

describe('what the window actually loads', () => {
  test('loads the shell host, not a per-screen page', () => {
    // A bespoke page per screen is exactly what this replaces.
    viewWindow.openViewWindow('assets', { characterId: 42 });

    expect(created[0].config.file).toBe('index.html');
  });

  test('passes role, view and params so the shell mounts the right view', () => {
    viewWindow.openViewWindow('assets', { characterId: 42 });

    expect(created[0].config.query).toEqual({
      role: 'standalone',
      view: 'assets',
      params: JSON.stringify({ characterId: 42 }),
    });
  });

  test('uses the standalone role, so the window has no activity rail', () => {
    // Only the main window carries the rail; that is what makes "which window
    // is home" unambiguous.
    viewWindow.openViewWindow('assets', {});

    expect(created[0].config.query.role).toBe('standalone');
  });

  test('uses the shell chrome', () => {
    viewWindow.openViewWindow('assets', {});
    expect(created[0].config.shell).toBe(true);
  });

  test('works for ANY view id without per-screen code', () => {
    // The whole point: a newly registered view is instantly poppable.
    viewWindow.openViewWindow('market', {});
    viewWindow.openViewWindow('blueprint-calculator', { blueprintTypeId: 1 });

    expect(created.map((w) => w.config.query.view))
      .toEqual(['market', 'blueprint-calculator']);
  });
});

describe('window identity: (viewId, params)', () => {
  test('the same view with the same params focuses rather than duplicating', () => {
    viewWindow.openViewWindow('assets', { characterId: 42 });
    viewWindow.openViewWindow('assets', { characterId: 42 });

    expect(createAppWindow).toHaveBeenCalledTimes(1);
    expect(created[0].focused).toBe(true);
  });

  test('the same view with DIFFERENT params is a separate window', () => {
    // Assets for two characters must be two windows.
    viewWindow.openViewWindow('assets', { characterId: 42 });
    viewWindow.openViewWindow('assets', { characterId: 99 });

    expect(createAppWindow).toHaveBeenCalledTimes(2);
  });

  test('param ORDER does not create a duplicate', () => {
    // Without canonical key ordering, property order alone would spawn a second
    // window for the same logical target.
    viewWindow.openViewWindow('assets', { characterId: 42, tab: 'corp' });
    viewWindow.openViewWindow('assets', { tab: 'corp', characterId: 42 });

    expect(createAppWindow).toHaveBeenCalledTimes(1);
  });

  test('a minimized window is restored, not left minimized', () => {
    viewWindow.openViewWindow('assets', { characterId: 42 });
    created[0].minimized = true;

    viewWindow.openViewWindow('assets', { characterId: 42 });

    expect(created[0].minimized).toBe(false);
    expect(created[0].focused).toBe(true);
  });

  test('reopening after close creates a fresh window', () => {
    viewWindow.openViewWindow('assets', { characterId: 42 });
    created[0].close();

    viewWindow.openViewWindow('assets', { characterId: 42 });

    expect(createAppWindow).toHaveBeenCalledTimes(2);
  });

  test('bounds are remembered per (view, params), not per view', () => {
    // Each character's window keeps its own size and position.
    viewWindow.openViewWindow('assets', { characterId: 42 });
    viewWindow.openViewWindow('assets', { characterId: 99 });

    const names = created.map((w) => w.config.name);
    expect(new Set(names).size).toBe(2);
  });
});

describe('querying open windows', () => {
  test('reports whether a given view+params is open', () => {
    expect(viewWindow.isViewWindowOpen('assets', { characterId: 42 })).toBe(false);

    viewWindow.openViewWindow('assets', { characterId: 42 });

    expect(viewWindow.isViewWindowOpen('assets', { characterId: 42 })).toBe(true);
    expect(viewWindow.isViewWindowOpen('assets', { characterId: 99 })).toBe(false);
  });

  test('a closed window is no longer reported open', () => {
    viewWindow.openViewWindow('assets', { characterId: 42 });
    created[0].close();

    expect(viewWindow.isViewWindowOpen('assets', { characterId: 42 })).toBe(false);
  });

  test('focusViewWindow returns false when nothing is open', () => {
    expect(viewWindow.focusViewWindow('assets', { characterId: 42 })).toBe(false);
  });

  test('focusViewWindow focuses an existing window', () => {
    viewWindow.openViewWindow('assets', { characterId: 42 });

    expect(viewWindow.focusViewWindow('assets', { characterId: 42 })).toBe(true);
    expect(created[0].focused).toBe(true);
  });
});

describe('teardown', () => {
  test('closeAllViewWindows closes every open window', () => {
    viewWindow.openViewWindow('assets', { characterId: 42 });
    viewWindow.openViewWindow('market', {});

    viewWindow.closeAllViewWindows();

    expect(created.every((w) => w.destroyed)).toBe(true);
    expect(viewWindow.listViewWindows()).toEqual([]);
  });

  test('a close racing a reopen does not evict the newer window', () => {
    // The stale-close guard: if the old window's `closed` handler fired blindly
    // it would delete the entry belonging to the replacement.
    viewWindow.openViewWindow('assets', { characterId: 42 });
    const first = created[0];
    first.close();

    viewWindow.openViewWindow('assets', { characterId: 42 });
    first.close(); // late duplicate event from the dead window

    expect(viewWindow.isViewWindowOpen('assets', { characterId: 42 })).toBe(true);
  });
});

describe('input validation', () => {
  test('a missing viewId throws rather than opening a blank window', () => {
    expect(() => viewWindow.openViewWindow()).toThrow(/viewId/);
  });

  test('omitted params are treated as empty, not undefined', () => {
    viewWindow.openViewWindow('market');

    expect(created[0].config.query.params).toBe('{}');
  });
});

/* ------------------------------------------------------- popped-out state */

/*
 * Every rail needs to know which views are open in their own windows, so it can
 * mark them and route a click to the existing window instead of mounting a
 * second copy. The set is BROADCAST rather than returned to the opener: any
 * window's rail can be showing the marker.
 */
describe('announcing open windows', () => {
  const openPayloads = () =>
    announcements
      .filter((a) => a.channel === 'window:viewWindowsChanged')
      .map((a) => a.payload.open);

  test('opening a window announces it', () => {
    viewWindow.openViewWindow('market');

    const last = openPayloads().pop();
    expect(last).toHaveLength(1);
    expect(last[0].viewId).toBe('market');
  });

  test('closing a window announces the smaller set', () => {
    viewWindow.openViewWindow('market');
    created[0].close();

    expect(openPayloads().pop()).toEqual([]);
  });

  test('the payload carries viewId and params, not just the key', () => {
    // A rail matches on viewId; a key like `skills?characterId=42` is a one-way
    // encoding and cannot be reliably parsed back apart.
    viewWindow.openViewWindow('skills', { characterId: 42 });

    const entry = openPayloads().pop()[0];
    expect(entry.viewId).toBe('skills');
    expect(entry.params).toEqual({ characterId: 42 });
    expect(entry.key).toBe('skills?characterId=42');
  });

  test('focusing an already-open window does not re-announce', () => {
    viewWindow.openViewWindow('market');
    const before = openPayloads().length;

    viewWindow.openViewWindow('market'); // focuses, does not create

    expect(openPayloads()).toHaveLength(before);
  });
});

describe('listViewWindows', () => {
  test('describes each window by viewId and params', () => {
    viewWindow.openViewWindow('market');
    viewWindow.openViewWindow('skills', { characterId: 7 });

    expect(viewWindow.listViewWindows()).toEqual([
      { key: 'market', viewId: 'market', params: {} },
      { key: 'skills?characterId=7', viewId: 'skills', params: { characterId: 7 } },
    ]);
  });

  test('a closed window drops out of the list', () => {
    viewWindow.openViewWindow('market');
    created[0].close();

    expect(viewWindow.listViewWindows()).toEqual([]);
  });
});

describe('closeViewWindow', () => {
  test('closes the window for a (viewId, params) pair', () => {
    viewWindow.openViewWindow('skills', { characterId: 7 });

    expect(viewWindow.closeViewWindow('skills', { characterId: 7 })).toBe(true);
    expect(viewWindow.isViewWindowOpen('skills', { characterId: 7 })).toBe(false);
  });

  test('leaves a different character’s window alone', () => {
    viewWindow.openViewWindow('skills', { characterId: 7 });
    viewWindow.openViewWindow('skills', { characterId: 8 });

    viewWindow.closeViewWindow('skills', { characterId: 7 });

    expect(viewWindow.isViewWindowOpen('skills', { characterId: 8 })).toBe(true);
  });

  test('returns false when there is no such window', () => {
    expect(viewWindow.closeViewWindow('market')).toBe(false);
  });
});
