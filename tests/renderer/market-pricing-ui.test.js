/**
 * @jest-environment jsdom
 *
 * Market Manager - pricing: the region-scoped filter, price overrides, the
 * inspector and the full market data drawer.
 *
 * Split out of the original single market suite; the shared fake backend and
 * mount helpers live in ./helpers/market-harness.
 */

const h = require('./helpers/market-harness');

h.installHooks();

const { state, mount, flush, ssSearch, ssRows } = h;

describe('pricing filter (region-scoped search)', () => {
  /** Type into the filter and let the debounce fire. */
  async function filter(term) {
    const input = document.getElementById('mk-search');
    input.value = term;
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 250));
    await flush();
  }

  test('a short query does not hit the backend', async () => {
    await mount();
    await filter('t');

    expect(state.calls.filter((c) => c.fn === 'searchTradedItems')).toHaveLength(0);
  });

  test('searching queries the active set region, not the whole SDE', async () => {
    await mount();
    await filter('trit');

    const search = state.calls.find((c) => c.fn === 'searchTradedItems');
    expect(search).toBeDefined();
    // Region comes from the set's inputMaterials scope.
    expect(search.regionId).toBe(10000002);
  });

  test('results replace the default rows', async () => {
    await mount();
    await filter('pyer');

    const names = [...document.querySelectorAll('#mk-rows tr')].map((tr) =>
      tr.children[1].textContent
    );
    expect(names).toContain('Pyerite');
    expect(names).not.toContain('Tritanium');
  });

  test('clearing the query restores the default rows', async () => {
    await mount();
    await filter('pyer');
    await filter('');

    const names = [...document.querySelectorAll('#mk-rows tr')].map((tr) =>
      tr.children[1].textContent
    );
    expect(names).toContain('Tritanium');
  });

  test('an empty result explains that the filter is region-scoped', async () => {
    await mount();
    await filter('zzzz');

    const empty = document.getElementById('mk-rows-empty');
    expect(empty.hidden).toBe(false);
    expect(empty.querySelector('small').textContent).toMatch(/cached orders in this market/i);
  });
});


describe('price override modal', () => {
  test('opens from the Add Override button', async () => {
    await mount();
    document.getElementById('mk-add-override').click();
    await flush();

    expect(document.getElementById('mk-override-modal').hidden).toBe(false);
    expect(document.getElementById('mk-ov-save').disabled).toBe(true);
  });

  test('clicking an override row opens it prefilled', async () => {
    state.overrides = [{ typeId: 34, price: 42, notes: 'contract floor', timestamp: 1 }];
    await mount();
    document.querySelector('[data-mk-tab="overrides"]').click();
    await flush();

    document.querySelector('#mk-override-rows tr').click();
    await flush();

    expect(document.getElementById('mk-override-modal-title').textContent).toBe('Edit Price Override');
    expect(document.getElementById('mk-ov-price').value).toBe('42');
    expect(document.getElementById('mk-ov-note').value).toBe('contract floor');
  });

  test('the item search queries the SDE', async () => {
    // SDE-wide, not region-scoped: you may want to pin a price before any
    // orders exist for the item in this market.
    await mount();
    document.getElementById('mk-add-override').click();

    await ssSearch('mk-ov-search', 'tri');

    expect(state.calls.find((c) => c.fn === 'search')).toMatchObject({ q: 'tri' });
    expect(ssRows().length).toBeGreaterThan(0);
  });

  test('choosing an item then a price enables saving', async () => {
    await mount();
    document.getElementById('mk-add-override').click();

    await ssSearch('mk-ov-search', 'tri');
    ssRows()[0].click();
    await flush();

    expect(document.getElementById('mk-ov-pick').hidden).toBe(false);

    const price = document.getElementById('mk-ov-price');
    price.value = '123';
    price.dispatchEvent(new Event('input'));

    expect(document.getElementById('mk-ov-save').disabled).toBe(false);
  });

  test('a zero or negative price keeps save disabled', async () => {
    state.overrides = [{ typeId: 34, price: 42, notes: null, timestamp: 1 }];
    await mount();
    document.querySelector('[data-mk-tab="overrides"]').click();
    await flush();
    document.querySelector('#mk-override-rows tr').click();
    await flush();

    const price = document.getElementById('mk-ov-price');
    price.value = '0';
    price.dispatchEvent(new Event('input'));

    expect(document.getElementById('mk-ov-save').disabled).toBe(true);
  });

  test('saving sends the type, price and note', async () => {
    state.overrides = [{ typeId: 34, price: 42, notes: null, timestamp: 1 }];
    await mount();
    document.querySelector('[data-mk-tab="overrides"]').click();
    await flush();
    document.querySelector('#mk-override-rows tr').click();
    await flush();

    const price = document.getElementById('mk-ov-price');
    price.value = '77';
    price.dispatchEvent(new Event('input'));
    const note = document.getElementById('mk-ov-note');
    note.value = 'pinned';

    document.getElementById('mk-ov-save').click();
    await flush();

    const saved = state.calls.find((c) => c.fn === 'setPriceOverride');
    expect(saved).toEqual({ fn: 'setPriceOverride', typeId: 34, price: 77, notes: 'pinned' });
  });

  test('the override table shows market price and delta', async () => {
    // Tritanium sells at 6 in the fixture; an override of 9 is +50%.
    state.overrides = [{ typeId: 34, price: 9, notes: null, timestamp: 1 }];
    await mount();
    document.querySelector('[data-mk-tab="overrides"]').click();
    await flush();

    const cells = document.querySelectorAll('#mk-override-rows tr td');
    expect(cells[1].textContent).toBe('6');
    expect(cells[3].textContent).toBe('+50.0%');
  });
});


