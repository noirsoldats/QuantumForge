/**
 * @jest-environment jsdom
 *
 * Market Manager - first-load resilience.
 *
 * Regressions for the "Overrides count shows 0 until you click the tab" class
 * of bug, where one panel's throw aborted every render after it.
 *
 * Split out of the original single market suite; the shared fake backend and
 * mount helpers live in ./helpers/market-harness.
 */

const h = require('./helpers/market-harness');

h.installHooks();

const { state, mount, allowErrors } = h;

/**
 * Regressions for the "Overrides count shows 0 until you click the tab" bug.
 *
 * Cause: loadAll() ran its renders as a bare sequence, so a throw in
 * renderPricing() aborted every render after it - including renderOverrides() -
 * leaving those panels on their template defaults. The trigger was reading
 * set.inputMaterials as an array when it is a pricing-config OBJECT.
 */
describe('first-load rendering resilience', () => {
  test('override counters populate on first load, before any tab is clicked', async () => {
    state.overrides = [{ typeId: 23911, price: 5, notes: 'floor', timestamp: 1 }];
    await mount();

    // Still on the default Pricing tab - these must already be correct.
    expect(document.querySelector('.mk-tab.is-active').dataset.mkTab).toBe('pricing');
    expect(document.getElementById('mk-override-count').textContent).toBe('1');
    expect(document.getElementById('mk-tab-override-count').textContent).toBe('1');
  });

  test('override rows show the item name, not "Type <id>"', async () => {
    state.overrides = [{ typeId: 23911, price: 5, notes: null, timestamp: 1 }];
    await mount();

    const firstCell = document.querySelector('#mk-override-rows td');
    expect(firstCell.textContent).toBe('Zydrine');
    expect(firstCell.textContent).not.toMatch(/^Type /);
  });

  test('a market set is treated as pricing config, not an item list', async () => {
    // Regression: (set.inputMaterials || []).forEach threw here, killing every
    // later render. A config object must not crash the pricing tab.
    await mount();

    expect(document.getElementById('mk-rows')).not.toBeNull();
  });

  test('pricing rows show live buy/sell/volume from the order book', async () => {
    await mount();

    // Watchlist items (34, 35) seed the pricing rows.
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'));
    expect(row).toBeDefined();
    expect(row.querySelector('.mk-buy').textContent).not.toBe('--');
    expect(row.querySelector('.mk-sell').textContent).not.toBe('--');
  });

  test('an override replaces the sell figure and marks the row', async () => {
    state.overrides = [{ typeId: 34, price: 999, notes: null, timestamp: 1 }];
    await mount();

    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'));
    expect(row.querySelector('.mk-sell').textContent).toBe('999');
    expect(row.querySelector('.mk-conf').textContent).toBe('Override');
  });

  test('one failing panel does not blank the others', async () => {
    // A hostile set config throws wherever it is read - during the load phase
    // (loadWatchPrices) as well as during renderPricing. Both must be isolated,
    // or the Overrides panel never renders.
    allowErrors(/load failed: /, /render failed: /);
    state.sets = [{
      id: 1,
      name: 'Broken',
      isDefault: true,
      get inputMaterials() { throw new Error('boom'); },
      outputProducts: {},
    }];
    state.overrides = [{ typeId: 23911, price: 5, notes: null, timestamp: 1 }];

    await mount();

    expect(document.getElementById('mk-override-count').textContent).toBe('1');
    expect(document.querySelectorAll('#mk-override-rows tr')).toHaveLength(1);
  });
});

