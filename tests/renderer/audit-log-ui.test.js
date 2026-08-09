/**
 * @jest-environment jsdom
 *
 * Audit Log shell view.
 *
 * What carries the most risk on this screen:
 *
 *   ROW REBUILDS - the un-ported screen called its full `renderTable()` from
 *   the row click handler and on every arriving record. Rebuilding on
 *   selection discards scroll position and destroys the element a mousedown
 *   landed on (binding rule 2a). Selection must move IN PLACE, and an
 *   arriving record must be appended - asserted by ELEMENT IDENTITY, since
 *   re-querying the DOM after a rebuild passes while the bug is present.
 *
 *   HIGHLIGHT COMPOSITION - selection and the new-record flash both paint the
 *   same row. The live screen used a class for one and a `background`
 *   keyframe for the other, so the animation's final frame erased the
 *   selection tint. Both are box-shadow now (rules 1 and 3).
 *
 *   LIVE RECORDS - this screen is driven entirely by `onRecordAdded`; there
 *   is no reload path. The subscription must be released on unmount.
 *
 *   STATUS - Audit Mode on/off used to be POLLED every 5s. It is now driven
 *   by `settings:changed`, which must be filtered by category AND key.
 *
 * console.error is captured and any unexpected entry FAILS the test.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/audit-log.view.html'),
  'utf8'
);
const VIEW_CSS = fs.readFileSync(
  path.join(__dirname, '../../public/audit-log-view.css'),
  'utf8'
);

/* --------------------------------------------------------------- fixtures */

let records;
let summary;
let calls;
let subscribers;
let registered;
let consoleErrors;
let expectedErrorPatterns;

let nextId = 1;

/** A pricing record as the recorder builds it. */
function pricingRecord(overrides = {}) {
  const { pricing, ...rest } = overrides;
  return {
    id: nextId++,
    timestamp: Date.now(),
    type: 'pricing',
    context: { source: 'blueprint-calculator', marketSetName: 'Jita Buy' },
    pricing: {
      itemName: 'Tritanium',
      typeId: 34,
      price: 5.5,
      confidence: 'high',
      method: 'vwap',
      priceType: 'sell',
      marketSetName: 'Jita Buy',
      source: 'blueprint-calculator',
      candidates: { vwap: 5.5, percentile: 5.8, historical7d: 5.2 },
      metadata: { ordersAvailable: 40, ordersUsed: 12 },
      ...pricing,
    },
    ...rest,
  };
}

function materialsRecord(overrides = {}) {
  return {
    id: nextId++,
    timestamp: Date.now(),
    type: 'materials',
    context: { source: 'plans', marketSetName: 'Amarr' },
    materials: {
      blueprintName: 'Raven Blueprint',
      blueprintTypeId: 691,
      runs: 5,
      meLevel: 10,
      facility: 'Sotiyo',
      marketSetName: 'Amarr',
      source: 'plans',
    },
    ...overrides,
  };
}

function inventionRecord(overrides = {}) {
  return {
    id: nextId++,
    timestamp: Date.now(),
    type: 'invention',
    context: { source: 'calculator' },
    invention: {
      blueprintTypeId: 12345,
      decryptorTypeId: null,
      probability: 0.42,
      materialCost: 1000000,
      costPerRun: 250000,
      source: 'calculator',
    },
    ...overrides,
  };
}

function makeApi() {
  const subscribe = (channel, cb) => {
    subscribers[channel] = subscribers[channel] || [];
    subscribers[channel].push(cb);
    return () => {
      subscribers[channel] = subscribers[channel].filter((c) => c !== cb);
    };
  };

  return {
    openSettings: () => { calls.push({ fn: 'openSettings' }); },
    audit: {
      // The real handler returns NEWEST FIRST.
      getRecords: async () => {
        calls.push({ fn: 'audit.getRecords' });
        return [...records].reverse();
      },
      clearRecords: async () => {
        calls.push({ fn: 'audit.clearRecords' });
        return true;
      },
      getSummary: async () => {
        calls.push({ fn: 'audit.getSummary' });
        return summary;
      },
      onRecordAdded: (cb) => subscribe('audit:recordAdded', cb),
    },
    data: {
      onChanged: (cb) => subscribe('esi:data-changed', cb),
      onMarketChanged: (cb) => subscribe('market:data-changed', cb),
      onCycleComplete: (cb) => subscribe('esi:cycle-complete', cb),
      onSettingsChanged: (cb) => subscribe('settings:changed', cb),
    },
  };
}

