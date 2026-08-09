/**
 * @jest-environment jsdom
 *
 * QFSearchSelect - shared searchable dropdown.
 *
 * These tests exist to protect the two binding rules in CLAUDE.md
 * "UI Redesign Conventions" that are easy to regress silently:
 *
 *   Rule 1 - the row highlight is box-shadow only, driven by the `qf-ss-hi`
 *            class. Never a toggled background.
 *   Rule 2 - `hiIndex` is an instance field starting at -1, so NO row is
 *            highlighted on first paint, and it resets to -1 on
 *            open / close / query-change / select.
 *
 * A row highlighted on first paint is exactly what triggers the stuck-highlight
 * bug rule 1 guards against, so "nothing hot until the user arrows" is the
 * single most important assertion in this file.
 */

require('../../public/shared/qf-search-select.js');

const { QFSearchSelect } = window;

const MINERALS = ['Tritanium', 'Pyerite', 'Mexallon', 'Isogen', 'Nocxium'];

function mount(opts = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onChange = jest.fn();
  const sel = new QFSearchSelect(host, {
    options: MINERALS,
    value: null,
    onChange,
    ...opts,
  });
  return { host, sel, onChange };
}

function rows(sel) {
  return Array.from(sel.listEl.querySelectorAll('.qf-ss-row'));
}

function highlighted(sel) {
  return rows(sel).filter((r) => r.classList.contains('qf-ss-hi'));
}