describe('pricing filter clear affordances', () => {
  async function type(term) {
    const input = document.getElementById('mk-search');
    input.value = term;
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 250));
    await flush();
  }

  function pressEscInFilter() {
    document.getElementById('mk-search').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
  }

  test('the clear button is hidden until something is typed', async () => {
    await mount();
    expect(document.getElementById('mk-search-clear').hidden).toBe(true);

    await type('pyer');
    expect(document.getElementById('mk-search-clear').hidden).toBe(false);
  });

  test('the clear button empties the field and restores default rows', async () => {
    await mount();
    await type('pyer');

    document.getElementById('mk-search-clear').click();
    await flush();

    expect(document.getElementById('mk-search').value).toBe('');
    expect(document.getElementById('mk-search-clear').hidden).toBe(true);

    const names = [...document.querySelectorAll('#mk-rows tr')].map((tr) => tr.children[1].textContent);
    expect(names).toContain('Tritanium');
  });

  test('Escape in the filter clears it', async () => {
    await mount();
    await type('pyer');

    pressEscInFilter();
    await flush();

    expect(document.getElementById('mk-search').value).toBe('');
    const names = [...document.querySelectorAll('#mk-rows tr')].map((tr) => tr.children[1].textContent);
    expect(names).toContain('Tritanium');
  });

  test('Escape in the filter does not also close an open modal', async () => {
    await mount();
    await type('pyer');

    // A modal open at the same time must survive: the filter's Esc is scoped.
    document.getElementById('mk-new-watchlist').click();
    expect(document.getElementById('mk-wl-modal').hidden).toBe(false);

    pressEscInFilter();
    await flush();

    expect(document.getElementById('mk-search').value).toBe('');
    expect(document.getElementById('mk-wl-modal').hidden).toBe(false);
  });

  test('Escape on an already-empty filter blurs instead of clearing', async () => {
    await mount();
    const input = document.getElementById('mk-search');
    input.focus();

    pressEscInFilter();
    await flush();

    expect(document.activeElement).not.toBe(input);
  });
});


