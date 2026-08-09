/**
 * @jest-environment jsdom
 *
 * QFToast - the shared toast implementation.
 *
 * Replaced three per-renderer copies that had drifted into three different
 * signatures and, in cleanup-tool's case, a different CSS class entirely
 * (`.toast-notification` rather than the shared `.toast`).
 *
 * The behaviour worth pinning is placement: a per-screen default with a
 * per-call override, because a toast raised while a right-hand drawer is open
 * needs to move and only that call site knows.
 */

require('../../public/shared/toast.js');

const { QFToast } = window;

beforeEach(() => {
  document.body.innerHTML = '';
  QFToast.dismissAll();
  QFToast.setDefaultPosition(QFToast.DEFAULT_POSITION);
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

/** Every toast currently in the document. */
function toasts() {
  return [...document.querySelectorAll('.toast')];
}

describe('rendering', () => {
  test('shows the message', () => {
    QFToast.show('Saved');

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].textContent).toContain('Saved');
  });

  test('applies the severity class', () => {
    QFToast.show('Boom', 'error');
    expect(toasts()[0].classList.contains('toast-error')).toBe(true);
  });

  test('defaults to info', () => {
    QFToast.show('FYI');
    expect(toasts()[0].classList.contains('toast-info')).toBe(true);
  });

  test('renders an optional title', () => {
    QFToast.show('Disk full', 'error', { title: 'Save failed' });

    expect(document.querySelector('.toast-title').textContent).toBe('Save failed');
    expect(document.querySelector('.toast-message').textContent).toBe('Disk full');
  });

  test('omits the title element when none is given', () => {
    QFToast.show('Plain');
    expect(document.querySelector('.toast-title')).toBeNull();
  });

  test('never interprets the message as markup', () => {
    // Messages routinely carry item names and raw API error strings.
    QFToast.show('<img src=x onerror=alert(1)>');

    expect(document.querySelector('.toast img')).toBeNull();
    expect(document.querySelector('.toast-message').textContent)
      .toBe('<img src=x onerror=alert(1)>');
  });

  test('marks errors as alerts for assistive tech', () => {
    QFToast.show('Broke', 'error');
    expect(toasts()[0].getAttribute('role')).toBe('alert');

    QFToast.show('Fine', 'success');
    expect(toasts()[1].getAttribute('role')).toBe('status');
  });
});

describe('placement', () => {
  test('uses top-right by default', () => {
    QFToast.show('Hi');
    expect(document.querySelector('.toast-container-top-right')).not.toBeNull();
  });

  test('a screen can change the default for every later toast', () => {
    QFToast.setDefaultPosition('bottom-left');

    QFToast.show('One');
    QFToast.show('Two');

    expect(document.querySelectorAll('.toast-container-bottom-left .toast')).toHaveLength(2);
    expect(document.querySelector('.toast-container-top-right')).toBeNull();
  });

  test('a single call can override the screen default', () => {
    QFToast.setDefaultPosition('bottom-left');

    QFToast.show('Normal');
    QFToast.show('Special', 'info', { position: 'top-center' });

    expect(document.querySelectorAll('.toast-container-bottom-left .toast')).toHaveLength(1);
    expect(document.querySelectorAll('.toast-container-top-center .toast')).toHaveLength(1);
  });

  test('the per-call override does not change the default', () => {
    QFToast.show('Special', 'info', { position: 'bottom-center' });
    QFToast.show('Normal');

    expect(document.querySelectorAll('.toast-container-top-right .toast')).toHaveLength(1);
  });

  test('several positions can coexist', () => {
    QFToast.show('a', 'info', { position: 'top-left' });
    QFToast.show('b', 'info', { position: 'bottom-right' });

    expect(document.querySelectorAll('.toast-container')).toHaveLength(2);
  });

  test('an unknown position falls back to the default rather than breaking', () => {
    QFToast.show('Hi', 'info', { position: 'nowhere' });

    expect(document.querySelector('.toast-container-top-right .toast')).not.toBeNull();
  });

  test('rejects an unknown default and keeps the previous one', () => {
    // The guard warns by design; capture it so the suite output stays clean
    // AND so we assert the developer actually gets told.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    QFToast.setDefaultPosition('bottom-left');
    QFToast.setDefaultPosition('sideways');

    QFToast.show('Hi');
    expect(document.querySelector('.toast-container-bottom-left .toast')).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sideways'));

    warn.mockRestore();
  });
});