function key(el, k) {
  const ev = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('QFSearchSelect - first paint (binding rules 1 & 2)', () => {
  test('hiIndex starts at -1 before opening', () => {
    const { sel } = mount();
    expect(sel.hiIndex).toBe(-1);
  });

  test('NO row is highlighted on first paint after opening', () => {
    const { sel } = mount();
    sel.openMenu();

    expect(sel.hiIndex).toBe(-1);
    expect(highlighted(sel)).toHaveLength(0);
  });

  test('rows carry no inline background - highlight is class/box-shadow driven only', () => {
    const { sel } = mount();
    sel.openMenu();
    key(sel.inputEl, 'ArrowDown');

    // The highlight must come from the class, never an inline background.
    rows(sel).forEach((r) => {
      expect(r.style.background).toBe('');
      expect(r.style.backgroundColor).toBe('');
    });
    expect(highlighted(sel)).toHaveLength(1);
  });
});

describe('QFSearchSelect - keyboard contract', () => {
  test('first ArrowDown moves from -1 to row 0', () => {
    const { sel } = mount();
    sel.openMenu();

    key(sel.inputEl, 'ArrowDown');

    expect(sel.hiIndex).toBe(0);
    expect(highlighted(sel)).toHaveLength(1);
    expect(highlighted(sel)[0].textContent).toContain('Tritanium');
  });

  test('ArrowDown advances and stops at the last row', () => {
    const { sel } = mount();
    sel.openMenu();

    for (let i = 0; i < 10; i++) key(sel.inputEl, 'ArrowDown');

    expect(sel.hiIndex).toBe(MINERALS.length - 1);
    expect(highlighted(sel)).toHaveLength(1);
  });

  test('ArrowUp clamps at 0 and never returns to -1', () => {
    const { sel } = mount();
    sel.openMenu();
    key(sel.inputEl, 'ArrowDown');
    key(sel.inputEl, 'ArrowDown');

    key(sel.inputEl, 'ArrowUp');
    expect(sel.hiIndex).toBe(0);

    key(sel.inputEl, 'ArrowUp');
    key(sel.inputEl, 'ArrowUp');
    expect(sel.hiIndex).toBe(0);
  });

  test('exactly one row is highlighted at any time', () => {
    const { sel } = mount();
    sel.openMenu();

    for (let i = 0; i < 3; i++) {
      key(sel.inputEl, 'ArrowDown');
      expect(highlighted(sel)).toHaveLength(1);
    }
  });

  test('Enter selects the highlighted row and fires onChange', () => {
    const { sel, onChange } = mount();
    sel.openMenu();
    key(sel.inputEl, 'ArrowDown');
    key(sel.inputEl, 'ArrowDown');

    key(sel.inputEl, 'Enter');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].target.value).toBe('Pyerite');
    expect(sel.getValue()).toBe('Pyerite');
    expect(sel.open).toBe(false);
  });

  test('Enter with nothing highlighted does NOT select', () => {
    const { sel, onChange } = mount();
    sel.openMenu();

    key(sel.inputEl, 'Enter');

    expect(onChange).not.toHaveBeenCalled();
    expect(sel.open).toBe(true);
  });

  test('Escape closes without selecting', () => {
    const { sel, onChange } = mount();
    sel.openMenu();
    key(sel.inputEl, 'ArrowDown');

    key(sel.inputEl, 'Escape');

    expect(sel.open).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('Tab closes', () => {
    const { sel } = mount();
    sel.openMenu();

    key(sel.inputEl, 'Tab');

    expect(sel.open).toBe(false);
  });

  test('trigger opens on Enter, Space and ArrowDown', () => {
    ['Enter', ' ', 'ArrowDown'].forEach((k) => {
      const { sel } = mount();
      key(sel.triggerEl, k);
      expect(sel.open).toBe(true);
      sel.destroy();
    });
  });
});

describe('QFSearchSelect - hiIndex resets to -1', () => {
  test('resets on query change', () => {
    const { sel } = mount();
    sel.openMenu();
    key(sel.inputEl, 'ArrowDown');
    expect(sel.hiIndex).toBe(0);

    sel.inputEl.value = 'so';
    sel.inputEl.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(sel.hiIndex).toBe(-1);
    expect(highlighted(sel)).toHaveLength(0);
  });

  test('resets on close', () => {
    const { sel } = mount();
    sel.openMenu();
    key(sel.inputEl, 'ArrowDown');

    sel.close();

    expect(sel.hiIndex).toBe(-1);
  });

  test('resets on select', () => {
    const { sel } = mount();
    sel.openMenu();
    key(sel.inputEl, 'ArrowDown');
    key(sel.inputEl, 'Enter');

    expect(sel.hiIndex).toBe(-1);
  });

  test('reopening starts clean with no row hot', () => {
    const { sel } = mount();
    sel.openMenu();
    key(sel.inputEl, 'ArrowDown');
    key(sel.inputEl, 'Enter');

    sel.openMenu();

    expect(sel.hiIndex).toBe(-1);
    expect(highlighted(sel)).toHaveLength(0);
  });
});

describe('QFSearchSelect - filtering', () => {
  test('filters options by substring, case-insensitively', () => {
    const { sel } = mount();
    sel.openMenu();

    sel.inputEl.value = 'ISO';
    sel.inputEl.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(sel.filtered).toHaveLength(1);
    expect(sel.filtered[0].label).toBe('Isogen');
    expect(rows(sel)).toHaveLength(1);
  });

  test('shows an empty state when nothing matches', () => {
    const { sel } = mount();
    sel.openMenu();

    sel.inputEl.value = 'zzzz';
    sel.inputEl.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(rows(sel)).toHaveLength(0);
    expect(sel.listEl.querySelector('.qf-ss-empty')).not.toBeNull();
  });

  test('arrowing in an empty result set does not throw or select', () => {
    const { sel, onChange } = mount();
    sel.openMenu();
    sel.inputEl.value = 'zzzz';
    sel.inputEl.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(() => {
      key(sel.inputEl, 'ArrowDown');
      key(sel.inputEl, 'Enter');
    }).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('QFSearchSelect - value handling', () => {
  test('renders the placeholder when no option matches the value', () => {
    const { sel } = mount({ value: 'does-not-exist', placeholder: 'Pick one…' });
    expect(sel.textEl.textContent).toBe('Pick one…');
    expect(sel.triggerEl.classList.contains('qf-ss-placeholder')).toBe(true);
  });

  test('renders the selected label and marks the row selected', () => {
    const { sel } = mount({ value: 'Isogen' });
    expect(sel.textEl.textContent).toBe('Isogen');

    sel.openMenu();
    const selectedRows = rows(sel).filter((r) => r.classList.contains('qf-ss-selected'));
    expect(selectedRows).toHaveLength(1);
    expect(selectedRows[0].textContent).toContain('Isogen');
  });

  test('supports {value,label} options with non-string values', () => {
    const { sel, onChange } = mount({
      options: [{ value: 1, label: 'One' }, { value: 2, label: 'Two' }],
      value: 2,
    });
    expect(sel.textEl.textContent).toBe('Two');

    sel.openMenu();
    key(sel.inputEl, 'ArrowDown');
    key(sel.inputEl, 'Enter');

    expect(onChange.mock.calls[0][0].target.value).toBe(1);
  });

  test('setValue and setOptions update the trigger', () => {
    const { sel } = mount({ value: 'Pyerite' });

    sel.setValue('Nocxium');
    expect(sel.textEl.textContent).toBe('Nocxium');

    sel.setOptions([{ value: 'x', label: 'Xenon' }]);
    sel.setValue('x');
    expect(sel.textEl.textContent).toBe('Xenon');
  });

  test('disabled selects cannot be opened', () => {
    const { sel } = mount({ disabled: true });

    sel.openMenu();
    expect(sel.open).toBe(false);

    key(sel.triggerEl, 'Enter');
    expect(sel.open).toBe(false);
    expect(sel.triggerEl.tabIndex).toBe(-1);
  });

  test('disabled options are not selectable by click', () => {
    const { sel, onChange } = mount({
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }],
    });
    sel.openMenu();

    rows(sel)[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(onChange).not.toHaveBeenCalled();
    expect(sel.open).toBe(true);
  });
});

describe('QFSearchSelect - mouse behaviour', () => {
  test('hovering a row syncs the highlight index', () => {
    const { sel } = mount();
    sel.openMenu();

    rows(sel)[3].dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));

    expect(sel.hiIndex).toBe(3);
    expect(highlighted(sel)).toHaveLength(1);
    expect(highlighted(sel)[0].textContent).toContain('Isogen');
  });

  test('clicking a row selects it', () => {
    const { sel, onChange } = mount();
    sel.openMenu();

    rows(sel)[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].target.value).toBe('Mexallon');
    expect(sel.open).toBe(false);
  });

  test('mousedown outside closes the popover', () => {
    const { sel } = mount();
    sel.openMenu();

    document.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));

    expect(sel.open).toBe(false);
  });

  test('mousedown inside the popover does not close it', () => {
    const { sel } = mount();
    sel.openMenu();

    sel.listEl.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));

    expect(sel.open).toBe(true);
  });
});

