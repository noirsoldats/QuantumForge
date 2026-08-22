/**
 * @jest-environment jsdom
 *
 * Market Manager - watchlists: rendering, CRUD, and the Pricing tab they feed.
 *
 * Split out of the original single market suite; the shared fake backend and
 * mount helpers live in ./helpers/market-harness.
 */

const h = require('./helpers/market-harness');

h.installHooks();

const { state, mount, flush, ssSearch, ssRows } = h;

describe('watchlist rendering', () => {
  test('lists watchlists in the context pane with item counts', async () => {
    await mount();

    const rows = document.querySelectorAll('#mk-watchlist-nav .mk-wl-nav-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Mining Minerals');
    expect(rows[0].textContent).toContain('2 items');
    expect(rows[1].textContent).toContain('0 items');
  });

  test('the active watchlist is highlighted with box-shadow, not a background', async () => {
    await mount();

    const active = document.querySelector('#mk-watchlist-nav .mk-wl-nav-row.is-active');
    expect(active).not.toBeNull();
    // Binding rule 1: the highlight must never be driven by an inline background.
    expect(active.style.background).toBe('');
    expect(active.style.backgroundColor).toBe('');
  });

  test('renders the active watchlist header, description, and market', async () => {
    await mount();

    expect(document.getElementById('mk-wl-name').textContent).toBe('Mining Minerals');
    const desc = document.getElementById('mk-wl-desc');
    expect(desc.hidden).toBe(false);
    expect(desc.textContent).toBe('Core minerals');
    expect(document.getElementById('mk-wl-market-name').textContent).toBe('Jita 4-4');
  });

  test('hides the description when a watchlist has none', async () => {
    await mount();

    document.querySelectorAll('#mk-watchlist-nav .mk-wl-nav-row')[1].click();
    await flush();

    expect(document.getElementById('mk-wl-name').textContent).toBe('Capital Components');
    expect(document.getElementById('mk-wl-desc').hidden).toBe(true);
  });

  test('renders one row per item with buy and sell prices', async () => {
    await mount();

    const rows = document.querySelectorAll('#mk-wl-rows tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Tritanium');
    expect(rows[0].querySelector('.mk-buy').textContent).toBe('5');
    expect(rows[0].querySelector('.mk-sell').textContent).toBe('6');
  });

  test('shows the empty state when a watchlist has no items', async () => {
    await mount();

    document.querySelectorAll('#mk-watchlist-nav .mk-wl-nav-row')[1].click();
    await flush();

    expect(document.getElementById('mk-wl-items-empty').hidden).toBe(false);
    expect(document.querySelectorAll('#mk-wl-rows tr')).toHaveLength(0);
  });

  test('shows the no-watchlists empty state when none exist', async () => {
    state.watchlists = [];
    state.items = {};
    await mount();

    expect(document.getElementById('mk-wl-empty').hidden).toBe(false);
    expect(document.getElementById('mk-wl-body').hidden).toBe(true);
  });

  test('prices each item through calculatePrice, not a bulk price API', async () => {
    await mount();

    const priceCalls = state.calls.filter((c) => c.fn === 'calculatePrice');
    // Two items, buy + sell each.
    expect(priceCalls).toHaveLength(4);
    expect(priceCalls.some((c) => c.typeId === 34 && c.priceType === 'buy')).toBe(true);
    expect(priceCalls.some((c) => c.typeId === 34 && c.priceType === 'sell')).toBe(true);
  });
});

