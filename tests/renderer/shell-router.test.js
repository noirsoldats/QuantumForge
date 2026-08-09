/**
 * @jest-environment jsdom
 *
 * ShellRouter + ViewContext.
 *
 * The persistent shell keeps one document alive for the window's lifetime, so
 * view teardown is what stops resources accumulating across mounts. These tests
 * pin the two properties that matter:
 *
 *   1. destroy() runs BEFORE the next view mounts (no overlap).
 *   2. mount -> switch away -> mount again leaves exactly ONE live subscription.
 */

require('../../public/shared/shell.js');

const { QFShell } = window;

/** Calls the shell made to the window API during a test. */
let windowCalls;

function setupShell(role) {
  document.body.innerHTML = '';
  windowCalls = [];
  // Minimal stub of the preload surface the shell touches at init.
  window.electronAPI = {
    window: {
      isMaximized: () => Promise.resolve(false),
      onMaximizeChanged: () => () => {},
      getPlatformChrome: () => Promise.resolve({ isMac: false }),
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => {},
      openView: (viewId, params, options) => {
        windowCalls.push({ fn: 'openView', viewId, params, options });
        return Promise.resolve(true);
      },
      focusView: (viewId, params) => {
        windowCalls.push({ fn: 'focusView', viewId, params });
        return Promise.resolve(true);
      },
      listViewWindows: () => Promise.resolve([]),
      onViewWindowsChanged: () => () => {},
    },
  };
  return QFShell.init({ role: role || 'main', title: 'Test' });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ViewContext', () => {
  test('track() runs disposers on dispose()', () => {
    const ctx = new QFShell.ViewContext('t');
    const calls = [];
    ctx.track(() => calls.push('a'));
    ctx.track(() => calls.push('b'));

    expect(ctx.size()).toBe(2);
    ctx.dispose();

    // Reverse order: teardown mirrors setup.
    expect(calls).toEqual(['b', 'a']);
    expect(ctx.size()).toBe(0);
  });

  test('dispose() is idempotent', () => {
    const ctx = new QFShell.ViewContext('t');
    const calls = [];
    ctx.track(() => calls.push('x'));

    ctx.dispose();
    ctx.dispose();

    expect(calls).toEqual(['x']);
  });

  test('a throwing disposer does not stop the others', () => {
    const ctx = new QFShell.ViewContext('t');
    const calls = [];
    jest.spyOn(console, 'error').mockImplementation(() => {});

    ctx.track(() => calls.push('first'));
    ctx.track(() => { throw new Error('boom'); });
    ctx.track(() => calls.push('last'));

    expect(() => ctx.dispose()).not.toThrow();
    expect(calls).toEqual(['last', 'first']);

    console.error.mockRestore();
  });

  test('setInterval is cleared on dispose', () => {
    jest.useFakeTimers();
    const ctx = new QFShell.ViewContext('t');
    const tick = jest.fn();

    ctx.setInterval(tick, 100);
    jest.advanceTimersByTime(250);
    expect(tick).toHaveBeenCalledTimes(2);

    ctx.dispose();
    jest.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(2); // no further ticks

    jest.useRealTimers();
  });

  test('event listeners are removed on dispose', () => {
    const ctx = new QFShell.ViewContext('t');
    const handler = jest.fn();
    const el = document.createElement('div');

    ctx.on(el, 'click', handler);
    el.dispatchEvent(new window.MouseEvent('click'));
    expect(handler).toHaveBeenCalledTimes(1);

    ctx.dispose();
    el.dispatchEvent(new window.MouseEvent('click'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('ShellRouter teardown', () => {
  test('destroy runs before the next mount', () => {
    setupShell();
    const order = [];

    QFShell.router.register('a', {
      title: 'A',
      mount: () => { order.push('mount:a'); return { destroy: () => order.push('destroy:a') }; },
    });
    QFShell.router.register('b', {
      title: 'B',
      mount: () => { order.push('mount:b'); return { destroy: () => order.push('destroy:b') }; },
    });

    QFShell.router.show('a');
    QFShell.router.show('b');

    expect(order).toEqual(['mount:a', 'destroy:a', 'mount:b']);
  });

  test('the view host holds exactly one view at a time', () => {
    setupShell();
    QFShell.router.register('a', { title: 'A', mount: (c) => { c.textContent = 'A'; return {}; } });
    QFShell.router.register('b', { title: 'B', mount: (c) => { c.textContent = 'B'; return {}; } });

    QFShell.router.show('a');
    QFShell.router.show('b');

    const host = document.getElementById('view-host');
    expect(host.children).toHaveLength(1);
    expect(host.textContent).toBe('B');
  });

  test('mount -> switch away -> mount again leaves ONE live subscription', () => {
    // The regression the disposer work exists to prevent.
    setupShell();

    const handlers = [];
    const fakeApi = {
      onThing: (cb) => {
        handlers.push(cb);
        return () => {
          const i = handlers.indexOf(cb);
          if (i !== -1) handlers.splice(i, 1);
        };
      },
    };

    const received = [];
    QFShell.router.register('sub', {
      title: 'Sub',
      mount: (container, params, ctx) => {
        ctx.track(fakeApi.onThing((v) => received.push(v)));
        return {};
      },
    });
    QFShell.router.register('other', { title: 'Other', mount: () => ({}) });

    QFShell.router.show('sub');
    expect(handlers).toHaveLength(1);

    QFShell.router.show('other');
    expect(handlers).toHaveLength(0); // disposed on unmount

    QFShell.router.show('sub');
    expect(handlers).toHaveLength(1); // NOT 2

    handlers.forEach((h) => h('event'));
    expect(received).toEqual(['event']); // fired once, not twice
  });

  test('context is disposed even when the view destroy() throws', () => {
    setupShell();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const disposed = [];

    QFShell.router.register('bad', {
      title: 'Bad',
      mount: (c, p, ctx) => {
        ctx.track(() => disposed.push('tracked'));
        return { destroy: () => { throw new Error('destroy exploded'); } };
      },
    });
    QFShell.router.register('next', { title: 'Next', mount: () => ({}) });

    QFShell.router.show('bad');
    QFShell.router.show('next');

    // One bad view must not leak every other view's resources.
    expect(disposed).toEqual(['tracked']);
    console.error.mockRestore();
  });

  test('intervals started by a view stop when it unmounts', () => {
    jest.useFakeTimers();
    setupShell();
    const tick = jest.fn();

    QFShell.router.register('poller', {
      title: 'Poller',
      mount: (c, p, ctx) => { ctx.setInterval(tick, 50); return {}; },
    });
    QFShell.router.register('idle', { title: 'Idle', mount: () => ({}) });

    QFShell.router.show('poller');
    jest.advanceTimersByTime(120);
    const afterMount = tick.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);

    QFShell.router.show('idle');
    jest.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(afterMount);

    jest.useRealTimers();
  });

  test('breadcrumb and rail active state follow the mounted view', () => {
    setupShell();
    QFShell.router.register('market', { title: 'Market Manager', mount: () => ({}) });

    QFShell.router.show('market');

    expect(document.querySelector('.qf-breadcrumb-current').textContent).toBe('Market Manager');
    expect(document.querySelectorAll('.qf-rail-item.is-active')).toHaveLength(1);
  });

  test('showing an unknown view logs and does not unmount the current one', () => {
    setupShell();
    jest.spyOn(console, 'error').mockImplementation(() => {});

    QFShell.router.register('a', { title: 'A', mount: (c) => { c.textContent = 'A'; return {}; } });
    QFShell.router.show('a');
    QFShell.router.show('does-not-exist');

    expect(document.getElementById('view-host').textContent).toBe('A');
    expect(console.error).toHaveBeenCalled();
    console.error.mockRestore();
  });
});

/* ------------------------------------------------------------------ pop-out */

/*
 * Pop-out MOVES a tool rather than cloning it: the same view mounted in two
 * places would run two copies of its subscriptions and timers against one set
 * of data. So the main window tears its copy down, falls back to the Dashboard,
 * and marks the rail - after which a click focuses that window instead of
 * mounting a second copy.
 */
describe('pop-out', () => {
  const dashboard = { title: 'Dashboard', mount: (c) => { c.textContent = 'D'; return {}; } };

  function registerTools() {
    QFShell.router.register('dashboard', dashboard);
    QFShell.router.register('market', {
      title: 'Market Manager',
      mount: (c) => { c.textContent = 'M'; return {}; },
    });
    QFShell.router.register('settings', {
      title: 'Settings',
      poppable: false,
      mount: (c) => { c.textContent = 'S'; return {}; },
    });
  }

  test('popOut() opens the active view in its own window', () => {
    setupShell();
    registerTools();
    QFShell.router.show('market');

    QFShell.router.popOut();

    const call = windowCalls.find((c) => c.fn === 'openView');
    expect(call).toBeDefined();
    expect(call.viewId).toBe('market');
  });

  test('the main window falls back to the Dashboard', () => {
    // The tool now lives elsewhere; leaving its shell mounted here would be a
    // second live copy.
    setupShell();
    registerTools();
    QFShell.router.show('market');

    QFShell.router.popOut();

    expect(QFShell.router.getActive()).toBe('dashboard');
  });

  test('the local view is destroyed before the window opens', () => {
    const events = [];
    setupShell();
    QFShell.router.register('dashboard', dashboard);
    QFShell.router.register('market', {
      title: 'Market Manager',
      mount: () => ({ destroy: () => events.push('destroy') }),
    });
    QFShell.router.show('market');

    window.electronAPI.window.openView = () => {
      events.push('openView');
      return Promise.resolve(true);
    };
    QFShell.router.popOut();

    expect(events).toEqual(['destroy', 'openView']);
  });

  test('a non-poppable view refuses to pop', () => {
    setupShell();
    registerTools();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    QFShell.router.show('settings');

    expect(QFShell.router.popOut()).toBe(false);
    expect(windowCalls.filter((c) => c.fn === 'openView')).toHaveLength(0);

    console.error.mockRestore();
  });

  test('params are carried into the popped window', () => {
    setupShell();
    QFShell.router.register('dashboard', dashboard);
    QFShell.router.register('skills', { title: 'Skills', mount: () => ({}) });
    QFShell.router.show('skills', { characterId: 42 });

    QFShell.router.popOut();

    expect(windowCalls.find((c) => c.fn === 'openView').params).toEqual({ characterId: 42 });
  });
});

describe('popped-out state', () => {
  function registerTools() {
    QFShell.router.register('dashboard', {
      title: 'Dashboard',
      mount: (c) => { c.textContent = 'D'; return {}; },
    });
    QFShell.router.register('market', {
      title: 'Market Manager',
      mount: (c) => { c.textContent = 'M'; return {}; },
    });
  }

  test('a popped view still mounts locally, giving two side by side', () => {
    // Two Blueprint Calculators - one popped, one in main - is a legitimate
    // thing to want. An open window must not make the rail item inert.
    setupShell();
    registerTools();
    QFShell.router.show('dashboard');

    QFShell.router.setViewWindows([{ key: 'market', viewId: 'market', params: {} }]);
    QFShell.router.show('market');

    expect(QFShell.router.getActive()).toBe('market');
    expect(windowCalls.filter((c) => c.fn === 'focusView')).toHaveLength(0);
  });

  test('the rail marks a popped tool', () => {
    setupShell();
    registerTools();

    QFShell.router.setViewWindows([{ key: 'market', viewId: 'market', params: {} }]);

    expect(document.querySelectorAll('.qf-rail-item.is-popped')).toHaveLength(1);
  });

  test('closing the window clears the marker and remounts normally', () => {
    setupShell();
    registerTools();

    QFShell.router.setViewWindows([{ key: 'market', viewId: 'market', params: {} }]);
    QFShell.router.setViewWindows([]);

    expect(document.querySelectorAll('.qf-rail-item.is-popped')).toHaveLength(0);

    QFShell.router.show('market');
    expect(QFShell.router.getActive()).toBe('market');
  });

  test('the full set replaces the previous one, so state cannot drift', () => {
    // The payload is the complete set rather than a delta - a window that
    // subscribes late must not be able to desync.
    setupShell();
    registerTools();

    QFShell.router.setViewWindows([{ key: 'market', viewId: 'market', params: {} }]);
    QFShell.router.setViewWindows([{ key: 'facilities', viewId: 'facilities', params: {} }]);

    expect(QFShell.router.getPopped('market')).toBeNull();
    expect(QFShell.router.getPopped('facilities')).toEqual({});
  });

  test('another window opening the tool does NOT unmount it here', () => {
    // Only `popOut()` from THIS window hands the tool off. Someone else opening
    // a window for it is the side-by-side case, not a reason to close this one.
    setupShell();
    registerTools();
    QFShell.router.show('market');

    QFShell.router.setViewWindows([{ key: 'market', viewId: 'market', params: {} }]);

    expect(QFShell.router.getActive()).toBe('market');
  });

  test('a standalone window mounts its own view normally', () => {
    // role=standalone: the window IS the popped view, and its own entry in the
    // popped set must not interfere with mounting it.
    setupShell('standalone');
    registerTools();

    QFShell.router.setViewWindows([{ key: 'market', viewId: 'market', params: {} }]);
    QFShell.router.show('market');

    expect(QFShell.router.getActive()).toBe('market');
    expect(windowCalls.filter((c) => c.fn === 'focusView')).toHaveLength(0);
  });
});

/* --------------------------------------------------------- pop-out button */

describe('pop-out button', () => {
  test('is hidden on the Dashboard', () => {
    setupShell();
    QFShell.router.register('dashboard', { title: 'Dashboard', mount: () => ({}) });
    QFShell.router.show('dashboard');

    expect(document.getElementById('qf-popout-btn').hidden).toBe(true);
  });

  test('appears for a poppable tool', () => {
    setupShell();
    QFShell.router.register('market', { title: 'Market Manager', mount: () => ({}) });
    QFShell.router.show('market');

    expect(document.getElementById('qf-popout-btn').hidden).toBe(false);
  });

  test('stays hidden for a non-poppable view', () => {
    setupShell();
    QFShell.router.register('settings', {
      title: 'Settings', poppable: false, mount: () => ({}),
    });
    QFShell.router.show('settings');

    expect(document.getElementById('qf-popout-btn').hidden).toBe(true);
  });

  test('is absent entirely in a popped-out window', () => {
    // Nothing to pop to.
    setupShell('standalone');
    expect(document.getElementById('qf-popout-btn')).toBeNull();
  });

  test('clicking it pops the active view', () => {
    setupShell();
    QFShell.router.register('dashboard', { title: 'Dashboard', mount: () => ({}) });
    QFShell.router.register('market', { title: 'Market Manager', mount: () => ({}) });
    QFShell.router.show('market');

    document.getElementById('qf-popout-btn').click();

    expect(windowCalls.find((c) => c.fn === 'openView').viewId).toBe('market');
  });
});