describe('QFSearchSelect - lifecycle', () => {
  test('popover is appended to body so it escapes overflow containers', () => {
    const { sel } = mount();
    sel.openMenu();

    expect(sel.popEl.parentNode).toBe(document.body);
    expect(sel.popEl.classList.contains('qf-ss-popover')).toBe(true);
  });

  test('opening a second select closes the first', () => {
    const a = mount();
    const b = mount();

    a.sel.openMenu();
    expect(a.sel.open).toBe(true);

    b.sel.openMenu();
    expect(a.sel.open).toBe(false);
    expect(b.sel.open).toBe(true);
  });

  test('close removes the popover from the document', () => {
    const { sel } = mount();
    sel.openMenu();
    const pop = sel.popEl;

    sel.close();

    expect(pop.parentNode).toBeNull();
    expect(document.querySelectorAll('.qf-ss-popover')).toHaveLength(0);
  });

  test('destroy removes all DOM and leaves no popover behind', () => {
    const { host, sel } = mount();
    sel.openMenu();

    sel.destroy();

    expect(host.children).toHaveLength(0);
    expect(document.querySelectorAll('.qf-ss-popover')).toHaveLength(0);
  });

  test('destroy while closed does not throw', () => {
    const { sel } = mount();
    expect(() => sel.destroy()).not.toThrow();
  });
});

/**
 * Async ("remote") mode: `onSearch(query)` replaces local filtering, for
 * lists too large to hold in memory - SDE item searches, structure lookups.
 *
 * The component owns debounce, out-of-order response handling, and the
 * loading / prompt / empty states; the caller only runs the query.
 */