describe('dismissal', () => {
  test('auto-dismisses after the duration', () => {
    QFToast.show('Bye', 'info', { duration: 1000 });
    expect(toasts()).toHaveLength(1);

    jest.advanceTimersByTime(1000);
    jest.advanceTimersByTime(200); // leave animation
    expect(toasts()).toHaveLength(0);
  });

  test('duration 0 keeps it until dismissed', () => {
    QFToast.show('Sticky', 'warning', { duration: 0 });

    jest.advanceTimersByTime(60000);
    expect(toasts()).toHaveLength(1);
  });

  test('the close button dismisses it', () => {
    QFToast.show('Bye');

    document.querySelector('.toast-close').click();
    jest.advanceTimersByTime(200);

    expect(toasts()).toHaveLength(0);
  });

  test('the returned handle dismisses it', () => {
    const handle = QFToast.show('Bye', 'info', { duration: 0 });

    handle.dismiss();
    jest.advanceTimersByTime(200);

    expect(toasts()).toHaveLength(0);
  });

  test('dismissing twice is harmless', () => {
    const handle = QFToast.show('Bye');

    handle.dismiss();
    handle.dismiss();
    jest.advanceTimersByTime(200);

    expect(toasts()).toHaveLength(0);
  });

  test('the container is removed once empty, leaving no stray nodes', () => {
    QFToast.show('Bye', 'info', { duration: 500 });

    jest.advanceTimersByTime(500);
    jest.advanceTimersByTime(200);

    expect(document.querySelector('.toast-container')).toBeNull();
  });

  test('the container survives while other toasts remain', () => {
    const first = QFToast.show('One', 'info', { duration: 0 });
    QFToast.show('Two', 'info', { duration: 0 });

    first.dismiss();
    jest.advanceTimersByTime(200);

    expect(toasts()).toHaveLength(1);
    expect(document.querySelector('.toast-container')).not.toBeNull();
  });

  test('dismissAll clears every position', () => {
    QFToast.show('a', 'info', { position: 'top-left', duration: 0 });
    QFToast.show('b', 'info', { position: 'bottom-right', duration: 0 });

    QFToast.dismissAll();

    expect(document.querySelectorAll('.toast-container')).toHaveLength(0);
    expect(toasts()).toHaveLength(0);
  });
});

describe('API contract: callers must use show(message, type)', () => {
  // A renderer called QFToast.info(...) / .success(...) - per-type methods that
  // DO NOT EXIST. That is a silent TypeError, so every toast on two screens did
  // nothing at all, and the suites passed because their mocks had invented the
  // very methods the real module lacks.
  //
  // These tests read the shipped renderers, so a wrong call site fails here
  // even when a mock would have accepted it.

  const fs = require('fs');
  const path = require('path');

  /** Strip comments: the fix is DOCUMENTED in these files, and a naive scan
      would match the explanation rather than a real call. */
  function stripComments(source) {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  const RENDERERS = fs
    .readdirSync(path.join(__dirname, '../../src/renderer'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({
      name: f,
      source: stripComments(
        fs.readFileSync(path.join(__dirname, '../../src/renderer', f), 'utf8')
      ),
    }));

  test('the module exposes show() and no per-type helpers', () => {
    expect(typeof QFToast.show).toBe('function');
    ['info', 'success', 'warning', 'error'].forEach((type) => {
      expect(QFToast[type]).toBeUndefined();
    });
  });

  test('no renderer calls a per-type toast method', () => {
    const offenders = RENDERERS.filter(({ source }) =>
      /QFToast\.(info|success|warning|error)\s*\(/.test(source)
    ).map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  test('no renderer indexes QFToast by a dynamic key', () => {
    // `QFToast[type](message)` is the exact form that shipped broken - it looks
    // plausible and fails silently.
    const offenders = RENDERERS.filter(({ source }) =>
      /QFToast\[[^\]]+\]\s*\(/.test(source)
    ).map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
