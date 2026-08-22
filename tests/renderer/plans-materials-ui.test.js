/**
 * @jest-environment jsdom
 *
 * Manufacturing Plans - the Materials tab.
 *
 * Binding rule 7 is the point here: a plan's prices are LOCKED, so every
 * drift figure is a read-only comparison and "the locked number did not move"
 * is the primary assertion.
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

const { state, openTab, settle } = h;

describe('materials', () => {
  test('renders a row per material, grouped by category', async () => {
    await openTab('materials');

    expect(document.querySelectorAll('#mp-materials-body .mp-mat-group')).toHaveLength(2);
    expect(document.querySelectorAll('#mp-materials-body .mp-materials-row')).toHaveLength(3);
  });

  test('groups by EVE sourcing category, not the raw SDE category name', async () => {
    // The SDE calls Tritanium's category "Material", which lumps minerals,
    // ice, moon goo and salvage into one meaningless bucket. The groupID is
    // what separates them.
    await openTab('materials');

    const headings = Array.from(document.querySelectorAll('#mp-materials-body .mp-mat-group'))
      .map((h) => h.textContent);
    expect(headings[0]).toContain('Minerals');
    expect(headings[1]).toContain('Ice Products');
    expect(headings.join(' ')).not.toContain('Material ');
  });

  test('categories appear in sourcing order, not insertion order', async () => {
    // Minerals before Ice Products regardless of which material came first.
    state.materials.reverse();
    await openTab('materials');

    const headings = Array.from(document.querySelectorAll('#mp-materials-body .mp-mat-group'))
      .map((h) => h.textContent);
    expect(headings[0]).toContain('Minerals');
    expect(headings[1]).toContain('Ice Products');
  });

  test('an unclassifiable material falls into Other', async () => {
    state.categories[16275] = { categoryID: 9999, groupID: 9999 };
    await openTab('materials');

    const headings = Array.from(document.querySelectorAll('#mp-materials-body .mp-mat-group'))
      .map((h) => h.textContent);
    expect(headings.some((h) => h.includes('Other'))).toBe(true);
  });

  test('empty categories are not rendered', async () => {
    await openTab('materials');

    const headings = Array.from(document.querySelectorAll('#mp-materials-body .mp-mat-group'))
      .map((h) => h.textContent);
    expect(headings.some((h) => h.includes('Planetary Materials'))).toBe(false);
  });

  describe('acquisition pills', () => {
    test('distinguishes a manual ledger entry from a confirmed ESI match', async () => {
      // These are DIFFERENT sources and both can be true at once. Styled
      // alike they read as one thing duplicated.
      state.materials[0].acquisitionMethod = 'purchased';
      state.materials[0].purchaseMatchCount = 3;
      state.materials[0].purchasedQuantity = 750;
      await openTab('materials');

      const row = document.querySelectorAll('#mp-materials-body tr.mp-materials-row')[0];
      expect(row.querySelectorAll('.mp-acq-manual')).toHaveLength(1);
      expect(row.querySelectorAll('.mp-acq-esi')).toHaveLength(1);
    });

    test('each pill says where it came from', async () => {
      state.materials[0].acquisitionMethod = 'purchased';
      state.materials[0].purchaseMatchCount = 3;
      state.materials[0].purchasedQuantity = 750;
      await openTab('materials');

      const row = document.querySelectorAll('#mp-materials-body tr.mp-materials-row')[0];
      expect(row.querySelector('.mp-acq-manual').title).toContain("ledger");
      expect(row.querySelector('.mp-acq-esi').title).toContain('wallet transaction');
      expect(row.querySelector('.mp-acq-esi').title).toContain('750');
    });

    test('a built match reads as an industry job, not a purchase', async () => {
      state.materials[0].acquisitionMethod = null;
      state.materials[0].purchaseMatchCount = 0;
      state.materials[0].manufacturingMatchCount = 1;
      state.materials[0].manufacturedQuantity = 200;
      await openTab('materials');

      const pill = document.querySelectorAll('#mp-materials-body tr.mp-materials-row')[0]
        .querySelector('.mp-acq-esi');
      expect(pill.textContent).toBe('1 built');
      // Singular, because there is exactly one.
      expect(pill.title).toContain('1 confirmed industry job matched');
    });

    test('pills stack vertically so two do not widen the column', () => {
      // Side by side - even wrapping - the column sizes to the widest LINE,
      // so a second pill doubled the column width for every row in the
      // table. Stacked, it only has to fit the widest single pill.
      const css = fs.readFileSync(
        path.join(__dirname, '../../public/manufacturing-plans-view.css'),
        'utf8'
      );
      const rule = css.match(/#mp-view\s+\.mp-acq-stack\s*\{[^}]*\}/)[0];
      expect(rule).toMatch(/flex-direction:\s*column/);
      expect(rule).not.toMatch(/flex-wrap/);
      // Without this the pills stretch to the full column width.
      expect(rule).toMatch(/align-items:\s*center/);
    });

    test('the acquisition <td> stays a table-cell, so the column stays aligned', () => {
      // `display: flex` on a <td> removes it from the table's internal box
      // model - the browser wraps it in an anonymous table-cell and it no
      // longer shares column widths or vertical alignment with the header,
      // footer and other rows. That is what knocked this column out of line
      // with its own row. The stacking belongs on .mp-acq-stack instead.
      const css = fs.readFileSync(
        path.join(__dirname, '../../public/manufacturing-plans-view.css'),
        'utf8'
      );
      const rule = css.match(/#mp-view\s+\.mp-acq-cell\s*\{[^}]*\}/)[0];
      expect(rule).not.toMatch(/display:\s*(flex|grid|inline-flex|block)/);
    });

    test('the pills live in the stack wrapper, not directly in the cell', async () => {
      state.materials[0].acquisitionMethod = 'Purchased';
      await openTab('materials');

      const cell = document.querySelectorAll('#mp-materials-body tr.mp-materials-row')[0]
        .querySelector('td.mp-acq-cell');
      // One child only: the wrapper. Pills appended straight to the <td>
      // would mean the cell is doing the stacking again.
      expect(cell.children.length).toBe(1);
      expect(cell.children[0].className).toBe('mp-acq-stack');
      expect(cell.querySelector('.mp-acq-stack .mp-acq-pill')).not.toBeNull();
    });

    test('a material with nothing recorded reads "Not Acquired"', async () => {
      state.materials[0].acquisitionMethod = null;
      state.materials[0].purchaseMatchCount = 0;
      await openTab('materials');

      const row = document.querySelectorAll('#mp-materials-body tr.mp-materials-row')[0];
      expect(row.querySelector('.mp-acq-none').textContent).toBe('Not Acquired');
      expect(row.querySelector('.mp-acq-pill')).toBeNull();
    });
  });

  test('renders real names, never "Type ######"', async () => {
    // No plan IPC resolves names; a missing ensureNames() call showed raw ids
    // across five tabs.
    await openTab('materials');

    const text = document.getElementById('mp-materials-body').textContent;
    expect(text).toContain('Tritanium');
    expect(text).not.toMatch(/Type \d+/);
  });

  test('quantity and locked price come from the REAL field names', async () => {
    // quantity (not quantityNeeded) and basePrice (not priceEach). Reading the
    // wrong names produced blank columns and NaN totals.
    await openTab('materials');

    const row = document.querySelectorAll('#mp-materials-body .mp-materials-row')[0];
    expect(row.textContent).toContain('1,000');   // quantity
    expect(row.textContent).toContain('5.00');    // basePrice
    expect(row.textContent).not.toContain('NaN');
  });

  test('still-needed subtracts ALL acquisition sources', async () => {
    // Manual + purchased + manufactured. Counting one over-reports what is
    // left to buy.
    state.materials[0].manuallyAcquiredQuantity = 100;
    state.materials[0].purchasedQuantity = 250;
    state.materials[0].manufacturedQuantity = 50;
    await openTab('materials');

    const row = document.querySelectorAll('#mp-materials-body .mp-materials-row')[0];
    // 1000 - (100 + 250 + 50) = 600
    expect(row.textContent).toContain('600');
  });

  describe('inline price override editing', () => {
    async function startEdit() {
      await openTab('materials');
      document
        .querySelector('[data-mp-price-type="34"]')
        .dispatchEvent(new window.MouseEvent('click'));
      return document.querySelector('[data-mp-price-type="34"] .mp-price-input');
    }

    test('clicking the locked price opens an editor seeded with it', async () => {
      const input = await startEdit();
      expect(input).not.toBeNull();
      expect(parseFloat(input.value)).toBe(5);
    });

    test('an UNCHANGED value writes nothing', async () => {
      // Pinning an override equal to the locked price would survive future
      // re-locks for no reason.
      const input = await startEdit();
      input.value = '5';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
      await settle(20);

      expect(state.calls.some((c) => c.fn === 'plans.setPriceOverride')).toBe(false);
    });

    test('a changed value writes the override', async () => {
      const input = await startEdit();
      input.value = '9.75';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
      await settle(30);

      const call = state.calls.find((c) => c.fn === 'plans.setPriceOverride');
      expect(call.typeId).toBe(34);
      expect(call.price).toBe(9.75);
    });

    test('Escape abandons the edit without writing', async () => {
      const input = await startEdit();
      input.value = '999';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      await settle(20);

      expect(state.calls.some((c) => c.fn === 'plans.setPriceOverride')).toBe(false);
      // ...and the original value is back on screen.
      expect(document.querySelector('[data-mp-price-type="34"]').textContent).toContain('5.00');
    });

    test('clearing the field removes an EXISTING override', async () => {
      state.materials[0].planOverridePrice = 9.75;
      const input = await startEdit();
      input.value = '';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
      await settle(30);

      expect(state.calls.find((c) => c.fn === 'plans.removePriceOverride').typeId).toBe(34);
    });

    test('clearing a field with no override is a no-op', async () => {
      const input = await startEdit();
      input.value = '';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
      await settle(20);

      expect(state.calls.some((c) => c.fn === 'plans.removePriceOverride')).toBe(false);
      expect(state.calls.some((c) => c.fn === 'plans.setPriceOverride')).toBe(false);
    });

    test('a zero or negative price is rejected', async () => {
      const input = await startEdit();
      input.value = '0';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
      await settle(20);

      expect(state.calls.some((c) => c.fn === 'plans.setPriceOverride')).toBe(false);
      expect(state.calls.some((c) => c.fn === 'toast' && c.type === 'warning')).toBe(true);
    });
  });

  test('a plan price override REPLACES the locked market price', async () => {
    // Showing basePrice for an overridden material misreports the plan's own
    // cost basis - the one number this screen exists to protect.
    state.materials[0].planOverridePrice = 9.75;
    await openTab('materials');

    const row = document.querySelectorAll('#mp-materials-body .mp-materials-row')[0];
    expect(row.textContent).toContain('9.75');
    expect(row.querySelector('.mp-overridden')).not.toBeNull();
    // 1000 x 9.75, not 1000 x 5.00
    expect(row.textContent).toContain('9,750');
  });

  test('shows locked and live prices in separate columns', async () => {
    await openTab('materials');

    const row = document.querySelectorAll('#mp-materials-body .mp-materials-row')[0];
    const cells = row.querySelectorAll('span');
    const text = row.textContent;

    expect(text).toContain('Tritanium');
    // Locked 5.00 and live 6.00 both present, and distinct.
    expect(text).toContain('5.00');
    expect(text).toContain('6.00');
    expect(cells.length).toBeGreaterThan(0);
  });

  test('drift is shown as a percentage with direction', async () => {
    await openTab('materials');

    const drifts = document.querySelectorAll('#mp-materials-body .mp-drift');
    expect(drifts[0].textContent).toBe('+20.0%');
    // Up is bad for something you still have to buy.
    expect(drifts[0].classList.contains('is-up')).toBe(true);
    expect(drifts[1].classList.contains('is-flat')).toBe(true);
  });

  test('a material with no drift data shows an em dash, not 0%', async () => {
    // "Could not price" and "has not moved" are different answers.
    state.drift = {};
    await openTab('materials');

    const drifts = document.querySelectorAll('#mp-materials-body .mp-drift');
    expect(drifts[0].textContent).toBe('—');
  });

  test('totals the locked cost, live cost and volume', async () => {
    await openTab('materials');

    // locked: 1000*5 + 500*10 + 400*800 = 330,000
    expect(document.getElementById('mp-total-locked').textContent).toContain('330,000');
    // live:   1000*6 + 500*10 + 400*800 = 331,000
    expect(document.getElementById('mp-total-live').textContent).toContain('331,000');
    expect(document.getElementById('mp-total-m3').textContent).toContain('m³');
  });

  test('collapsing a category hides its rows but keeps the header', async () => {
    await openTab('materials');

    // Collapse the first group only; the second stays open, which is what
    // proves collapse is per-category rather than global.
    document
      .querySelector('#mp-materials-body .mp-mat-group')
      .dispatchEvent(new window.MouseEvent('click'));

    expect(document.querySelectorAll('#mp-materials-body .mp-mat-group')).toHaveLength(2);
    const rows = document.querySelectorAll('#mp-materials-body .mp-materials-row');
    // Minerals' two rows are gone; Ice Products' single row remains.
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Strontium Clathrates');
  });

  test('"Show Owned" re-reads materials with the flag set', async () => {
    await openTab('materials');
    state.calls.length = 0;

    const toggle = document.getElementById('mp-show-owned');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.getMaterials');
    expect(call.includeAssets).toBe(true);
  });

  describe('Show Owned columns', () => {
    async function showOwned() {
      await openTab('materials');
      const toggle = document.getElementById('mp-show-owned');
      toggle.checked = true;
      toggle.dispatchEvent(new window.Event('change'));
      await settle(30);
    }

    test('adds the two Owned columns to the header', async () => {
      // Re-reading with the flag set is not enough - the data has to land in
      // columns, which is what was missing.
      const header = () => document.getElementById('mp-materials-header').textContent;
      await openTab('materials');
      expect(header()).not.toContain('Owned');

      await showOwned();
      expect(header()).toContain('Owned (Personal)');
      expect(header()).toContain('Owned (Corp)');
    });

    test('shows the personal and corp quantities per row', async () => {
      await showOwned();

      const cells = document.querySelectorAll(
        '#mp-materials-body .mp-materials-row .mp-owned-cell'
      );
      // Three rows x two owned columns.
      expect(cells).toHaveLength(6);
      const texts = Array.from(cells).map((c) => c.textContent);
      expect(texts).toContain('150');
      expect(texts).toContain('900');
    });

    test('breaks the holdings down by holder on hover', async () => {
      // The total does not say WHERE the stock is, which is what decides
      // whether it can actually be used.
      await showOwned();

      const withTip = Array.from(
        document.querySelectorAll('#mp-materials-body .mp-owned-cell')
      ).filter((c) => c.classList.contains('mp-has-tooltip'));

      expect(withTip).toHaveLength(2);
      expect(withTip[0].title).toContain('Valen Kor: 150');
      expect(withTip[1].title).toContain('Forge Dynamics - Component Stock: 900');
    });

    test('a row holding nothing gets no hover breakdown', async () => {
      await showOwned();

      const row = document.querySelectorAll('#mp-materials-body .mp-materials-row')[0];
      const owned = row.querySelectorAll('.mp-owned-cell');
      expect(owned[0].textContent).toBe('0');
      expect(owned[0].classList.contains('mp-has-tooltip')).toBe(false);
    });

    test('the header, rows and totals keep the same column count', async () => {
      // A mismatch shifts every figure into the wrong column.
      await showOwned();

      expect(document.querySelectorAll('#mp-materials-header th')).toHaveLength(12);
      expect(document.querySelectorAll('#mp-materials-total td')).toHaveLength(12);
      expect(
        document.querySelector('#mp-materials-body tr.mp-materials-row')
          .querySelectorAll('td')
      ).toHaveLength(12);
    });

    test('turning it off removes the columns again', async () => {
      await showOwned();

      const toggle = document.getElementById('mp-show-owned');
      toggle.checked = false;
      toggle.dispatchEvent(new window.Event('change'));
      await settle(30);

      expect(document.getElementById('mp-materials-header').textContent)
        .not.toContain('Owned');
      expect(document.querySelectorAll('#mp-materials-body .mp-owned-cell'))
        .toHaveLength(0);
    });
  });

  test('changing the market set re-reads DRIFT only', async () => {
    await openTab('materials');
    state.calls.length = 0;

    // Picking a different comparison market must not re-read or rewrite the
    // plan's own materials - only the live side changes.
    const sel = document.querySelector('#mp-market-host select');
    sel.value = 'set-amarr';
    sel.dispatchEvent(new window.Event('change'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'plans.getMaterialDrift')).toBe(true);
    expect(state.calls.some((c) => c.fn === 'plans.getMaterials')).toBe(false);
  });
});