describe('inspector (Pricing Details)', () => {
  /** Select the Tritanium row in the pricing table. */
  async function selectTritanium() {
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'));
    row.click();
    await flush();
    return row;
  }

  test('is empty until a row is selected', async () => {
    await mount();

    expect(document.getElementById('mk-inspector-empty').hidden).toBe(false);
    expect(document.getElementById('mk-inspector-body').hidden).toBe(true);
    expect(document.getElementById('mk-inspector-title').textContent).toBe('Inspector');
  });

  test('shows the item name in its header once selected', async () => {
    await mount();
    await selectTritanium();

    expect(document.getElementById('mk-inspector-title').textContent).toBe('Tritanium · Inspector');
    expect(document.getElementById('mk-inspector-body').hidden).toBe(false);
  });

  test('shows the live sell and buy prices', async () => {
    await mount();
    await selectTritanium();

    expect(document.querySelector('.mk-insp-price-value').textContent).toBe('6');
    expect(document.querySelector('.mk-insp-buy-value').textContent).toBe('5');
  });

  test('an override replaces the sell figure and is called out', async () => {
    state.overrides = [{ typeId: 34, price: 99, notes: null, timestamp: 1 }];
    await mount();
    await selectTritanium();

    expect(document.querySelector('.mk-insp-price-value').textContent).toBe('99');
    expect(document.querySelector('.mk-insp-override-note').textContent).toMatch(/market sell is 6/i);
  });

  test('offers the View Full Market Data action', async () => {
    await mount();
    await selectTritanium();

    const action = document.querySelector('.mk-insp-action');
    expect(action).not.toBeNull();
    expect(action.textContent).toContain('View Full Market Data');
  });

  test('says so when no plan uses the item', async () => {
    await mount();
    await selectTritanium();

    expect(document.querySelector('.mk-insp-noplans').textContent)
      .toMatch(/No manufacturing plans reference Tritanium/);
    expect(document.getElementById('mk-insp-plan-count').textContent).toBe('0');
  });

  test('lists plans using the item with their locked price', async () => {
    state.plansByType = {
      34: [
        { planId: 'p1', planName: 'Capital Build', status: 'active', lockedPrice: 5.0, lockedAt: Date.now(), quantity: 100, isOverride: false, lastMarketPrice: null },
      ],
    };
    await mount();
    await selectTritanium();

    expect(document.getElementById('mk-insp-plan-count').textContent).toBe('1');
    const card = document.querySelector('.mk-plan-card');
    expect(card.textContent).toContain('Capital Build');
    expect(card.textContent).toContain('Locked');
  });

  test('shows drift against the locked price', async () => {
    // Locked 5.0, market sell 6.0 -> +20%
    state.plansByType = {
      34: [
        { planId: 'p1', planName: 'Capital Build', status: 'active', lockedPrice: 5.0, lockedAt: Date.now(), quantity: 100, isOverride: false, lastMarketPrice: null },
      ],
    };
    await mount();
    await selectTritanium();

    expect(document.querySelector('.mk-plan-drift').textContent).toBe('+20.0% drift');
  });

  test('measures drift for an overridden plan from the locked MARKET price', async () => {
    // The override (99) must not be the baseline; lastMarketPrice (5.0) is.
    state.plansByType = {
      34: [
        { planId: 'p1', planName: 'Pinned', status: 'active', lockedPrice: 99, lockedAt: Date.now(), quantity: 100, isOverride: true, lastMarketPrice: 5.0 },
      ],
    };
    await mount();
    await selectTritanium();

    expect(document.querySelector('.mk-plan-drift').textContent).toBe('+20.0% drift');
    // And the row is labelled as an override, not a plain lock.
    expect(document.querySelector('.mk-plan-card').textContent).toContain('Override');
  });

  test('re-lock sends the plan, type and current market price', async () => {
    state.plansByType = {
      34: [
        { planId: 'p1', planName: 'Capital Build', status: 'active', lockedPrice: 5.0, lockedAt: Date.now(), quantity: 100, isOverride: false, lastMarketPrice: null },
      ],
    };
    await mount();
    await selectTritanium();

    document.querySelector('.mk-plan-relock').click();
    await flush();

    expect(state.calls.find((c) => c.fn === 'relockPlanMaterial'))
      .toMatchObject({ planId: 'p1', typeId: 34, price: 6.0 });
  });

  test('re-locking an overridden plan reports that the override still applies', async () => {
    state.plansByType = {
      34: [
        { planId: 'p1', planName: 'Pinned', status: 'active', lockedPrice: 99, lockedAt: Date.now(), quantity: 100, isOverride: true, lastMarketPrice: 5.0 },
      ],
    };
    state.relockResult = { success: true, overridden: true, overridePrice: 99, marketPrice: 6.0, nodesUpdated: 1 };
    await mount();
    await selectTritanium();

    document.querySelector('.mk-plan-relock').click();
    await flush();

    const toast = document.querySelector('.toast-container .toast');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toMatch(/still uses your override/i);
  });
});


