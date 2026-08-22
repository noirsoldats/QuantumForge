/**
 * @jest-environment jsdom
 *
 * Manufacturing Plans - the shell: registration, mount, the plan sidebar
 * (filtering and selection) and the Overview tab.
 *
 * Split out of the original single Plans suite; the shared fake backend and
 * mount helpers live in ./helpers/plans-harness.
 */

// Several tests assert against the stylesheet text, because jsdom applies no
// stylesheets and `el.hidden` proves nothing about what the user sees.
const fs = require('fs');
const path = require('path');

const h = require('./helpers/plans-harness');

h.installHooks();

const { state, mountView, mountWithPlan, openTab, settle } = h;


describe('registration', () => {
  test('registers as a native shell view, not a separate window', () => {
    expect(state.registered.id).toBe('manufacturing-plans');
    expect(typeof state.registered.def.mount).toBe('function');
  });
});

describe('mount', () => {
  test('renders the view and starts with no plan selected', async () => {
    const { container } = await mountView();
    await settle();

    expect(container.querySelector('#mp-view')).not.toBeNull();
    expect(document.getElementById('no-plan-selected').hidden).toBe(false);
    expect(document.getElementById('plan-detail').hidden).toBe(true);
  });

  test('every element toggled by `hidden` is hideable by CSS (rule 6a)', () => {
    // jsdom applies no stylesheets, so el.hidden proves nothing about what the
    // user sees. Assert against the real CSS instead.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/manufacturing-plans-view.css'),
      'utf8'
    );
    expect(css).toMatch(/#mp-view\s*\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  test('materials are a real <table>, not divs pretending to be one', async () => {
    // This is tabular data, and the browser's table layout sizes every
    // column across ALL rows at once - the one thing per-row grids cannot
    // do, and the reason column alignment kept fighting us here.
    await openTab('materials');

    const table = document.getElementById('mp-materials-table');
    expect(table.tagName).toBe('TABLE');
    expect(table.querySelector('thead')).not.toBeNull();
    expect(table.querySelector('tbody')).not.toBeNull();
    expect(table.querySelector('tfoot')).not.toBeNull();
  });

  test('header cells are <th scope="col">', async () => {
    await openTab('materials');

    const ths = document.querySelectorAll('#mp-materials-header th');
    expect(ths.length).toBe(10);
    expect(ths[0].getAttribute('scope')).toBe('col');
    expect(ths[0].textContent).toBe('Material');
  });

  test('rows are <tr> of <td>, one cell per column', async () => {
    await openTab('materials');

    const row = document.querySelector('#mp-materials-body tr.mp-materials-row');
    expect(row.tagName).toBe('TR');
    expect(row.querySelectorAll('td')).toHaveLength(10);
  });

  test('a group heading spans every column', async () => {
    // colspan, natively - not a grid-column hack.
    await openTab('materials');

    const cell = document.querySelector('#mp-materials-body .mp-mat-group-row td');
    expect(cell.colSpan).toBe(10);
    expect(cell.querySelector('.mp-mat-group')).not.toBeNull();
  });

  test('the column count follows Show Owned', async () => {
    await openTab('materials');
    const toggle = document.getElementById('mp-show-owned');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    await settle(30);

    expect(document.querySelectorAll('#mp-materials-header th')).toHaveLength(12);
    expect(
      document.querySelector('#mp-materials-body tr.mp-materials-row').querySelectorAll('td')
    ).toHaveLength(12);
    expect(document.querySelector('#mp-materials-body .mp-mat-group-row td').colSpan).toBe(12);
  });

  test('a table wider than the pane scrolls instead of being clipped', () => {
    // The frame carried `overflow: hidden`, so anything past the pane edge
    // was cut off with no way to reach it. The scroller is the element
    // OUTSIDE the frame; the frame must grow to the table, and the scroller
    // needs min-width:0 or it stretches rather than scrolling.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/manufacturing-plans-view.css'),
      'utf8'
    );

    const frame = css.match(/#mp-view\s+\.mp-materials-frame\s*\{[^}]*\}/)[0];
    expect(frame).not.toMatch(/overflow/);
    expect(frame).toMatch(/width:\s*max-content/);

    const scroll = css.match(/#mp-view\s+\.mp-materials-scroll\s*\{[^}]*\}/)[0];
    expect(scroll).toMatch(/overflow:\s*auto/);
    expect(scroll).toMatch(/min-width:\s*0/);

    const table = css.match(/#mp-view\s+\.mp-materials-table\s*\{[^}]*\}/)[0];
    expect(table).toMatch(/min-width:\s*max-content/);
  });

  test('the table sets no explicit column widths', () => {
    // The browser sizes columns from content. Only the name column is
    // capped, so a long name ellipses rather than crowding the figures.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/manufacturing-plans-view.css'),
      'utf8'
    );
    const rule = css.match(/#mp-view\s+\.mp-materials-table\s*\{[^}]*\}/g).join('');
    // No FIXED floor - a 1200px min-width added empty space and pushed the
    // far columns off screen. `min-width: max-content` is different: it is
    // the content's own width, and is what lets the table overflow into its
    // scroller rather than being squeezed.
    expect(rule).not.toMatch(/min-width:\s*\d/);
    expect(rule).toMatch(/table-layout:\s*auto/);
    expect(css).toMatch(/\.mp-col-name\s*\{[^}]*max-width:\s*320px/);
  });

  test('the material name is a shrinkable flex, not inline-flex', () => {
    // An inline-flex sizes to its content and refused to shrink, so the icon
    // plus a long name overflowed the cell and printed over the next column.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/manufacturing-plans-view.css'),
      'utf8'
    );
    const rule = css.match(/#mp-view\s+\.mp-mat-name\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).not.toMatch(/inline-flex/);
    expect(rule).toMatch(/min-width:\s*0/);
  });

  test('a truncated material name is recoverable on hover', async () => {
    // Capping the column means long names ellipsis - the full name has to
    // stay reachable.
    await openTab('materials');

    const cell = document.querySelector('#mp-materials-body .mp-mat-name span[title]');
    expect(cell.title).toBe('Tritanium');
  });

  test('the character picker is a QFSearchSelect (rule 5)', async () => {
    // Searchable: a user can have many characters.
    await mountView();
    await settle();

    expect(document.querySelector('#mp-character-host .qf-ss-trigger')).not.toBeNull();
  });

  test('the market picker is a plain select', async () => {
    // A short list of the user's own market sets - searching a handful of
    // names is friction rather than help.
    await mountView();
    await settle();

    expect(document.querySelector('#mp-market-host select')).not.toBeNull();
    expect(document.querySelector('#mp-market-host .qf-ss-trigger')).toBeNull();
  });

  test('lists the plans for the default character only', async () => {
    state.plans.push({
      planId: 'plan-other',
      characterId: 96061222,
      planName: 'Alt Plan',
      status: 'active',
      createdAt: 1,
    });
    await mountView();
    await settle();

    const cards = document.querySelectorAll('.mp-plan-card');
    expect(cards).toHaveLength(2);
    expect(document.getElementById('plans-list').textContent).not.toContain('Alt Plan');
  });
});

describe('plan list filtering', () => {
  test('search narrows the list', async () => {
    await mountView();
    await settle();

    const search = document.getElementById('plan-search');
    search.value = 'Hulk';
    search.dispatchEvent(new window.Event('input'));

    const cards = document.querySelectorAll('.mp-plan-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('Q4 Hulk Batch');
  });

  test('status filter narrows the list', async () => {
    await mountView();
    await settle();

    document
      .querySelector('.mp-status-filter[data-mp-status="completed"]')
      .dispatchEvent(new window.MouseEvent('click'));

    const cards = document.querySelectorAll('.mp-plan-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('Old Frigates');
  });

  test('the active filter is marked exclusively', async () => {
    await mountView();
    await settle();

    document
      .querySelector('.mp-status-filter[data-mp-status="active"]')
      .dispatchEvent(new window.MouseEvent('click'));

    const active = document.querySelectorAll('.mp-status-filter.is-active');
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute('data-mp-status')).toBe('active');
  });
});

describe('plan selection', () => {
  test('selecting a plan reveals the detail pane', async () => {
    await mountWithPlan();

    expect(document.getElementById('no-plan-selected').hidden).toBe(true);
    expect(document.getElementById('plan-detail').hidden).toBe(false);
    expect(document.getElementById('plan-name').textContent).toBe('Q4 Hulk Batch');
  });

  test('the selected card is marked', async () => {
    await mountWithPlan();

    const selected = document.querySelectorAll('.mp-plan-card.is-selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute('data-plan-id')).toBe('plan-1');
  });

  test('opens on Overview', async () => {
    await mountWithPlan();

    expect(document.getElementById('overview-tab').classList.contains('active')).toBe(true);
    expect(
      document.querySelector('.tab-button[data-tab="overview"]').classList.contains('active')
    ).toBe(true);
  });
});

describe('overview', () => {
  test('renders the locked cost basis', async () => {
    await mountWithPlan();

    expect(document.getElementById('mp-stat-material-cost').textContent).toContain('100,000');
    expect(document.getElementById('mp-stat-product-value').textContent).toContain('150,000');
    expect(document.getElementById('mp-stat-profit').textContent).toContain('45,000');
  });

  test('shows the drift banner when a material has moved past the threshold', async () => {
    await mountWithPlan();

    const banner = document.getElementById('mp-drift-banner');
    expect(banner.hidden).toBe(false);
    expect(document.getElementById('mp-drift-banner-head').textContent).toContain('1 material');
  });

  test('hides the drift banner when nothing has moved', async () => {
    state.drift = {
      34: { livePrice: 5.0, lockedPrice: 5.0, driftPercent: 0, driftAbsolute: 0 },
      35: { livePrice: 10.0, lockedPrice: 10.0, driftPercent: 0, driftAbsolute: 0 },
    };
    await mountWithPlan();

    expect(document.getElementById('mp-drift-banner').hidden).toBe(true);
  });

  test('the live-cost comparison is a number, never NaN', async () => {
    // liveMaterialCost multiplied by the wrong field name, so this rendered
    // "NaN% if re-priced live".
    await mountWithPlan();

    const driftEl = document.getElementById('mp-stat-cost-drift');
    expect(driftEl.hidden).toBe(false);
    expect(driftEl.textContent).not.toContain('NaN');
    expect(driftEl.textContent).toMatch(/[+-]?\d+\.\d%/);
  });

  test('live-cost profit shows a figure, not a dash', async () => {
    await mountWithPlan();

    const profitLive = document.getElementById('mp-stat-profit-live');
    expect(profitLive.hidden).toBe(false);
    expect(profitLive.textContent).not.toContain('—');
    expect(profitLive.textContent).toMatch(/[\d,]+\.\d{2}/);
  });

  test('a partially-priced plan shows no live comparison at all', async () => {
    // A partial total understates the comparison; better to show nothing than
    // "-40%" computed from half the materials.
    state.drift = { 34: { livePrice: 6, lockedPrice: 5, driftPercent: 20, driftAbsolute: 1 } };
    await mountWithPlan();

    expect(document.getElementById('mp-stat-cost-drift').hidden).toBe(true);
    expect(document.getElementById('mp-stat-profit-live').hidden).toBe(true);
  });

  test('drift NEVER changes the displayed locked cost', async () => {
    // The core guarantee: a 20% market move leaves the plan's cost basis alone.
    await mountWithPlan();

    expect(document.getElementById('mp-stat-material-cost').textContent).toContain('100,000');
    // ...and the live comparison is shown SEPARATELY.
    expect(document.getElementById('mp-stat-cost-drift').hidden).toBe(false);
  });
});