describe('async search mode', () => {
  /** Mount in async mode with a controllable search function. */
  function mountAsync(opts = {}) {
    const onSearch = jest.fn(async (q) =>
      MINERALS.filter((m) => m.toLowerCase().includes(q.toLowerCase()))
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = jest.fn();
    const sel = new QFSearchSelect(host, {
      options: [],
      onSearch,
      onChange,
      debounceMs: 0,
      ...opts,
    });
    return { host, sel, onSearch, onChange };
  }

  /** Type into the open popover's search field and let the debounce fire. */
  async function type(sel, text) {
    sel.inputEl.value = text;
    sel.inputEl.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 10));
    await Promise.resolve();
  }

  test('does not query until the minimum length is reached', async () => {
    const { sel, onSearch } = mountAsync();
    sel.openMenu();

    await type(sel, 't');

    expect(onSearch).not.toHaveBeenCalled();
  });

  test('prompts the user instead of claiming no matches', async () => {
    const { sel } = mountAsync();
    sel.openMenu();

    // Before typing, "No matches" would read as broken.
    expect(sel.listEl.textContent).toContain('Type to search');
  });

  test('queries once the minimum length is reached', async () => {
    const { sel, onSearch } = mountAsync();
    sel.openMenu();

    await type(sel, 'tri');

    expect(onSearch).toHaveBeenCalledWith('tri');
  });

  test('renders the returned options', async () => {
    const { sel } = mountAsync();
    sel.openMenu();

    await type(sel, 'tri');

    const labels = rows(sel).map((r) => r.textContent);
    expect(labels.join(' ')).toContain('Tritanium');
  });

  test('does not re-filter results locally', async () => {
    // The backend already matched; filtering again would drop legitimate hits
    // whose label does not contain the raw query.
    const { sel } = mountAsync({
      onSearch: async () => ['Hydrogen Fuel Block'],
    });
    sel.openMenu();

    await type(sel, 'hydro');

    expect(rows(sel)).toHaveLength(1);
    expect(rows(sel)[0].textContent).toContain('Hydrogen Fuel Block');
  });

  test('reports no matches when the search returns nothing', async () => {
    const { sel } = mountAsync({ onSearch: async () => [] });
    sel.openMenu();

    await type(sel, 'zzz');

    expect(sel.listEl.textContent).toContain('No matches');
  });

  test('an out-of-order response never overwrites a newer query', async () => {
    const resolvers = {};
    const { sel } = mountAsync({
      onSearch: (q) => new Promise((resolve) => { resolvers[q] = resolve; }),
    });
    sel.openMenu();

    await type(sel, 'aaa');
    await type(sel, 'bbb');

    // The SECOND query resolves first, then the stale first one lands.
    resolvers.bbb(['Correct']);
    await Promise.resolve();
    await Promise.resolve();
    resolvers.aaa(['Stale']);
    await Promise.resolve();
    await Promise.resolve();

    const labels = rows(sel).map((r) => r.textContent).join(' ');
    expect(labels).toContain('Correct');
    expect(labels).not.toContain('Stale');
  });

  test('a failed search clears results rather than hanging on "Searching…"', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { sel } = mountAsync({ onSearch: async () => { throw new Error('offline'); } });
    sel.openMenu();

    await type(sel, 'tri');

    expect(sel.listEl.textContent).toContain('No matches');
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  test('selecting a result fires onChange', async () => {
    const { sel, onChange } = mountAsync();
    sel.openMenu();
    await type(sel, 'tri');

    rows(sel)[0].click();

    // The payload carries the resolved option alongside target.value; assert on
    // the contract callers actually read rather than exact object shape, so
    // additive fields do not break this.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].target.value).toBe('Tritanium');
    expect(onChange.mock.calls[0][0].option).toMatchObject({ value: 'Tritanium' });
  });

  test('keyboard selection works the same as the fixed-list mode', async () => {
    const { sel, onChange } = mountAsync();
    sel.openMenu();
    await type(sel, 'i');   // too short, no query yet
    await type(sel, 'ium'); // Tritanium, Nocxium

    expect(rows(sel).length).toBeGreaterThan(1);
    key(sel.inputEl, 'ArrowDown');
    key(sel.inputEl, 'Enter');

    expect(onChange).toHaveBeenCalled();
  });

  test('no row is highlighted before the user arrows (rule 2)', async () => {
    const { sel } = mountAsync();
    sel.openMenu();

    await type(sel, 'i');
    await type(sel, 'ium');

    expect(highlighted(sel)).toHaveLength(0);
  });

  test('hovering does not replace the row elements (rule 2a)', async () => {
    const { sel } = mountAsync();
    sel.openMenu();
    await type(sel, 'ium');

    const before = rows(sel);
    expect(before.length).toBeGreaterThan(1);
    before[1].dispatchEvent(new window.MouseEvent('mouseenter'));

    const after = rows(sel);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[1].classList.contains('qf-ss-hi')).toBe(true);
  });

  test('reopening starts from a clean search', async () => {
    const { sel } = mountAsync();
    sel.openMenu();
    await type(sel, 'tri');
    expect(rows(sel).length).toBeGreaterThan(0);

    sel.close();
    sel.openMenu();

    // Stale results must not reappear under an empty query.
    expect(rows(sel)).toHaveLength(0);
    expect(sel.listEl.textContent).toContain('Type to search');
  });

  test('closing abandons an in-flight search', async () => {
    let resolve;
    const { sel } = mountAsync({
      onSearch: () => new Promise((r) => { resolve = r; }),
    });
    sel.openMenu();
    await type(sel, 'tri');

    sel.close();
    resolve(['Late']);
    await Promise.resolve();
    await Promise.resolve();

    // No popover to paint into, and no crash.
    expect(document.querySelectorAll('.qf-ss-popover')).toHaveLength(0);
  });

  test('destroy while a search is pending does not throw', async () => {
    const { sel } = mountAsync({ onSearch: () => new Promise(() => {}) });
    sel.openMenu();
    await type(sel, 'tri');

    expect(() => sel.destroy()).not.toThrow();
  });
});