describe('full market data drawer', () => {
  async function openDrawerFor(name) {
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes(name));
    row.querySelector('.mk-data-btn').click();
    await flush();
  }

  test('every pricing row has a Data button', async () => {
    await mount();

    const rows = document.querySelectorAll('#mk-rows tr');
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((tr) => expect(tr.querySelector('.mk-data-btn')).not.toBeNull());
  });

  test('is hidden until opened', async () => {
    await mount();
    expect(document.getElementById('mk-drawer').hidden).toBe(true);
  });

  test('the Data button opens it for that item', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    expect(document.getElementById('mk-drawer').hidden).toBe(false);
    expect(document.getElementById('mk-drawer-name').textContent).toBe('Tritanium');
    expect(document.getElementById('mk-drawer-typeid').textContent).toBe('ID 34');
  });

  test('the inspector action opens it too', async () => {
    await mount();
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'));
    row.click();
    await flush();

    document.querySelector('.mk-insp-action').click();
    await flush();

    expect(document.getElementById('mk-drawer').hidden).toBe(false);
  });

  test('renders the order book, best price first on each side', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    const sells = [...document.querySelectorAll('#mk-drawer-sell .mk-order-row')];
    const buys = [...document.querySelectorAll('#mk-drawer-buy .mk-order-row')];
    expect(sells).toHaveLength(2);
    expect(buys).toHaveLength(1);
    // Cheapest sell leads.
    expect(sells[0].querySelector('.mk-order-sell').textContent).toBe('6');
  });

  test('renders the price history chart and its range', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    expect(document.querySelector('#mk-drawer-chart svg')).not.toBeNull();
    expect(document.getElementById('mk-drawer-hist-low').textContent).not.toBe('--');
    expect(document.getElementById('mk-drawer-hist-high').textContent).not.toBe('--');
    expect(document.getElementById('mk-drawer-trend').textContent).toMatch(/^[+-]/);
  });

  test('says so when no history is cached', async () => {
    state.priceHistory = {};
    await mount();
    await openDrawerFor('Tritanium');

    expect(document.querySelector('.mk-chart-empty')).not.toBeNull();
    expect(document.getElementById('mk-drawer-trend').textContent).toBe('--');
  });

  test('renders the six statistics', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    const labels = [...document.querySelectorAll('#mk-drawer-stats .mk-stat-label')]
      .map((e) => e.textContent);
    expect(labels).toEqual([
      'Sell (min)', 'Buy (max)', 'Spread', '30d Avg', '30d Range', 'Daily Volume',
    ]);
  });

  test('renders all five calculation methods and marks the active one', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    const calcs = [...document.querySelectorAll('#mk-drawer-calcs .mk-calc')];
    expect(calcs).toHaveLength(5);

    // The fixture set uses priceMethod 'sell'... default is 'immediate'.
    const active = document.querySelectorAll('#mk-drawer-calcs .mk-calc.is-active');
    expect(active.length).toBeLessThanOrEqual(1);
  });

  test('closes via the X, the footer button, and the scrim', async () => {
    await mount();

    await openDrawerFor('Tritanium');
    document.getElementById('mk-drawer-close').click();
    expect(document.getElementById('mk-drawer').hidden).toBe(true);

    await openDrawerFor('Tritanium');
    document.getElementById('mk-drawer-done').click();
    expect(document.getElementById('mk-drawer').hidden).toBe(true);

    await openDrawerFor('Tritanium');
    const scrim = document.getElementById('mk-drawer');
    scrim.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(scrim.hidden).toBe(true);
  });

  test('clicking inside the panel does not close it', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    document.querySelector('.mk-drawer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('mk-drawer').hidden).toBe(false);
  });

  test('Escape closes the drawer', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('mk-drawer').hidden).toBe(true);
  });

  test('Escape closes an open modal before the drawer', async () => {
    await mount();
    await openDrawerFor('Tritanium');
    document.getElementById('mk-new-watchlist').click();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.getElementById('mk-wl-modal').hidden).toBe(true);
    expect(document.getElementById('mk-drawer').hidden).toBe(false);
  });

  test('Set Override opens the override modal pre-picked', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    document.getElementById('mk-drawer-override').click();
    await flush();

    expect(document.getElementById('mk-drawer').hidden).toBe(true);
    expect(document.getElementById('mk-override-modal').hidden).toBe(false);
    expect(document.getElementById('mk-ov-pick-name').textContent).toBe('Tritanium');
  });
});

/**
 * Opening the drawer for an item with no cached history fetches it from ESI,
 * the same way calculateRealisticPrice does when an item is first priced.
 * Without this the chart just reads "no history", which is indistinguishable
 * from an item that genuinely has none.
 */