/* ---------------------------------------------------------------- harness */

function loadRenderer() {
  jest.isolateModules(() => {
    require('../../src/renderer/audit-log-view-renderer.js');
  });
}

function makeCtx() {
  const tracked = [];
  const intervals = [];
  return {
    tracked,
    intervals,
    ctx: {
      on: (target, type, handler) => target && target.addEventListener(type, handler),
      track: (fn) => { tracked.push(fn); return fn; },
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 0; },
      setTimeout: () => 0,
      dispose: () => tracked.forEach((fn) => fn()),
    },
  };
}

async function settle(times = 40) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function mountView(params) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const made = makeCtx();
  const instance = await registered.def.mount(container, params || {}, made.ctx);
  await settle();
  return { container, ctx: made.ctx, made, instance };
}

/** Push a record down the live subscription, as the recorder's broadcast does. */
function emitRecord(record) {
  (subscribers['audit:recordAdded'] || []).forEach((cb) => cb(record));
}

function emitSettingsChanged(payload) {
  (subscribers['settings:changed'] || []).forEach((cb) => cb(payload));
}

const rows = (c) => [...c.querySelectorAll('.al-row')];
const rowNames = (c) => rows(c).map((r) => r.querySelector('.col-name').textContent);

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '';
  nextId = 1;

  // Distinct, increasing timestamps. Built in one millisecond they tie, and a
  // tie makes the default timestamp sort's output arbitrary - which silently
  // turns any ordering assertion into a coin flip.
  const t0 = Date.now() - 3000;
  records = [
    pricingRecord({ timestamp: t0 }),
    materialsRecord({ timestamp: t0 + 1000 }),
    inventionRecord({ timestamp: t0 + 2000 }),
  ];
  summary = { total: 3, byType: { pricing: 1, materials: 1, invention: 1 }, enabled: true };
  calls = [];
  subscribers = {};
  registered = null;

  global.fetch = jest.fn(async () => ({ text: async () => VIEW_HTML }));

  window.QFToast = { show: jest.fn() };
  window.electronAPI = makeApi();
  window.QFShell = {
    router: {
      register: (id, def) => { registered = { id, def }; },
      show: jest.fn(),
    },
  };

  consoleErrors = [];
  expectedErrorPatterns = [];
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(args.join(' '));
  });

  loadRenderer();
});

afterEach(() => {
  const unexpected = consoleErrors.filter(
    (e) => !expectedErrorPatterns.some((p) => p.test(e))
  );
  expect(unexpected).toEqual([]);
  console.error.mockRestore();
});

/* ------------------------------------------------------------------ mount */

describe('mounting', () => {
  test('registers itself as a native shell view', () => {
    expect(registered).not.toBeNull();
    expect(registered.id).toBe('audit-log');
    expect(registered.def.title).toBe('Audit Log');
  });

  test('renders every loaded record', async () => {
    const { container } = await mountView();
    expect(rows(container)).toHaveLength(3);
  });

  test('counts records by type', async () => {
    const { container } = await mountView();

    expect(container.querySelector('#al-count-total').textContent).toBe('3');
    expect(container.querySelector('#al-count-pricing').textContent).toBe('1');
    expect(container.querySelector('#al-count-materials').textContent).toBe('1');
    expect(container.querySelector('#al-count-invention').textContent).toBe('1');
  });

  test('opens with the detail pane prompting for a selection', async () => {
    const { container } = await mountView();
    expect(container.querySelector('.al-detail-empty')).not.toBeNull();
  });

  test('explains itself when nothing has been recorded', async () => {
    records = [];
    const { container } = await mountView();

    expect(container.querySelector('#al-empty').hidden).toBe(false);
    expect(container.querySelector('.al-empty-title').textContent)
      .toBe('No calculations recorded yet');
  });

  test('survives a failed record load', async () => {
    expectedErrorPatterns.push(/Error loading records/);
    window.electronAPI.audit.getRecords = async () => { throw new Error('boom'); };

    const { container } = await mountView();

    expect(rows(container)).toHaveLength(0);
    expect(container.querySelector('#al-empty').hidden).toBe(false);
  });

  test('newest record sorts to the top by default', async () => {
    // getRecords returns newest-first; the table sorts for itself. If the
    // renderer failed to normalise arrival order, this inverts.
    const { container } = await mountView();
    expect(rowNames(container)[0]).toBe('Blueprint 12345');
  });
});