/* ==========================================================================
   Inline mode
   --------------------------------------------------------------------------
   `inline: true` is a change of PRESENTATION only: the search field is the
   control and results drop beneath it. Every behaviour below is asserted in
   trigger mode elsewhere in this file - the point here is that inline mode
   inherits it rather than reimplementing it, which is exactly what rule 5 in
   CLAUDE.md exists to prevent.
   ========================================================================== */
describe('QFSearchSelect - inline mode', () => {
  function mountInline(opts = {}) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = jest.fn();
    const sel = new QFSearchSelect(host, {
      options: MINERALS,
      inline: true,
      onChange,
      ...opts,
    });
    return { host, sel, onChange };
  }

  function typeInline(sel, text) {
    sel.inputEl.value = text;
    sel.inputEl.dispatchEvent(new window.Event('input'));
  }

  test('renders a search field, not a trigger button', () => {
    const { host, sel } = mountInline();

    expect(host.querySelector('.qf-ss-inline-input')).not.toBeNull();
    expect(host.querySelector('.qf-ss-trigger')).toBeNull();
    // The input must exist before any interaction - it IS the control.
    expect(sel.inputEl).not.toBeNull();
  });

  test('no row is highlighted on first paint (binding rule 2)', () => {
    const { sel } = mountInline();
    sel.openMenu();

    expect(sel.hiIndex).toBe(-1);
    expect(highlighted(sel)).toHaveLength(0);
  });

  test('the list is hidden until opened', () => {
    const { sel } = mountInline();
    expect(sel.listEl.hidden).toBe(true);

    sel.openMenu();
    expect(sel.listEl.hidden).toBe(false);
  });

  test('focusing the field opens the list', () => {
    const { sel } = mountInline();
    sel.inputEl.dispatchEvent(new window.Event('focus'));

    expect(sel.open).toBe(true);
    expect(sel.listEl.hidden).toBe(false);
  });

  test('arrow keys move the highlight without rebuilding rows (rule 2a)', () => {
    const { sel } = mountInline();
    sel.openMenu();

    const before = rows(sel);
    sel.inputEl.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown' }));

    const after = rows(sel);
    // Element IDENTITY, not just class placement: re-querying after a rebuild
    // would pass while the bug is present.
    expect(after[0]).toBe(before[0]);
    expect(after[0].classList.contains('qf-ss-hi')).toBe(true);
  });

  test('hover moves the highlight without rebuilding rows (rule 2a)', () => {
    const { sel } = mountInline();
    sel.openMenu();

    const before = rows(sel);
    before[2].dispatchEvent(new window.MouseEvent('mouseenter'));

    const after = rows(sel);
    expect(after[2]).toBe(before[2]);
    expect(sel.hiIndex).toBe(2);
  });

  test('clicking a row selects it', () => {
    const { sel, onChange } = mountInline();
    sel.openMenu();

    rows(sel)[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].target.value).toBe('Pyerite');
  });

  test('Enter selects the highlighted row', () => {
    const { sel, onChange } = mountInline();
    sel.openMenu();

    sel.inputEl.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown' }));
    sel.inputEl.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));

    expect(onChange.mock.calls[0][0].target.value).toBe('Tritanium');
  });

  test('selecting clears the typed query', () => {
    // Regression: a stale query left behind means the user picks an item, later
    // clears the selection, and finds their half-typed text still in the box.
    const { sel } = mountInline();
    typeInline(sel, 'Pye');
    rows(sel)[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(sel.inputEl.value).toBe('');
    expect(sel.query).toBe('');
  });

  test('keepQueryOnSelect leaves the query in place', () => {
    const { sel } = mountInline({ keepQueryOnSelect: true });
    typeInline(sel, 'Pye');
    rows(sel)[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(sel.inputEl.value).toBe('Pye');
  });

  test('the clear button resets query and results', () => {
    // Regression: the clear button returns focus to the field so the user can
    // retype, but the focus handler opens the list - so a naive implementation
    // clears the text and leaves the results panel sitting open.
    const { sel } = mountInline();
    typeInline(sel, 'Pye');
    expect(sel.clearEl.hidden).toBe(false);

    sel.clearEl.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(sel.inputEl.value).toBe('');
    expect(sel.open).toBe(false);
    expect(sel.listEl.hidden).toBe(true);
    expect(sel.clearEl.hidden).toBe(true);
    // Focus really was returned - without this the assertion above could pass
    // simply because the reopen path never ran.
    expect(document.activeElement).toBe(sel.inputEl);
  });

  test('closing keeps the input alive so typing is not interrupted', () => {
    // Trigger mode destroys its input on close; inline mode must NOT - the
    // field is the control and blurring it mid-word would be a real bug.
    const { sel } = mountInline();
    sel.openMenu();
    const input = sel.inputEl;

    sel.close();

    expect(sel.inputEl).toBe(input);
    expect(sel.inputEl.isConnected).toBe(true);
    expect(sel.listEl.hidden).toBe(true);
  });

  test('Escape closes AND clears the field', () => {
    // The field persists in inline mode, so closing alone would leave the typed
    // query sitting there with no results under it. Trigger mode gets this for
    // free because it discards its input on close.
    const { sel } = mountInline();
    typeInline(sel, 'Pye');

    expect(() => {
      sel.inputEl.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    }).not.toThrow();

    expect(sel.open).toBe(false);
    expect(sel.inputEl.value).toBe('');
    expect(sel.query).toBe('');
  });

  test('the search icon is laid out in-flow, not absolutely positioned', () => {
    // The icon is shared with the popover search, where it is absolutely
    // positioned OVER the input. Inline mode lays it out as a flex sibling; if
    // the absolute positioning is not reset, typed text runs underneath it.
    const css = require('fs').readFileSync(
      require('path').join(__dirname, '../../public/shared/components.css'),
      'utf8'
    );
    const rule = css.match(
      /\.qf-ss-inline-field\s+\.qf-ss-search-icon\s*\{[^}]*\}/
    );
    expect(rule).not.toBeNull();
    expect(rule[0]).toMatch(/position:\s*static/);
  });

  test('renderRow decorates a row without breaking selection', () => {
    const { sel, onChange } = mountInline({
      renderRow: (opt, els) => {
        const badge = document.createElement('span');
        badge.className = 'test-badge';
        badge.textContent = 'T2';
        els.row.appendChild(badge);
      },
    });
    sel.openMenu();

    expect(rows(sel)[0].querySelector('.test-badge')).not.toBeNull();

    // The decorator runs last, so click/hover wiring must still work.
    rows(sel)[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('a throwing renderRow does not take out the list', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { sel } = mountInline({
      renderRow: () => { throw new Error('decorator blew up'); },
    });
    sel.openMenu();

    expect(rows(sel)).toHaveLength(MINERALS.length);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('destroy removes the document listener even when already closed', () => {
    const { sel } = mountInline();
    const spy = jest.spyOn(document, 'removeEventListener');

    sel.destroy();

    expect(spy).toHaveBeenCalledWith('mousedown', expect.any(Function), true);
    spy.mockRestore();
  });

  test('scroll-into-view indexes rows, not listEl children', () => {
    // The list can contain non-row children (empty state, future group
    // headers); a positional lookup would scroll to the wrong element.
    const { sel } = mountInline();
    sel.openMenu();
    sel.hiIndex = 2;

    const target = rows(sel)[2];
    Object.defineProperty(target, 'offsetTop', { value: 500, configurable: true });
    Object.defineProperty(target, 'offsetHeight', { value: 40, configurable: true });
    Object.defineProperty(sel.listEl, 'clientHeight', { value: 100, configurable: true });
    sel.listEl.scrollTop = 0;

    sel._scrollHighlightIntoView();

    expect(sel.listEl.scrollTop).toBe(440);
  });
});