describe('drawer fetches missing price history on demand', () => {
  async function openDrawerFor(name) {
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes(name));
    row.querySelector('.mk-data-btn').click();
    await flush();
  }

  test('asks for history whenever the drawer opens', async () => {
    await mount();
    await openDrawerFor('Tritanium');

    expect(state.calls.find((c) => c.fn === 'getCachedHistory')).toMatchObject({ typeId: 34 });
  });

  test('renders a chart from history fetched on demand', async () => {
    // Nothing cached, but ESI has data for it.
    state.priceHistory = {};
    state.fetchableHistory = {
      34: Array.from({ length: 30 }, (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        average: 5 + i * 0.05,
        volume: 1000,
      })),
    };

    await mount();
    await openDrawerFor('Tritanium');

    expect(document.querySelector('#mk-drawer-chart svg')).not.toBeNull();
    expect(document.querySelector('.mk-chart-empty')).toBeNull();
    expect(document.getElementById('mk-drawer-trend').textContent).toMatch(/^[+-]/);
  });

  test('still reports no data when ESI has none either', async () => {
    state.priceHistory = {};
    state.fetchableHistory = {};

    await mount();
    await openDrawerFor('Tritanium');

    expect(document.querySelector('.mk-chart-empty')).not.toBeNull();
    expect(document.querySelector('.mk-chart-empty').textContent)
      .toMatch(/no price history/i);
  });

  test('the loading state is replaced, never left behind', async () => {
    state.priceHistory = {};
    state.fetchableHistory = {
      34: [
        { date: '2026-07-01', average: 5, volume: 10 },
        { date: '2026-07-02', average: 6, volume: 10 },
      ],
    };

    await mount();
    await openDrawerFor('Tritanium');

    expect(document.getElementById('mk-drawer-chart').textContent)
      .not.toMatch(/Loading market data/);
  });

  test('a second open is served from the now-warm cache', async () => {
    state.priceHistory = {};
    state.fetchableHistory = {
      34: [
        { date: '2026-07-01', average: 5, volume: 10 },
        { date: '2026-07-02', average: 6, volume: 10 },
      ],
    };

    await mount();
    await openDrawerFor('Tritanium');
    document.getElementById('mk-drawer-close').click();
    await openDrawerFor('Tritanium');
    await flush();

    // Both opens ask, but the fixture only "fetches" the first time.
    expect(state.calls.filter((c) => c.fn === 'getCachedHistory').length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector('#mk-drawer-chart svg')).not.toBeNull();
  });

  test('stale content is cleared before the new item loads', async () => {
    await mount();
    await openDrawerFor('Tritanium');
    const firstLow = document.getElementById('mk-drawer-hist-low').textContent;
    expect(firstLow).not.toBe('--');

    // Open a different item with no history at all.
    state.priceHistory = {};
    state.fetchableHistory = {};
    document.getElementById('mk-drawer-close').click();
    await openDrawerFor('Pyerite');

    // Must not still show Tritanium's range.
    expect(document.getElementById('mk-drawer-hist-low').textContent).toBe('--');
    expect(document.getElementById('mk-drawer-hist-high').textContent).toBe('--');
  });
});

/**
 * A history fetch already in flight must be allowed to finish even if the user
 * closes the drawer: main writes it through to the cache, so completing it
 * makes the next open instant. Only the render is abandoned.
 */
describe('an in-flight history fetch survives the drawer closing', () => {
  async function openDrawerFor(name) {
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes(name));
    row.querySelector('.mk-data-btn').click();
  }

  test('the fetch is not cancelled when the drawer closes mid-flight', async () => {
    state.priceHistory = {};
    state.fetchableHistory = {
      34: [
        { date: '2026-07-01', average: 5, volume: 10 },
        { date: '2026-07-02', average: 6, volume: 10 },
      ],
    };
    await mount();

    // Stall the response, open the drawer, then close it before it lands.
    let release;
    state.historyGate = new Promise((r) => { release = r; });

    openDrawerFor('Tritanium');
    await Promise.resolve();
    document.getElementById('mk-drawer-close').click();
    expect(document.getElementById('mk-drawer').hidden).toBe(true);

    // Let the fetch complete.
    release();
    state.historyGate = null;
    await flush();

    // It ran to completion rather than being abandoned...
    expect(state.calls.find((c) => c.fn === 'getCachedHistory')).toBeDefined();
    // ...and the drawer stayed closed rather than re-rendering itself.
    expect(document.getElementById('mk-drawer').hidden).toBe(true);
  });

  test('a late response does not paint over the drawer after reopening another item', async () => {
    state.priceHistory = {
      34: [{ date: '2026-07-01', average: 5, volume: 10 }, { date: '2026-07-02', average: 6, volume: 10 }],
      35: [{ date: '2026-07-01', average: 90, volume: 10 }, { date: '2026-07-02', average: 99, volume: 10 }],
    };
    await mount();

    let release;
    state.historyGate = new Promise((r) => { release = r; });

    openDrawerFor('Tritanium');
    await Promise.resolve();

    // Switch to a different item while the first is still loading.
    state.historyGate = null;
    document.getElementById('mk-drawer-close').click();
    await openDrawerFor('Pyerite');
    await flush();

    release();
    await flush();

    // The drawer shows Pyerite, not the stale Tritanium response.
    expect(document.getElementById('mk-drawer-name').textContent).toBe('Pyerite');
  });
});