/* ---------------------------------------------------------------- status */

describe('audit mode status', () => {
  test('reads the current state on mount', async () => {
    const { container } = await mountView();

    expect(container.querySelector('#al-status-text').textContent).toBe('Recording');
    expect(container.querySelector('#al-status-dot').className).toContain('online');
  });

  test('shows when audit mode is off', async () => {
    summary = { total: 0, byType: {}, enabled: false };
    const { container } = await mountView();

    expect(container.querySelector('#al-status-text').textContent).toBe('Audit Mode is off');
    expect(container.querySelector('#al-status-dot').className).toContain('warning');
  });

  test('does not poll for the status', async () => {
    // The un-ported screen re-read getSummary every 5 seconds for a value that
    // only changes when a setting is written.
    const { made } = await mountView();
    expect(made.intervals).toHaveLength(0);
  });

  test('updates live when the setting is toggled elsewhere', async () => {
    const { container } = await mountView();

    emitSettingsChanged({
      category: 'general',
      keys: ['auditModeEnabled'],
      updates: { auditModeEnabled: false },
    });
    await settle();

    expect(container.querySelector('#al-status-text').textContent).toBe('Audit Mode is off');
  });

  test('ignores settings writes in other categories', async () => {
    const { container } = await mountView();

    emitSettingsChanged({
      category: 'market',
      keys: ['auditModeEnabled'],
      updates: { auditModeEnabled: false },
    });
    await settle();

    expect(container.querySelector('#al-status-text').textContent).toBe('Recording');
  });

  test('ignores general writes that do not touch audit mode', async () => {
    const { container } = await mountView();

    emitSettingsChanged({
      category: 'general',
      keys: ['theme'],
      updates: { theme: 'dark' },
    });
    await settle();

    expect(container.querySelector('#al-status-text').textContent).toBe('Recording');
  });
});

/* ----------------------------------------------------------- live records */

