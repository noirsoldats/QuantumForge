/**
 * @jest-environment jsdom
 *
 * QFUI busy-button state - the shared "action in flight" affordance.
 *
 * Before this existed, a save that took a second gave no sign it was running:
 * the button stayed bright and clickable until a toast appeared at the end. Two
 * problems, and the second is a real bug rather than a perception one:
 *
 *   1. it reads as broken, so the user clicks again;
 *   2. clicking again actually re-ran the action. `confirmCreatePlan` awaits
 *      plans.create -> loadPlans -> selectPlan with the modal open and the
 *      button live throughout, so a double-click created two plans.
 *
 * The re-entry guard is therefore load-bearing, not decoration - most of what
 * is pinned below is about restoring state on every exit path.
 */

require('../../public/shared/ui-helpers.js');

const fs = require('fs');
const path = require('path');

const { QFUI } = window;

/** A button shaped like the ones in the views: icon + `.btn-label` span. */
function makeButton(label = 'Save') {
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.innerHTML = '<svg></svg><span class="btn-label"></span>';
  btn.querySelector('.btn-label').textContent = label;
  document.body.appendChild(btn);
  return btn;
}

/** A bare button with no label span - the older markup still in some views. */
function makePlainButton(label = 'Save') {
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = label;
  document.body.appendChild(btn);
  return btn;
}