describe('create / edit / delete', () => {
  test('creating a watchlist sends the form values', async () => {
    await mount();

    document.getElementById('mk-new-watchlist').click();
    document.getElementById('mk-wl-form-name').value = 'New List';
    document.getElementById('mk-wl-form-desc').value = 'Some description';
    document.getElementById('mk-wl-form-save').click();
    await flush();

    const create = state.calls.find((c) => c.fn === 'create');
    expect(create).toBeDefined();
    expect(create.data.name).toBe('New List');
    expect(create.data.description).toBe('Some description');
  });

  test('a blank name does not create anything', async () => {
    await mount();

    document.getElementById('mk-new-watchlist').click();
    document.getElementById('mk-wl-form-name').value = '   ';
    document.getElementById('mk-wl-form-save').click();
    await flush();

    expect(state.calls.find((c) => c.fn === 'create')).toBeUndefined();
    // Modal stays open so the user can correct it.
    expect(document.getElementById('mk-wl-modal').hidden).toBe(false);
  });

  test('the edit form pre-fills from the active watchlist', async () => {
    await mount();

    document.getElementById('mk-wl-edit').click();

    expect(document.getElementById('mk-wl-modal-title').textContent).toBe('Edit Watchlist');
    expect(document.getElementById('mk-wl-form-name').value).toBe('Mining Minerals');
    expect(document.getElementById('mk-wl-form-desc').value).toBe('Core minerals');
  });

  test('editing updates rather than creating', async () => {
    await mount();

    document.getElementById('mk-wl-edit').click();
    document.getElementById('mk-wl-form-name').value = 'Renamed';
    document.getElementById('mk-wl-form-save').click();
    await flush();

    expect(state.calls.find((c) => c.fn === 'create')).toBeUndefined();
    const update = state.calls.find((c) => c.fn === 'update');
    expect(update.id).toBe(1);
    expect(update.updates.name).toBe('Renamed');
  });

  test('delete asks for confirmation and honours a cancel', async () => {
    await mount();
    window.confirm = jest.fn(() => false);

    document.getElementById('mk-wl-delete').click();
    await flush();

    expect(window.confirm).toHaveBeenCalled();
    expect(state.calls.find((c) => c.fn === 'remove')).toBeUndefined();
  });

  test('delete proceeds when confirmed', async () => {
    await mount();
    window.confirm = jest.fn(() => true);

    document.getElementById('mk-wl-delete').click();
    await flush();

    expect(state.calls.find((c) => c.fn === 'remove').id).toBe(1);
  });

  test('removing an item calls through with the item id', async () => {
    await mount();

    const remove = document.querySelectorAll('#mk-wl-rows tr')[0].querySelector('.mk-icon-btn-danger');
    remove.click();
    await flush();

    expect(state.calls.find((c) => c.fn === 'removeItem').itemId).toBe(10);
  });
});

describe('modal dismissal', () => {
  test('the close button hides the modal', async () => {
    await mount();

    document.getElementById('mk-new-watchlist').click();
    expect(document.getElementById('mk-wl-modal').hidden).toBe(false);

    document.querySelector('#mk-wl-modal .modal-close').click();
    expect(document.getElementById('mk-wl-modal').hidden).toBe(true);
  });

  test('clicking the backdrop closes, clicking the panel does not', async () => {
    await mount();
    const modal = document.getElementById('mk-wl-modal');

    document.getElementById('mk-new-watchlist').click();
    modal.querySelector('.modal-content').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.hidden).toBe(false);

    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.hidden).toBe(true);
  });

  test('Escape closes an open modal', async () => {
    await mount();

    document.getElementById('mk-new-watchlist').click();
    expect(document.getElementById('mk-wl-modal').hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('mk-wl-modal').hidden).toBe(true);
  });
});

describe('favourites persistence', () => {
  test('toggling a favourite persists through the backend', async () => {
    await mount();

    // Pricing rows are the items the user has touched (overrides, favourites,
    // watchlist members), so the watchlist fixture guarantees rows exist.
    const fav = document.querySelector('#mk-rows .mk-fav');
    expect(fav).not.toBeNull();

    fav.click();
    await flush();

    expect(state.calls.find((c) => c.fn === 'toggleFavorite')).toBeDefined();
  });
});


/**
 * Watchlist members are one of the Pricing tab's row sources (alongside
 * overrides and favourites), so adding or removing one has to refresh that
 * table - and the resolved name has to reach the SHARED name cache, not just
 * the watchlist's own copy.
 */