describe('live records', () => {
  test('subscribes on mount', async () => {
    await mountView();
    expect(subscribers['audit:recordAdded']).toHaveLength(1);
  });

  test('an arriving record appears at the top', async () => {
    const { container } = await mountView();

    emitRecord(pricingRecord({ pricing: { itemName: 'Pyerite' } }));
    await settle();

    expect(rows(container)).toHaveLength(4);
    expect(rowNames(container)[0]).toBe('Pyerite');
  });

  test('an arriving record does NOT rebuild the existing rows', async () => {
    const { container } = await mountView();
    const before = rows(container);

    emitRecord(pricingRecord({ pricing: { itemName: 'Pyerite' } }));
    await settle();

    const after = rows(container);
    // Element identity: re-querying after a rebuild would pass on a length
    // check alone while the bug is present.
    expect(after[1]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
    expect(after[3]).toBe(before[2]);
  });

  test('an arriving record updates the counts', async () => {
    const { container } = await mountView();

    emitRecord(materialsRecord());
    await settle();

    expect(container.querySelector('#al-count-total').textContent).toBe('4');
    expect(container.querySelector('#al-count-materials').textContent).toBe('2');
  });

  test('an arriving record flashes', async () => {
    const { container } = await mountView();

    emitRecord(pricingRecord({ pricing: { itemName: 'Pyerite' } }));
    await settle();

    expect(rows(container)[0].classList.contains('is-new')).toBe(true);
  });

  test('an arriving record keeps the current selection', async () => {
    const { container } = await mountView();

    rows(container)[0].click();
    await settle();
    const selectedName = rowNames(container)[0];

    emitRecord(pricingRecord({ pricing: { itemName: 'Pyerite' } }));
    await settle();

    const selected = container.querySelector('.al-row.is-selected');
    expect(selected.querySelector('.col-name').textContent).toBe(selectedName);
  });

  test('a filtered-out arrival does not appear', async () => {
    const { container } = await mountView();

    container.querySelector('#al-filter-type').value = 'materials';
    container.querySelector('#al-filter-type').dispatchEvent(new Event('change'));
    await settle();
    expect(rows(container)).toHaveLength(1);

    emitRecord(pricingRecord({ pricing: { itemName: 'Pyerite' } }));
    await settle();

    // Still only the materials record, but the total count grew.
    expect(rows(container)).toHaveLength(1);
    expect(container.querySelector('#al-count-total').textContent).toBe('4');
  });

  test('a non-default sort re-sorts rather than prepending', async () => {
    const { container } = await mountView();

    // Sort by name ascending.
    const nameTh = [...container.querySelectorAll('.al-th')]
      .find((th) => th.dataset.sort === 'name');
    nameTh.click();
    await settle();
    nameTh.click();
    await settle();

    emitRecord(pricingRecord({ pricing: { itemName: 'Aaaa First' } }));
    await settle();

    // Prepending blindly would put it on top regardless of sort; here it
    // genuinely sorts first, and a wrongly-placed row would show up as a
    // different order.
    expect(rowNames(container)[0]).toBe('Aaaa First');
  });
});

/* -------------------------------------------------------------- selection */

describe('selection', () => {
  test('clicking a row selects it', async () => {
    const { container } = await mountView();

    rows(container)[1].click();
    await settle();

    const selected = container.querySelectorAll('.al-row.is-selected');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(rows(container)[1]);
  });

  test('selecting does NOT rebuild the rows', async () => {
    // The un-ported screen called renderTable() from the click handler. That
    // destroys the element the mousedown landed on (rule 2a).
    const { container } = await mountView();
    const before = rows(container);

    before[1].click();
    await settle();

    const after = rows(container);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  test('moving the selection clears the previous row', async () => {
    const { container } = await mountView();

    rows(container)[0].click();
    await settle();
    rows(container)[2].click();
    await settle();

    const selected = container.querySelectorAll('.al-row.is-selected');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(rows(container)[2]);
  });
});

/* ----------------------------------------------------------------- detail */

describe('detail pane', () => {
  test('a pricing record shows its candidates', async () => {
    const { container } = await mountView();

    rows(container).find((r) => r.textContent.includes('Tritanium')).click();
    await settle();

    const titles = [...container.querySelectorAll('.al-section-title')].map((n) => n.textContent);
    expect(titles).toEqual(['Pricing', 'Candidate Prices', 'Order Book Metadata']);
    expect(container.querySelectorAll('.al-cand-row')).toHaveLength(3);
  });

  test('marks the candidate the final price came from', async () => {
    const { container } = await mountView();

    rows(container).find((r) => r.textContent.includes('Tritanium')).click();
    await settle();

    const winners = [...container.querySelectorAll('.al-cand-row.is-winner')];
    expect(winners).toHaveLength(1);
    expect(winners[0].querySelector('.al-cand-method').textContent).toBe('vwap');
  });

  test('marks NO winner for a hybrid price', async () => {
    // `hybrid` takes a median across candidates rather than picking one, so
    // marking any row would misstate where the number came from.
    records = [pricingRecord({ pricing: { method: 'hybrid' } })];
    const { container } = await mountView();

    rows(container)[0].click();
    await settle();

    expect(container.querySelectorAll('.al-cand-row.is-winner')).toHaveLength(0);
    expect(container.querySelectorAll('.al-cand-row')).toHaveLength(3);
  });

  test('shows a warning when the pricing carried one', async () => {
    records = [pricingRecord({ pricing: { warning: 'Thin order book' } })];
    const { container } = await mountView();

    rows(container)[0].click();
    await settle();

    expect(container.querySelector('.al-warning').textContent).toBe('Thin order book');
  });

  test('omits the metadata section when none was recorded', async () => {
    records = [pricingRecord({ pricing: { metadata: null } })];
    const { container } = await mountView();

    rows(container)[0].click();
    await settle();

    const titles = [...container.querySelectorAll('.al-section-title')].map((n) => n.textContent);
    expect(titles).not.toContain('Order Book Metadata');
  });

  test('a materials record shows its blueprint inputs', async () => {
    const { container } = await mountView();

    rows(container).find((r) => r.textContent.includes('Raven')).click();
    await settle();

    expect(container.querySelector('.al-section-title').textContent).toBe('Material Calculation');
    const text = container.querySelector('#al-detail').textContent;
    expect(text).toContain('Sotiyo');
    expect(text).toContain('10');
  });

  test('shows resolved names, not raw type ids', async () => {
    // Records store IDs only; main resolves names in one batched SDE query.
    // Before that, every row read "Blueprint 12345" / "Type 34".
    records = [
      inventionRecord({
        invention: {
          blueprintTypeId: 12345,
          blueprintName: 'Ishtar Blueprint',
          decryptorTypeId: 34203,
          decryptorName: 'Accelerant Decryptor',
          probability: 0.42,
        },
      }),
    ];
    const { container } = await mountView();

    expect(rowNames(container)).toEqual(['Ishtar Blueprint']);

    rows(container)[0].click();
    await settle();
    const detail = container.querySelector('#al-detail').textContent;
    expect(detail).toContain('Ishtar Blueprint');
    expect(detail).toContain('Accelerant Decryptor');
  });

  test('falls back to the id when a name could not be resolved', async () => {
    // A missing or failed SDE must not blank the row.
    records = [inventionRecord()];
    const { container } = await mountView();

    expect(rowNames(container)).toEqual(['Blueprint 12345']);

    rows(container)[0].click();
    await settle();
    expect(container.querySelector('#al-detail').textContent).toContain('None');
  });

  test('an invention record shows its probability as a percentage', async () => {
    const { container } = await mountView();

    rows(container).find((r) => r.textContent.includes('12345')).click();
    await settle();

    expect(container.querySelector('.al-section-title').textContent).toBe('Invention Calculation');
    expect(container.querySelector('#al-detail').textContent).toContain('42.0%');
  });

  test('record values are inserted as text, never as markup', async () => {
    records = [pricingRecord({ pricing: { itemName: '<img src=x onerror="alert(1)">' } })];
    const { container } = await mountView();

    rows(container)[0].click();
    await settle();

    const detail = container.querySelector('#al-detail');
    expect(detail.querySelector('img')).toBeNull();
    expect(detail.textContent).toContain('<img src=x');
  });
});

/* ---------------------------------------------------------------- filters */

describe('filters and sorting', () => {
  test('search matches item names', async () => {
    const { container } = await mountView();

    container.querySelector('#al-search').value = 'raven';
    container.querySelector('#al-search').dispatchEvent(new Event('input'));
    await settle();

    expect(rowNames(container)).toEqual(['Raven Blueprint']);
  });

  test('search also matches source and market set', async () => {
    const { container } = await mountView();

    container.querySelector('#al-search').value = 'jita';
    container.querySelector('#al-search').dispatchEvent(new Event('input'));
    await settle();

    expect(rowNames(container)).toEqual(['Tritanium']);
  });

  test('type filter narrows to one kind', async () => {
    const { container } = await mountView();

    container.querySelector('#al-filter-type').value = 'invention';
    container.querySelector('#al-filter-type').dispatchEvent(new Event('change'));
    await settle();

    expect(rows(container)).toHaveLength(1);
  });

  test('confidence filter only matches pricing records', async () => {
    const { container } = await mountView();

    container.querySelector('#al-filter-confidence').value = 'high';
    container.querySelector('#al-filter-confidence').dispatchEvent(new Event('change'));
    await settle();

    expect(rowNames(container)).toEqual(['Tritanium']);
  });

  test('reports how many of the total are shown', async () => {
    const { container } = await mountView();

    container.querySelector('#al-filter-type').value = 'pricing';
    container.querySelector('#al-filter-type').dispatchEvent(new Event('change'));
    await settle();

    expect(container.querySelector('#al-shown-count').textContent).toBe('1 of 3 records');
  });

  test('says so when filters match nothing', async () => {
    const { container } = await mountView();

    container.querySelector('#al-search').value = 'zzzznope';
    container.querySelector('#al-search').dispatchEvent(new Event('input'));
    await settle();

    expect(container.querySelector('#al-empty').hidden).toBe(false);
    expect(container.querySelector('.al-empty-title').textContent)
      .toBe('No records match your filters');
  });

  test('clicking a header sorts, and clicking again reverses', async () => {
    const { container } = await mountView();

    const nameTh = [...container.querySelectorAll('.al-th')]
      .find((th) => th.dataset.sort === 'name');

    nameTh.click();
    await settle();
    const desc = rowNames(container);

    nameTh.click();
    await settle();
    const asc = rowNames(container);

    expect(asc).toEqual([...desc].reverse());
  });

  test('the sorted column shows a direction arrow', async () => {
    const { container } = await mountView();

    const nameTh = [...container.querySelectorAll('.al-th')]
      .find((th) => th.dataset.sort === 'name');
    nameTh.click();
    await settle();

    expect(container.querySelectorAll('.al-sort-arrow')).toHaveLength(1);
    expect(nameTh.querySelector('.al-sort-arrow')).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- actions */

describe('actions', () => {
  test('clear empties the table and the detail pane', async () => {
    const { container } = await mountView();

    rows(container)[0].click();
    await settle();

    container.querySelector('#al-clear-btn').click();
    await settle();

    expect(calls.some((c) => c.fn === 'audit.clearRecords')).toBe(true);
    expect(rows(container)).toHaveLength(0);
    expect(container.querySelector('.al-detail-empty')).not.toBeNull();
    expect(container.querySelector('#al-count-total').textContent).toBe('0');
  });

  test('a failed clear leaves the records alone', async () => {
    expectedErrorPatterns.push(/Error clearing records/);
    const { container } = await mountView();

    window.electronAPI.audit.clearRecords = async () => { throw new Error('nope'); };
    container.querySelector('#al-clear-btn').click();
    await settle();

    expect(rows(container)).toHaveLength(3);
  });

  test('the settings button opens settings', async () => {
    const { container } = await mountView();

    container.querySelector('#al-settings-btn').click();
    await settle();

    expect(calls.some((c) => c.fn === 'openSettings')).toBe(true);
  });
});

/* --------------------------------------------------------------- teardown */

describe('teardown', () => {
  test('releases the record subscription on unmount', async () => {
    const { instance, ctx } = await mountView();

    expect(subscribers['audit:recordAdded']).toHaveLength(1);
    if (instance && instance.destroy) instance.destroy();
    ctx.dispose();

    expect(subscribers['audit:recordAdded']).toHaveLength(0);
  });

  test('releases the settings subscription on unmount', async () => {
    const { instance, ctx } = await mountView();

    expect(subscribers['settings:changed']).toHaveLength(1);
    if (instance && instance.destroy) instance.destroy();
    ctx.dispose();

    expect(subscribers['settings:changed']).toHaveLength(0);
  });

  test('a remount registers exactly one of each subscription', async () => {
    const first = await mountView();
    if (first.instance && first.instance.destroy) first.instance.destroy();
    first.ctx.dispose();

    await mountView();

    expect(subscribers['audit:recordAdded']).toHaveLength(1);
    expect(subscribers['settings:changed']).toHaveLength(1);
  });
});

/* -------------------------------------------------------------- stylesheet */

/*
 * jsdom applies no stylesheets, so these assert against the stylesheet TEXT.
 * `expect(row.classList.contains('is-selected')).toBe(true)` passes whether or
 * not the rule that paints it exists.
 */
describe('stylesheet contracts', () => {
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = VIEW_CSS.match(new RegExp(`^${escaped}\\s*\\{[^}]*\\}`, 'm'));
    expect(match).not.toBeNull();
    return match[0];
  };

  test('the row highlight is box-shadow, never a toggled background', () => {
    const selected = rule('.al-row.is-selected');
    expect(selected).toContain('box-shadow:');
    expect(selected).not.toMatch(/background(-color)?:/);
  });

  test('the row base keeps a constant transparent background', () => {
    const base = rule('.al-row');
    expect(base).toContain('background-color: transparent');
    expect(base).toContain('box-shadow: none');
  });

  test('the new-record flash animates box-shadow, not background', () => {
    // A `background` keyframe would beat the selection tint on its final
    // frame, leaving a freshly-arrived selected row looking unselected.
    const frames = VIEW_CSS.match(/@keyframes al-row-flash \{[^@]*?\n\}/);
    expect(frames).not.toBeNull();
    expect(frames[0]).toContain('box-shadow:');
    expect(frames[0]).not.toMatch(/\bbackground(-color)?:/);
  });

  test('a selected row that flashes keeps its selection stripe', () => {
    const frames = VIEW_CSS.match(/@keyframes al-row-flash-selected \{[^@]*?\n\}/);
    expect(frames).not.toBeNull();
    // Both ends of the animation carry the accent stripe.
    const stripes = frames[0].match(/inset 3px 0 0 var\(--qf-accent\)/g);
    expect(stripes).toHaveLength(2);
  });

  test('the winning candidate row uses box-shadow too', () => {
    const winner = rule('.al-cand-row.is-winner');
    expect(winner).toContain('box-shadow:');
    expect(winner).not.toMatch(/background(-color)?:/);
    expect(rule('.al-cand-row')).toContain('box-shadow: none');
  });

  test('the search input uses the sunken background and keeps box-sizing', () => {
    // Binding rules 4 and 6.
    expect(rule('.al-search-input')).toContain('background: var(--qf-surface-sunken)');
    expect(rule('.al-search-input')).toContain('box-sizing: border-box');
  });

  test('the filter selects have an explicit width', () => {
    // Rule 4: short fields never full-bleed across a row.
    expect(rule('.al-select')).toMatch(/width: \d+px/);
    expect(rule('.al-select')).toContain('box-sizing: border-box');
  });

  test('the select rule never uses a background SHORTHAND', () => {
    // `.qf-select` draws its chevron with `background-image` and sets
    // `appearance: none`, so a `background:` shorthand here resets the image
    // and the select loses its arrow entirely - with no native one to fall
    // back on. This shipped once.
    expect(rule('.al-select')).not.toMatch(/\bbackground:/);
  });

  test('the markup keeps the shared qf-select class', () => {
    // The arrow, sunken fill and border all come from the shared rule; a bare
    // `.al-select` would render as an unstyled native control.
    const selects = VIEW_HTML.match(/<select[^>]*>/g) || [];
    expect(selects).toHaveLength(2);
    selects.forEach((tag) => expect(tag).toContain('qf-select'));
  });

  test('type badges use three distinct hues, not the status ramp', () => {
    // Type is an identity, not a severity: reusing success/warning would imply
    // materials are "good" and invention is "a warning".
    expect(rule('.al-type-badge.is-pricing')).toContain('var(--qf-accent)');
    expect(rule('.al-type-badge.is-materials')).toContain('var(--qf-gold)');
    expect(rule('.al-type-badge.is-invention')).toContain('var(--qf-accent-bright)');

    ['is-pricing', 'is-materials', 'is-invention'].forEach((cls) => {
      expect(rule(`.al-type-badge.${cls}`)).not.toMatch(/var\(--qf-(success|warning|error)\b/);
    });
  });

  test('the stat strip renders as bordered cards', () => {
    const stat = rule('.al-stat');
    expect(stat).toContain('background: var(--qf-bg-elevated)');
    expect(stat).toContain('border: 1px solid var(--qf-border)');
    expect(stat).toMatch(/min-width: \d+px/);
  });

  test('each stat count is tinted to match its type badge', () => {
    expect(rule('.al-stat-value.is-pricing')).toContain('var(--qf-accent)');
    expect(rule('.al-stat-value.is-materials')).toContain('var(--qf-gold)');
    expect(rule('.al-stat-value.is-invention')).toContain('var(--qf-accent-bright)');
  });

  test('the winning candidate is marked on its cells, not just the row', () => {
    expect(rule('.al-cand-row.is-winner .al-cand-method')).toContain('var(--qf-accent)');
    expect(rule('.al-cand-row.is-winner .al-cand-price')).toContain('font-weight: 700');
  });

  test('hidden wins against the explicit displays in this view', () => {
    // Binding rule 6a - .al-empty is display:flex and toggled via `hidden`.
    expect(VIEW_CSS).toContain('#audit-log-view [hidden] { display: none !important; }');
  });

  test('only the list and detail panes scroll', () => {
    expect(rule('.al-view')).toContain('height: 100%');
    expect(rule('.al-list')).toContain('overflow: auto');
    expect(rule('.al-detail')).toContain('overflow-y: auto');
  });

  test('the header is not a bare <header> tag', () => {
    // styles.css styles bare `header`/`main` as page chrome; they would repaint
    // these blocks by tag name alone (binding rule 6b).
    // Match real tags only - `<header` also appears in this file's own comment
    // explaining why it is not used.
    const withoutComments = VIEW_HTML.replace(/<!--[\s\S]*?-->/g, '');
    expect(withoutComments).not.toMatch(/<header[\s>]/);
    expect(withoutComments).not.toMatch(/<main[\s>]/);
  });
});