/** A promise plus the handles to settle it, so a test can hold an action open. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('setBusy', () => {
  test('disables, marks and spins the button', () => {
    const btn = makeButton();

    QFUI.setBusy(btn, true, 'Saving…');

    expect(btn.disabled).toBe(true);
    expect(btn.classList.contains('is-busy')).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.querySelector('.qf-spinner')).not.toBeNull();
  });

  test('swaps the label and restores it', () => {
    const btn = makeButton('Save Changes');

    QFUI.setBusy(btn, true, 'Saving…');
    expect(QFUI.getButtonLabel(btn)).toBe('Saving…');

    QFUI.setBusy(btn, false);
    expect(QFUI.getButtonLabel(btn)).toBe('Save Changes');
  });

  test('clears every busy marker when turned off', () => {
    const btn = makeButton();

    QFUI.setBusy(btn, true, 'Saving…');
    QFUI.setBusy(btn, false);

    expect(btn.disabled).toBe(false);
    expect(btn.classList.contains('is-busy')).toBe(false);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    expect(btn.querySelector('.qf-spinner')).toBeNull();
  });

  test('keeps the icon, which textContent would have destroyed', () => {
    // The reason setButtonLabel exists at all: writing btn.textContent removes
    // the inline SVG permanently.
    const btn = makeButton();

    QFUI.setBusy(btn, true, 'Saving…');
    QFUI.setBusy(btn, false);

    expect(btn.querySelector('svg')).not.toBeNull();
  });

  test('works on a button with no label span', () => {
    const btn = makePlainButton('Add Cost');

    QFUI.setBusy(btn, true, 'Adding…');
    expect(btn.textContent).toContain('Adding…');

    QFUI.setBusy(btn, false);
    expect(btn.textContent).toContain('Add Cost');
  });

  test('does not stack spinners when set busy twice', () => {
    const btn = makeButton();

    QFUI.setBusy(btn, true, 'Saving…');
    QFUI.setBusy(btn, true, 'Still saving…');

    expect(btn.querySelectorAll('.qf-spinner')).toHaveLength(1);
  });

  test('a second setBusy does not overwrite the remembered label', () => {
    const btn = makeButton('Save');

    QFUI.setBusy(btn, true, 'Saving…');
    QFUI.setBusy(btn, true, 'Still saving…');
    QFUI.setBusy(btn, false);

    expect(QFUI.getButtonLabel(btn)).toBe('Save');
  });

  test('tolerates a missing button', () => {
    expect(() => QFUI.setBusy(null, true, 'Saving…')).not.toThrow();
    expect(() => QFUI.setBusy(undefined, false)).not.toThrow();
  });

  test('tolerates a detached button', () => {
    // Handlers routinely re-render the list holding the button, so by the time
    // the finally runs the node can be out of the document.
    const btn = makeButton();
    QFUI.setBusy(btn, true, 'Saving…');
    btn.remove();

    expect(() => QFUI.setBusy(btn, false)).not.toThrow();
    expect(btn.classList.contains('is-busy')).toBe(false);
  });
});

describe('isBusy', () => {
  test('reports the busy state', () => {
    const btn = makeButton();

    expect(QFUI.isBusy(btn)).toBe(false);
    QFUI.setBusy(btn, true, 'Saving…');
    expect(QFUI.isBusy(btn)).toBe(true);
    QFUI.setBusy(btn, false);
    expect(QFUI.isBusy(btn)).toBe(false);
  });

  test('is false for a missing button', () => {
    expect(QFUI.isBusy(null)).toBe(false);
  });
});

describe('withButtonBusy', () => {
  test('holds the busy state for the duration of the action', async () => {
    const btn = makeButton('Create Plan');
    const gate = deferred();

    const running = QFUI.withButtonBusy(btn, 'Creating…', () => gate.promise);

    expect(btn.disabled).toBe(true);
    expect(QFUI.getButtonLabel(btn)).toBe('Creating…');
    expect(btn.querySelector('.qf-spinner')).not.toBeNull();

    gate.resolve();
    await running;

    expect(btn.disabled).toBe(false);
    expect(QFUI.getButtonLabel(btn)).toBe('Create Plan');
    expect(btn.querySelector('.qf-spinner')).toBeNull();
  });

  test('returns the action result', async () => {
    const btn = makeButton();

    const result = await QFUI.withButtonBusy(btn, 'Working…', () => 'done');

    expect(result).toBe('done');
  });

  test('blocks a second click while the first is in flight', async () => {
    // The double-submit guard: this is what stopped two plans being created.
    const btn = makeButton();
    const gate = deferred();
    const fn = jest.fn(() => gate.promise);

    const first = QFUI.withButtonBusy(btn, 'Creating…', fn);
    const second = await QFUI.withButtonBusy(btn, 'Creating…', fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(second).toBeUndefined();

    gate.resolve();
    await first;
  });

  test('accepts a new click once the first has finished', async () => {
    const btn = makeButton();
    const fn = jest.fn(async () => 'ok');

    await QFUI.withButtonBusy(btn, 'Saving…', fn);
    await QFUI.withButtonBusy(btn, 'Saving…', fn);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('restores the button when the action rejects', async () => {
    const btn = makeButton('Save');

    await expect(
      QFUI.withButtonBusy(btn, 'Saving…', () => Promise.reject(new Error('IPC failed')))
    ).rejects.toThrow('IPC failed');

    expect(btn.disabled).toBe(false);
    expect(btn.classList.contains('is-busy')).toBe(false);
    expect(QFUI.getButtonLabel(btn)).toBe('Save');
    expect(btn.querySelector('.qf-spinner')).toBeNull();
  });

  test('restores the button when the action throws synchronously', async () => {
    const btn = makeButton('Save');

    await expect(
      QFUI.withButtonBusy(btn, 'Saving…', () => {
        throw new Error('bad argument');
      })
    ).rejects.toThrow('bad argument');

    expect(btn.disabled).toBe(false);
    expect(QFUI.isBusy(btn)).toBe(false);
  });

  test('re-throws so the caller keeps its own toast', async () => {
    const btn = makeButton();
    const err = new Error('boom');

    await expect(
      QFUI.withButtonBusy(btn, 'Saving…', () => Promise.reject(err))
    ).rejects.toBe(err);
  });

  test('still runs the action when the button is missing', async () => {
    // A handler should never be skipped just because its button was not found.
    const fn = jest.fn(async () => 'ran');

    await expect(QFUI.withButtonBusy(null, 'Saving…', fn)).resolves.toBe('ran');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('survives the button being replaced mid-flight', async () => {
    const btn = makeButton();
    const gate = deferred();

    const running = QFUI.withButtonBusy(btn, 'Saving…', () => gate.promise);
    // The handler re-renders the list that owned this button.
    btn.remove();
    gate.resolve('ok');

    await expect(running).resolves.toBe('ok');
  });
});

describe('view markup', () => {
  // setButtonLabel only writes into `.btn-label`; with no such child it falls
  // back to the button's textContent, which DELETES the icon and any id'd
  // label span with it. Several buttons carried an id'd span but no class, so
  // the first busy swap destroyed the very element other code looked up by id.
  const VIEWS = [
    ['manufacturing-plans', ['mp-recalc-all-label', 'mp-complete-plan-label', 'mp-relock-label']],
    ['blueprints', ['bp-refresh-label']],
    ['assets', ['as-refresh-label']],
    ['skills', ['sk-refresh-label']],
  ];

  test.each(VIEWS)('%s label spans are reachable by setButtonLabel', (view, ids) => {
    const html = fs.readFileSync(
      path.join(__dirname, `../../public/${view}.view.html`),
      'utf8'
    );

    for (const id of ids) {
      const tag = html.match(new RegExp(`<span[^>]*id="${id}"[^>]*>`));
      expect(tag).not.toBeNull();
      expect(tag[0]).toContain('btn-label');
    }
  });
});

describe('stylesheet', () => {
  // jsdom does not apply stylesheets, so these rules cannot be asserted through
  // the DOM - a getComputedStyle check would pass whether or not the CSS
  // shipped. Assert against the stylesheet text instead.
  const css = fs.readFileSync(
    path.join(__dirname, '../../public/shared/components.css'),
    'utf8'
  );

  test('defines the shared spinner and its keyframes', () => {
    expect(css).toContain('@keyframes qf-spin');
    expect(css).toMatch(/\.qf-spinner\s*\{/);
  });

  test('prefixes the keyframe name', () => {
    // splash.css and wizard.css both define a global `@keyframes spin`.
    expect(css).not.toMatch(/@keyframes\s+spin\s*\{/);
  });

  test('defines the busy button state', () => {
    expect(css).toMatch(/\.btn\.is-busy/);
  });

  test('undoes the disabled dimming so the spinner stays visible', () => {
    // `.btn:disabled` sets opacity .45, which would all but hide the spinner.
    const rule = css.slice(css.indexOf('.btn.is-busy:disabled'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('opacity: 1');
  });
});