describe('adding a watchlist item updates the Pricing tab', () => {
  async function addMexallonToWatchlist() {
    document.getElementById('mk-wl-add-item').click();
    await flush();
    await ssSearch('mk-additem-search', 'mex');
    ssRows()[0].click();
    await flush();
    document.getElementById('mk-additem-save').click();
    await flush();
  }

  /** Item names currently shown in the Pricing table. */
  function pricingNames() {
    return [...document.querySelectorAll('#mk-rows tr')].map((tr) => tr.children[1].textContent);
  }

  test('the new item appears without needing another refresh', async () => {
    await mount();
    expect(pricingNames()).not.toContain('Mexallon');

    // The backend now reports the item as being on the watchlist.
    state.items[1] = [
      ...state.items[1],
      { id: 12, type_id: 36, base_buy: null, base_sell: null, baseline_at: null, buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    await addMexallonToWatchlist();

    expect(pricingNames()).toContain('Mexallon');
  });

  test('it shows the item name, not "Type <id>"', async () => {
    await mount();

    state.items[1] = [
      ...state.items[1],
      { id: 12, type_id: 36, base_buy: null, base_sell: null, baseline_at: null, buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    await addMexallonToWatchlist();

    const names = pricingNames();
    expect(names).toContain('Mexallon');
    expect(names.some((n) => /^Type \d+$/.test(n))).toBe(false);
  });

  test('the new item is priced, not left blank', async () => {
    await mount();

    state.items[1] = [
      ...state.items[1],
      { id: 12, type_id: 36, base_buy: null, base_sell: null, baseline_at: null, buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    await addMexallonToWatchlist();

    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Mexallon'));
    expect(row.querySelector('.mk-sell').textContent).not.toBe('--');
  });

  test('removing an item drops it from the Pricing table too', async () => {
    await mount();
    expect(pricingNames()).toContain('Tritanium');

    // Remove Tritanium (id 10) from the active watchlist. The fixture's
    // removeItem already drops it from every list, mirroring the backend.
    const removeBtn = document.querySelectorAll('#mk-wl-rows tr')[0]
      .querySelector('.mk-icon-btn-danger');
    removeBtn.click();
    await flush();

    expect(pricingNames()).not.toContain('Tritanium');
  });
});

/**
 * A watchlist is BOUND to the market set it was configured with. Changing the
 * left-pane selection must not move it - that binding is the point of the
 * setting. The Pricing tab is the deliberate exception: it lists every tracked
 * item priced against whatever set is selected on the left.
 */
describe('watchlists are bound to their own market set', () => {
  async function selectAmarrInLeftPane() {
    const row = [...document.querySelectorAll('#mk-set-list .mk-context-row')]
      .find((r) => r.textContent.includes('Amarr'));
    row.click();
    await flush();
  }

  test('the header names the bound market set, not "Default market"', async () => {
    await mount();

    expect(document.getElementById('mk-wl-market-name').textContent).toBe('Jita 4-4');
  });

  test('a watchlist bound to another set names that one', async () => {
    await mount();
    document.querySelectorAll('#mk-watchlist-nav .mk-wl-nav-row')[1].click();
    await flush();

    expect(document.getElementById('mk-wl-market-name').textContent).toBe('Amarr');
  });

  test('watchlist prices use the bound set, not the left-pane selection', async () => {
    await mount();
    state.calls.length = 0;

    await selectAmarrInLeftPane();

    // Any repricing that did happen must have used the BOUND set (Jita), not
    // the newly selected one.
    const priced = state.calls.filter((c) => c.fn === 'calculatePrice');
    priced.forEach((c) => expect(c.marketSetId).not.toBe('set-amarr'));
  });

  test('the bound market name does not change with the left pane', async () => {
    await mount();
    expect(document.getElementById('mk-wl-market-name').textContent).toBe('Jita 4-4');

    await selectAmarrInLeftPane();

    expect(document.getElementById('mk-wl-market-name').textContent).toBe('Jita 4-4');
  });

  test('a watchlist with no bound set falls back to the default, not the selection', async () => {
    state.watchlists = [
      { id: 1, name: 'Unbound', description: null, market_set_id: null, item_count: 1 },
    ];
    await mount();

    expect(document.getElementById('mk-wl-market-name').textContent).toBe('the default market');
  });

  test('creating a watchlist stores the set id verbatim, not coerced to a number', async () => {
    await mount();

    document.getElementById('mk-new-watchlist').click();
    document.getElementById('mk-wl-form-name').value = 'Bound';
    const marketSelect = document.getElementById('mk-wl-form-market');
    marketSelect.value = 'set-amarr';
    document.getElementById('mk-wl-form-save').click();
    await flush();

    const created = state.calls.find((c) => c.fn === 'create');
    expect(created.data.marketSetId).toBe('set-amarr');
    expect(Number.isNaN(created.data.marketSetId)).toBe(false);
  });
});

describe('the Pricing tab spans every watchlist', () => {
  test('lists items from a watchlist that is not the active one', async () => {
    // Mexallon is only on the SECOND watchlist, which is not selected.
    state.items[2] = [
      { id: 20, type_id: 36, base_buy: null, base_sell: null, baseline_at: null, buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    state.watchlists[1].item_count = 1;

    await mount();

    const names = [...document.querySelectorAll('#mk-rows tr')].map((tr) => tr.children[1].textContent);
    expect(names).toContain('Mexallon');
  });

  test('prices them against the LEFT-PANE set, not each watchlist binding', async () => {
    state.items[2] = [
      { id: 20, type_id: 36, base_buy: null, base_sell: null, baseline_at: null, buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null, sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    await mount();
    state.calls.length = 0;

    const row = [...document.querySelectorAll('#mk-set-list .mk-context-row')]
      .find((r) => r.textContent.includes('Amarr'));
    row.click();
    await flush();

    // The order book is fetched for the selected region, covering every
    // tracked item regardless of which watchlist it came from.
    const book = state.calls.filter((c) => c.fn === 'getOrderBookSummary');
    expect(book.length).toBeGreaterThan(0);
    expect(book.some((c) => c.regionId === 10000043)).toBe(true);
  });
});

/**
 * Anchored drift: base_buy/base_sell are captured when the item is added and
 * move ONLY on an explicit re-baseline. Drift is measured from them, so it
 * answers "how far has this moved since I started watching?" - a rolling
 * baseline would only ever show the delta since the last check.
 */
describe('watchlist drift columns', () => {
  function wlRow(name) {
    return [...document.querySelectorAll('#mk-wl-rows tr')]
      .find((tr) => tr.textContent.includes(name));
  }

  test('shows base and current for both sides', async () => {
    await mount();

    // Tritanium: base 5/6, current 5/6.
    const cells = [...wlRow('Tritanium').children].map((td) => td.textContent);
    expect(cells[1]).toBe('5');   // base buy
    expect(cells[2]).toBe('5');   // buy
    expect(cells[3]).toBe('6');   // base sell
    expect(cells[4]).toBe('6');   // sell
  });

  test('drift is measured from the baseline, not the last check', async () => {
    await mount();

    // Pyerite: base 8/10, current 10/12 -> +25% buy, +20% sell.
    const drift = wlRow('Pyerite').querySelector('.mk-wl-drift');
    expect(drift.textContent).toContain('+25.0%');
    expect(drift.textContent).toContain('+20.0%');
  });

  test('an item at its baseline shows no drift', async () => {
    await mount();

    const drift = wlRow('Tritanium').querySelector('.mk-wl-drift');
    expect(drift.textContent).toContain('+0.0%');
  });

  test('an item with no baseline shows -- rather than a fake zero', async () => {
    state.items[1] = [
      { id: 10, type_id: 34, base_buy: null, base_sell: null, baseline_at: null,
        buy_alert_type: 'none', buy_alert_direction: 'above', buy_alert_value: null,
        sell_alert_type: 'none', sell_alert_direction: 'above', sell_alert_value: null },
    ];
    await mount();

    expect(wlRow('Tritanium').querySelector('.mk-wl-drift').textContent).toBe('-- / --');
  });

  test('drift direction is colour-coded', async () => {
    await mount();

    const parts = wlRow('Pyerite').querySelectorAll('.mk-drift-part');
    expect(parts.length).toBe(2);
    parts.forEach((p) => expect(p.classList.contains('is-up')).toBe(true));
  });
});

describe('per-side alert rules', () => {
  function wlRow(name) {
    return [...document.querySelectorAll('#mk-wl-rows tr')]
      .find((tr) => tr.textContent.includes(name));
  }

  test('an armed rule that has been crossed reads as hit', async () => {
    // Pyerite sell drifted +20%, rule is "sell rises by 50%" -> not hit.
    await mount();
    let pill = wlRow('Pyerite').querySelector('.mk-alert-pill');
    expect(pill.classList.contains('is-armed')).toBe(true);

    // Lower the threshold below the actual drift.
    state.items[1][1].sell_alert_value = 10;
    await mount();
    pill = wlRow('Pyerite').querySelector('.mk-alert-pill');
    expect(pill.classList.contains('is-hit')).toBe(true);
  });

  test('buy and sell rules are independent', async () => {
    state.items[1][1].buy_alert_type = 'percent';
    state.items[1][1].buy_alert_direction = 'above';
    state.items[1][1].buy_alert_value = 10;   // buy drifted +25% -> hit
    state.items[1][1].sell_alert_value = 90;  // sell drifted +20% -> armed
    await mount();

    const pills = wlRow('Pyerite').querySelectorAll('.mk-alert-pill');
    expect(pills).toHaveLength(2);
    expect([...pills].filter((p) => p.classList.contains('is-hit'))).toHaveLength(1);
    expect([...pills].filter((p) => p.classList.contains('is-armed'))).toHaveLength(1);
  });

  test('an item with no rules offers to set them', async () => {
    await mount();

    const pill = wlRow('Tritanium').querySelector('.mk-alert-pill');
    expect(pill.textContent).toBe('Set alerts');
  });

  test('an ISK rule is labelled in ISK, not percent', async () => {
    state.items[1][1].sell_alert_type = 'isk';
    state.items[1][1].sell_alert_value = 3;
    await mount();

    const pill = wlRow('Pyerite').querySelector('.mk-alert-pill');
    expect(pill.textContent).toContain('3');
    expect(pill.textContent).not.toContain('%');
  });
});

describe('adding an item captures its baseline', () => {
  async function addMexallon() {
    document.getElementById('mk-wl-add-item').click();
    await flush();
    await ssSearch('mk-additem-search', 'mex');
    ssRows()[0].click();
    await flush();
    document.getElementById('mk-additem-save').click();
    await flush();
  }

  test('sends the current prices as the anchor', async () => {
    await mount();
    await addMexallon();

    const add = state.calls.find((c) => c.fn === 'addItem');
    // Mexallon prices from the fixture.
    expect(add.payload.baseBuy).toBe(80);
    expect(add.payload.baseSell).toBe(90);
  });

  test('sends both rule sides', async () => {
    await mount();
    await addMexallon();

    const add = state.calls.find((c) => c.fn === 'addItem');
    expect(add.payload.buy).toEqual({ type: 'none', direction: 'above', value: null });
    expect(add.payload.sell).toEqual({ type: 'none', direction: 'above', value: null });
  });

  test('fetches the baseline for an item not already tracked', async () => {
    // The order book only covers tracked items, so adding a freshly searched
    // one must look its prices up rather than anchoring to nothing.
    await mount();
    state.calls.length = 0;
    await addMexallon();

    const lookups = state.calls.filter((c) => c.fn === 'getOrderBookSummary');
    expect(lookups.length).toBeGreaterThan(0);
    expect(state.calls.find((c) => c.fn === 'addItem').payload.baseBuy).toBe(80);
  });

  test('warns when no market data exists to anchor to', async () => {
    // Mexallon has no cached prices in this run.
    delete state.prices[36];
    await mount();
    await addMexallon();

    const add = state.calls.find((c) => c.fn === 'addItem');
    expect(add.payload.baseBuy).toBeUndefined();
    expect(add.payload.baseSell).toBeUndefined();

    const toastEl = document.querySelector('.toast-container .toast');
    expect(toastEl).not.toBeNull();
    expect(toastEl.textContent).toMatch(/no baseline yet/i);
  });

  test('editing an existing item does NOT resend a baseline', async () => {
    // Re-baselining must be explicit; editing alerts must not silently reset
    // the anchor and erase accumulated drift.
    await mount();
    [...document.querySelectorAll('#mk-wl-rows tr')][1]
      .querySelector('.mk-alert-pill').click();
    await flush();

    document.getElementById('mk-additem-save').click();
    await flush();

    const add = state.calls.find((c) => c.fn === 'addItem');
    expect(add.payload.baseBuy).toBeUndefined();
    expect(add.payload.baseSell).toBeUndefined();
  });

  test('a percent rule is sent with its value', async () => {
    await mount();
    document.getElementById('mk-wl-add-item').click();
    await flush();
    await ssSearch('mk-additem-search', 'mex');
    ssRows()[0].click();
    await flush();

    const type = document.getElementById('mk-additem-sell-type');
    type.value = 'percent';
    type.dispatchEvent(new Event('change'));
    const value = document.getElementById('mk-additem-sell-value');
    value.value = '15';
    value.dispatchEvent(new Event('input'));

    document.getElementById('mk-additem-save').click();
    await flush();

    const add = state.calls.find((c) => c.fn === 'addItem');
    expect(add.payload.sell).toEqual({ type: 'percent', direction: 'above', value: 15 });
  });

  test('save is blocked while an armed rule has no value', async () => {
    await mount();
    document.getElementById('mk-wl-add-item').click();
    await flush();
    await ssSearch('mk-additem-search', 'mex');
    ssRows()[0].click();
    await flush();

    const type = document.getElementById('mk-additem-buy-type');
    type.value = 'isk';
    type.dispatchEvent(new Event('change'));

    expect(document.getElementById('mk-additem-save').disabled).toBe(true);
  });
});

describe('re-baselining', () => {
  test('sends the current prices for that item', async () => {
    await mount();

    const row = [...document.querySelectorAll('#mk-wl-rows tr')]
      .find((tr) => tr.textContent.includes('Pyerite'));
    row.querySelector('.mk-icon-btn:not(.mk-icon-btn-danger)').click();
    await flush();

    const rebase = state.calls.find((c) => c.fn === 'rebaseline');
    expect(rebase).toBeDefined();
    expect(rebase.prices).toEqual({ buy: 10, sell: 12 });
  });

  test('is disabled when the item has no price to anchor to', async () => {
    state.prices = {};
    await mount();

    const btn = document.querySelector('#mk-wl-rows .mk-icon-btn:not(.mk-icon-btn-danger)');
    expect(btn.disabled).toBe(true);
  });
});

