/**
 * @jest-environment jsdom
 *
 * ESI Status shell view.
 *
 * What carries the most risk on this screen:
 *
 *   ROW HIGHLIGHTS - the call row's left stripe encodes STATUS and is always
 *   present, while selection layers an outline and glow on top of it. If the
 *   selected and unselected branches do not both emit the stripe layer,
 *   deselecting a row strips its status colour (binding rules 1 and 3).
 *   jsdom applies no stylesheets, so those assertions are against the
 *   stylesheet TEXT.
 *
 *   BACKGROUND REFRESH - this view reloads itself whenever ESI activity is
 *   reported. A refresh must never steal the user's selection, and must never
 *   rebuild rows in a way that discards them. It is also COALESCED: a
 *   paginated fetch emits once per endpoint.
 *
 *   ERROR RECENCY - an error is only red while recent; older failures fade to
 *   yellow so a long-resolved blip does not leave the screen alarming forever.
 *
 *   TEARDOWN - the subscription and the fallback interval must both be
 *   released on unmount, or a standalone window that is closed and reopened
 *   accumulates refresh loops.
 *
 * console.error is captured and any unexpected entry FAILS the test.
 */

const fs = require('fs');
const path = require('path');

// Sets window.QFUI, the same way index.html loads it before every view
// renderer. The renderer loads its template through QFUI.loadViewTemplate,
// so without this the mount throws ReferenceError.
require('../../public/shared/ui-helpers.js');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/esi-status.view.html'),
  'utf8'
);
const VIEW_CSS = fs.readFileSync(
  path.join(__dirname, '../../public/esi-status-view.css'),
  'utf8'
);

/* --------------------------------------------------------------- fixtures */

let characters;
let characterCalls;
let universeCalls;
let callDetails;
let calls;
let subscribers;
let registered;
let consoleErrors;
let expectedErrorPatterns;

const HOUR = 60 * 60 * 1000;

/** A call row as esiStatus:getCharacterCalls returns it. */
function call(overrides = {}) {
  return {
    call_key: 'char:91316135:skills',
    endpoint_label: 'Character Skills',
    status: 'success',
    last_query_at: Date.now() - 5 * 60 * 1000,
    updated_at: Date.now() - 5 * 60 * 1000,
    cache_expires_at: null,
    next_allowed_at: null,
    request_count: 10,
    success_count: 10,
    error_count: 0,
    error_message: null,
    error_code: null,
    ...overrides,
  };
}

/**
 * `count` calls of one endpoint, each with its own argument-bearing key.
 *
 * This is the real shape: `structure_1049960197509` etc. all share the label
 * "Structure Info". A live database holds 147 of them.
 */
function argumentedCalls(label, count, overrides = {}) {
  return Array.from({ length: count }, (_, i) =>
    call({
      call_key: `structure_10499601975${String(i).padStart(2, '0')}`,
      endpoint_label: label,
      ...overrides,
    })
  );
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
    esi: {
      getCharacters: async () => {
        calls.push({ fn: 'esi.getCharacters' });
        return characters;
      },
    },
    esiStatus: {
      initializeUniverse: async () => {
        calls.push({ fn: 'esiStatus.initializeUniverse' });
        return true;
      },
      initializeCharacter: async (characterId, characterName) => {
        calls.push({ fn: 'esiStatus.initializeCharacter', characterId, characterName });
        return true;
      },
      getCharacterCalls: async (characterId) => {
        calls.push({ fn: 'esiStatus.getCharacterCalls', characterId });
        return characterCalls;
      },
      getUniverseCalls: async () => {
        calls.push({ fn: 'esiStatus.getUniverseCalls' });
        return universeCalls;
      },
      getCallDetails: async (callKey) => {
        calls.push({ fn: 'esiStatus.getCallDetails', callKey });
        return callDetails;
      },
    },
    data: {
      onChanged: (cb) => subscribe('esi:data-changed', cb),
      onMarketChanged: (cb) => subscribe('market:data-changed', cb),
      onCycleComplete: (cb) => subscribe('esi:cycle-complete', cb),
    },
  };
}

/* ---------------------------------------------------------------- harness */

function loadRenderer() {
  jest.isolateModules(() => {
    require('../../src/renderer/esi-status-view-renderer.js');
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

/** Fire the data-changed bus event the view subscribes to. */
function emitDataChanged() {
  (subscribers['esi:data-changed'] || []).forEach((cb) => cb({ endpointType: 'skills' }));
}

const navItems = (c) => [...c.querySelectorAll('.esi-nav-item')];
const callRows = (c) => [...c.querySelectorAll('.esi-call')];

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'Date'] });
  document.body.innerHTML = '';

  characters = [
    { characterId: 91316135, characterName: 'Buckwalter' },
    { characterId: 91316136, characterName: 'Halcyon' },
  ];
  characterCalls = [
    call(),
    call({
      call_key: 'char:91316135:assets',
      endpoint_label: 'Character Assets',
      status: 'error',
      error_code: '420',
      error_message: 'Error limited: too many requests.',
      updated_at: Date.now() - 4 * 60 * 1000,
      error_count: 3,
    }),
  ];
  universeCalls = [
    call({ call_key: 'universe:status', endpoint_label: 'Server Status' }),
  ];
  callDetails = { status: characterCalls[0], history: [] };
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
  jest.useRealTimers();
});

/* ------------------------------------------------------------------ mount */

describe('mounting', () => {
  test('registers itself as a native shell view', () => {
    expect(registered).not.toBeNull();
    expect(registered.id).toBe('esi-status');
    expect(registered.def.title).toBe('ESI Status');
  });

  test('lists every character plus the universe entry', async () => {
    const { container } = await mountView();

    const names = navItems(container).map((n) =>
      n.querySelector('.esi-nav-name').textContent
    );
    expect(names).toEqual(['Buckwalter', 'Halcyon', 'Eve Universe']);
  });

  test('registers universe endpoints before listing their calls', async () => {
    await mountView();

    const init = calls.findIndex((c) => c.fn === 'esiStatus.initializeUniverse');
    expect(init).toBeGreaterThanOrEqual(0);
    // Universe calls are only fetched once the user selects that entry, but
    // the registration must have happened during mount regardless.
    expect(calls.filter((c) => c.fn === 'esiStatus.initializeUniverse')).toHaveLength(1);
  });

  test('registers each character before reading their status', async () => {
    await mountView();

    const ids = calls
      .filter((c) => c.fn === 'esiStatus.initializeCharacter')
      .map((c) => c.characterId);
    expect(ids).toEqual([91316135, 91316136]);
  });

  test('opens on the first character rather than an empty pane', async () => {
    const { container } = await mountView();

    expect(container.querySelector('#esi-calls-title').textContent).toBe('Buckwalter');
    expect(callRows(container)).toHaveLength(2);
    expect(navItems(container)[0].classList.contains('is-active')).toBe(true);
  });

  test('falls back to the universe view when there are no characters', async () => {
    characters = [];
    const { container } = await mountView();

    expect(container.querySelector('#esi-calls-title').textContent).toBe('Eve Universe');
    expect(container.querySelector('.esi-nav-empty')).not.toBeNull();
  });

  test('survives a character list that fails to load', async () => {
    expectedErrorPatterns.push(/Error loading characters/);
    window.electronAPI.esi.getCharacters = async () => { throw new Error('offline'); };

    const { container } = await mountView();

    expect(container.querySelector('.esi-nav-error')).not.toBeNull();
    // The universe entry is static markup, so the screen is still usable.
    expect(container.querySelector('#esi-nav-universe')).not.toBeNull();
  });
});

/* -------------------------------------------------------------- selection */

describe('navigation', () => {
  test('selecting the universe entry loads universe calls', async () => {
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();

    expect(container.querySelector('#esi-calls-title').textContent).toBe('Eve Universe');
    expect(callRows(container).map((r) => r.dataset.label)).toEqual(['Server Status']);
  });

  test('only one nav row is active at a time', async () => {
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();

    const active = navItems(container).filter((n) => n.classList.contains('is-active'));
    expect(active).toHaveLength(1);
    expect(active[0].dataset.view).toBe('universe');
  });

  test('switching nav clears a selected call', async () => {
    const { container } = await mountView();

    callRows(container)[0].click();
    await settle();
    expect(container.querySelector('.esi-call.is-selected')).not.toBeNull();

    container.querySelector('#esi-nav-universe').click();
    await settle();

    expect(container.querySelector('.esi-call.is-selected')).toBeNull();
    expect(container.querySelector('.esi-detail-empty')).not.toBeNull();
  });

  test('nav rows are keyboard operable', async () => {
    const { container } = await mountView();

    const universe = container.querySelector('#esi-nav-universe');
    expect(universe.tabIndex).toBe(0);
    universe.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(container.querySelector('#esi-calls-title').textContent).toBe('Eve Universe');
  });

  test('an empty call list explains itself instead of rendering nothing', async () => {
    characterCalls = [];
    const { container } = await mountView();

    expect(container.querySelector('.esi-calls-empty')).not.toBeNull();
    expect(callRows(container)).toHaveLength(0);
  });
});

/* ------------------------------------------------------- status semantics */

describe('status colours', () => {
  test('a recent error is red', async () => {
    const { container } = await mountView();

    const row = callRows(container)[1];
    expect(row.querySelector('.esi-dot').className).toContain('is-red');
  });

  test('an error older than an hour fades to yellow, not red', async () => {
    characterCalls = [
      call({ status: 'error', updated_at: Date.now() - 2 * HOUR, error_message: 'old' }),
    ];
    const { container } = await mountView();

    expect(container.querySelector('.esi-call .esi-dot').className).toContain('is-yellow');
  });

  test('in-progress reads as a warning', async () => {
    characterCalls = [call({ status: 'in_progress' })];
    const { container } = await mountView();

    expect(container.querySelector('.esi-call .esi-dot').className).toContain('is-yellow');
  });

  test('pending reads as neutral, not as a fault', async () => {
    characterCalls = [call({ status: 'pending' })];
    const { container } = await mountView();

    expect(container.querySelector('.esi-call .esi-dot').className).toContain('is-gray');
  });

  test("the nav dot takes the character's worst call", async () => {
    const { container } = await mountView();

    // Buckwalter has one success and one recent error.
    expect(navItems(container)[0].querySelector('.esi-dot').className).toContain('is-red');
  });

  test('a character with only stale errors shows yellow in the nav', async () => {
    characterCalls = [
      call(),
      call({ status: 'error', updated_at: Date.now() - 3 * HOUR, error_message: 'old' }),
    ];
    const { container } = await mountView();

    expect(navItems(container)[0].querySelector('.esi-dot').className).toContain('is-yellow');
  });

  test('a character with no calls shows neutral', async () => {
    characterCalls = [];
    const { container } = await mountView();

    expect(navItems(container)[0].querySelector('.esi-dot').className).toContain('is-gray');
  });
});

/* ----------------------------------------------------------------- detail */

describe('call detail', () => {
  test('shows a prompt until a call is picked', async () => {
    const { container } = await mountView();

    expect(container.querySelector('.esi-detail-empty')).not.toBeNull();
    expect(calls.some((c) => c.fn === 'esiStatus.getCallDetails')).toBe(false);
  });

  test('renders status, cache and statistics sections', async () => {
    const { container } = await mountView();

    callRows(container)[0].click();
    await settle();

    const titles = [...container.querySelectorAll('.esi-section-title')].map((n) => n.textContent);
    expect(titles).toEqual(['Status', 'Cache & Rate Limiting', 'Statistics']);
  });

  test('an error call gains an error section with its code', async () => {
    callDetails = { status: characterCalls[1], history: [] };
    const { container } = await mountView();

    callRows(container)[1].click();
    await settle();

    expect(container.querySelector('.esi-error-code').textContent).toBe('Error Code: 420');
    expect(container.querySelector('.esi-error-box').textContent)
      .toContain('Error limited: too many requests.');
  });

  test('an error message is inserted as text, never as markup', async () => {
    callDetails = {
      status: characterCalls[1].call_key
        ? { ...characterCalls[1], error_message: '<img src=x onerror="alert(1)">' }
        : null,
      history: [],
    };
    const { container } = await mountView();

    callRows(container)[1].click();
    await settle();

    const box = container.querySelector('.esi-error-box');
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).toContain('<img src=x');
  });

  test('history entries render with their durations', async () => {
    callDetails = {
      status: characterCalls[0],
      history: [
        { timestamp: Date.now() - 60 * 1000, status: 'success', duration_ms: 142 },
        { timestamp: Date.now() - 120 * 1000, status: 'error', duration_ms: null },
      ],
    };
    const { container } = await mountView();

    callRows(container)[0].click();
    await settle();

    const titles = [...container.querySelectorAll('.esi-section-title')].map((n) => n.textContent);
    expect(titles).toContain('Recent History (last 2 calls)');
    expect(container.querySelector('.esi-section:last-child').textContent).toContain('(142ms)');
  });

  test('a cached endpoint reports when it will next be queried', async () => {
    callDetails = {
      status: call({ cache_expires_at: Date.now() + 5 * 60 * 1000 }),
      history: [],
    };
    const { container } = await mountView();

    callRows(container)[0].click();
    await settle();

    const labels = [...container.querySelectorAll('.esi-kv-label')].map((n) => n.textContent);
    expect(labels).toContain('Next automatic query');
    expect(labels).not.toContain('Rate limited until');
  });

  test('a rate-limited endpoint says so instead of reporting a cache wait', async () => {
    callDetails = {
      status: call({ next_allowed_at: Date.now() + 200 * 1000, cache_expires_at: null }),
      history: [],
    };
    const { container } = await mountView();

    callRows(container)[0].click();
    await settle();

    const rows = [...container.querySelectorAll('.esi-kv')];
    const limited = rows.find((r) => r.textContent.includes('Rate limited until'));
    expect(limited).toBeDefined();
    expect(limited.querySelector('.esi-kv-value').className).toContain('is-warning');
  });

  test('no countdown row when neither constraint is pending', async () => {
    const { container } = await mountView();

    callRows(container)[0].click();
    await settle();

    const labels = [...container.querySelectorAll('.esi-kv-label')].map((n) => n.textContent);
    expect(labels).not.toContain('Next automatic query');
    expect(labels).not.toContain('Rate limited until');
  });

  test('a detail fetch failure does not blank the call list', async () => {
    expectedErrorPatterns.push(/Error loading call details/);
    const { container } = await mountView();

    window.electronAPI.esiStatus.getCallDetails = async () => { throw new Error('nope'); };
    callRows(container)[0].click();
    await settle();

    expect(container.querySelector('.esi-detail-empty').textContent).toContain('Error loading details');
    expect(callRows(container)).toHaveLength(2);
  });
});

/* --------------------------------------------------------------- grouping */

/*
 * A `call_key` carries its arguments, so one logical endpoint yields one row
 * per argument - 147 "Structure Info" rows in a live database, burying the
 * five endpoints that actually differ. The list collapses them BY LABEL.
 *
 * This is a VIEW concern only: nothing here may change what the tracker
 * stores, and the per-key rows must stay individually addressable underneath.
 */
describe('grouping', () => {
  test('collapses many argument-keyed calls into one row', async () => {
    universeCalls = [
      call({ call_key: 'universe_server_status', endpoint_label: 'Server Status' }),
      ...argumentedCalls('Structure Info', 147),
    ];
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();

    expect(callRows(container)).toHaveLength(2);
    expect(callRows(container).map((r) => r.dataset.label))
      .toEqual(['Server Status', 'Structure Info']);
  });

  test('shows how many calls a collapsed row stands for', async () => {
    universeCalls = argumentedCalls('Structure Info', 147);
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();

    expect(container.querySelector('.esi-call-count').textContent).toBe('×147');
  });

  test('a lone call carries no count badge', async () => {
    const { container } = await mountView();

    // Both character calls have distinct labels, so neither collapses.
    expect(callRows(container)).toHaveLength(2);
    expect(container.querySelector('.esi-call-count')).toBeNull();
  });

  test('preserves the order endpoints arrive in', async () => {
    universeCalls = [
      ...argumentedCalls('Structure Info', 3),
      call({ call_key: 'universe_server_status', endpoint_label: 'Server Status' }),
      ...argumentedCalls('Structure Info', 2, { call_key: 'structure_999' }),
    ];
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();

    expect(callRows(container).map((r) => r.dataset.label))
      .toEqual(['Structure Info', 'Server Status']);
  });

  test('one failure among many successes surfaces on the group', async () => {
    // The whole point of collapsing: a single red must not be hidden by 146
    // greens. A group takes its WORST member.
    universeCalls = [
      ...argumentedCalls('Structure Info', 146),
      call({
        call_key: 'structure_broken',
        endpoint_label: 'Structure Info',
        status: 'error',
        updated_at: Date.now(),
        error_message: 'Forbidden',
        error_code: '403',
      }),
    ];
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();

    const row = callRows(container)[0];
    expect(row.querySelector('.esi-dot').className).toContain('is-red');
    expect(row.querySelector('.badge').textContent).toBe('ERROR');
  });

  test('a group says how many of its members are failing', async () => {
    universeCalls = [
      ...argumentedCalls('Structure Info', 8),
      call({
        call_key: 'structure_broken',
        endpoint_label: 'Structure Info',
        status: 'error',
        updated_at: Date.now(),
        error_message: 'Forbidden',
      }),
    ];
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();

    expect(container.querySelector('.esi-call-meta').textContent).toContain('1 of 9 failing');
  });

  test('a group reports its freshest member as the last query', async () => {
    const recent = Date.now() - 60 * 1000;
    universeCalls = [
      call({ call_key: 'structure_1', endpoint_label: 'Structure Info', last_query_at: Date.now() - 5 * HOUR }),
      call({ call_key: 'structure_2', endpoint_label: 'Structure Info', last_query_at: recent }),
    ];
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();

    expect(container.querySelector('.esi-call-meta').textContent)
      .toContain('Last query: 1 minute ago');
  });

  test('opening a group needs no extra IPC', async () => {
    universeCalls = argumentedCalls('Structure Info', 147);
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();

    const before = calls.filter((c) => c.fn === 'esiStatus.getCallDetails').length;
    callRows(container)[0].click();
    await settle();

    // A group has no single call_key; its detail is aggregated from rows the
    // list already fetched. 147 detail lookups would be absurd.
    expect(calls.filter((c) => c.fn === 'esiStatus.getCallDetails').length).toBe(before);
  });

  test('a group detail rolls up combined statistics', async () => {
    universeCalls = argumentedCalls('Structure Info', 3, {
      request_count: 4,
      success_count: 3,
      error_count: 1,
    });
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();
    callRows(container)[0].click();
    await settle();

    const rows = [...container.querySelectorAll('.esi-kv')];
    const value = (label) =>
      rows.find((r) => r.textContent.includes(label))?.querySelector('.esi-kv-value').textContent;

    expect(value('Tracked Calls')).toBe('3');
    expect(value('Total Requests')).toBe('12');
    expect(value('Successful')).toBe('9');
    expect(value('Failed')).toBe('3');
  });

  test('a group detail names its failing members', async () => {
    universeCalls = [
      ...argumentedCalls('Structure Info', 5),
      call({
        call_key: 'structure_broken',
        endpoint_label: 'Structure Info',
        status: 'error',
        updated_at: Date.now(),
        error_code: '403',
        error_message: 'Forbidden',
      }),
    ];
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();
    callRows(container)[0].click();
    await settle();

    const titles = [...container.querySelectorAll('.esi-section-title')].map((n) => n.textContent);
    expect(titles).toContain('Failing Calls (1)');

    const box = container.querySelector('.esi-error-box');
    expect(box.textContent).toContain('structure_broken');
    expect(box.textContent).toContain('[403] Forbidden');
  });

  test('a long failure list is truncated rather than dumped', async () => {
    universeCalls = Array.from({ length: 30 }, (_, i) =>
      call({
        call_key: `structure_broken_${i}`,
        endpoint_label: 'Structure Info',
        status: 'error',
        updated_at: Date.now(),
        error_message: 'Forbidden',
      })
    );
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();
    callRows(container)[0].click();
    await settle();

    expect(container.querySelectorAll('.esi-error-box')).toHaveLength(12);
    expect(container.querySelector('.esi-detail-more').textContent).toBe('+ 18 more');
  });

  test('a singleton still fetches its history', async () => {
    const { container } = await mountView();

    callRows(container)[0].click();
    await settle();

    // Grouping must not cost a one-of-a-kind endpoint its detail lookup.
    expect(calls.some((c) => c.fn === 'esiStatus.getCallDetails')).toBe(true);
    expect(container.querySelector('.esi-detail-key').textContent)
      .toBe('char:91316135:skills');
  });

  test('selecting a group survives a refresh', async () => {
    universeCalls = argumentedCalls('Structure Info', 147);
    const { container } = await mountView();

    container.querySelector('#esi-nav-universe').click();
    await settle();
    callRows(container)[0].click();
    await settle();

    emitDataChanged();
    jest.advanceTimersByTime(400);
    await settle();

    expect(container.querySelector('.esi-call.is-selected').dataset.label)
      .toBe('Structure Info');
  });
});

/* ------------------------------------------------------- background refresh */

describe('live refresh', () => {
  test('subscribes to the data bus rather than polling hard', async () => {
    await mountView();

    expect(subscribers['esi:data-changed']).toHaveLength(1);
  });

  test('keeps a slow fallback tick so relative times stay honest', async () => {
    const { made } = await mountView();

    expect(made.intervals).toHaveLength(1);
    expect(made.intervals[0].ms).toBe(60000);
  });

  test('coalesces a burst of events into a single refresh', async () => {
    const { container } = await mountView();
    callRows(container)[0].click();
    await settle();

    const before = calls.filter((c) => c.fn === 'esiStatus.getCharacterCalls').length;

    // A paginated fetch emits once per endpoint.
    emitDataChanged();
    emitDataChanged();
    emitDataChanged();
    jest.advanceTimersByTime(400);
    await settle();

    const after = calls.filter((c) => c.fn === 'esiStatus.getCharacterCalls').length;
    // One refresh reads the selected character's calls twice: once for the nav
    // dot, once for the list. Three events must not multiply that.
    expect(after - before).toBeLessThanOrEqual(3);
    expect(after).toBeGreaterThan(before);
  });

  test('a refresh preserves the selected call', async () => {
    const { container } = await mountView();

    callRows(container)[1].click();
    await settle();
    expect(container.querySelector('.esi-call.is-selected').dataset.label)
      .toBe('Character Assets');

    emitDataChanged();
    jest.advanceTimersByTime(400);
    await settle();

    expect(container.querySelector('.esi-call.is-selected').dataset.label)
      .toBe('Character Assets');
  });

  test('a refresh preserves the selected character', async () => {
    const { container } = await mountView();

    navItems(container)[1].click();
    await settle();

    emitDataChanged();
    jest.advanceTimersByTime(400);
    await settle();

    expect(container.querySelector('#esi-calls-title').textContent).toBe('Halcyon');
    const active = navItems(container).filter((n) => n.classList.contains('is-active'));
    expect(active).toHaveLength(1);
    expect(active[0].dataset.characterId).toBe('91316136');
  });

  test('a selection that disappears clears the detail pane', async () => {
    const { container } = await mountView();

    callRows(container)[1].click();
    await settle();

    // The endpoint is gone on the next read.
    characterCalls = [call()];
    emitDataChanged();
    jest.advanceTimersByTime(400);
    await settle();

    expect(container.querySelector('.esi-call.is-selected')).toBeNull();
    expect(container.querySelector('.esi-detail-empty')).not.toBeNull();
  });

  test('refreshed rows pick up a status change', async () => {
    const { container } = await mountView();
    expect(callRows(container)[0].querySelector('.esi-dot').className).toContain('is-green');

    characterCalls = [
      call({ status: 'error', updated_at: Date.now(), error_message: 'boom' }),
      characterCalls[1],
    ];
    emitDataChanged();
    jest.advanceTimersByTime(400);
    await settle();

    expect(callRows(container)[0].querySelector('.esi-dot').className).toContain('is-red');
  });
});

/* --------------------------------------------------------------- teardown */

describe('teardown', () => {
  test('releases the bus subscription on unmount', async () => {
    const { instance, ctx } = await mountView();

    expect(subscribers['esi:data-changed']).toHaveLength(1);
    if (instance && instance.destroy) instance.destroy();
    ctx.dispose();

    expect(subscribers['esi:data-changed']).toHaveLength(0);
  });

  test('a remount registers exactly one subscription', async () => {
    const first = await mountView();
    if (first.instance && first.instance.destroy) first.instance.destroy();
    first.ctx.dispose();

    await mountView();

    expect(subscribers['esi:data-changed']).toHaveLength(1);
  });
});

/* -------------------------------------------------------------- stylesheet */

/*
 * jsdom applies no stylesheets, so every rule below is asserted against the
 * stylesheet TEXT. `expect(el.classList.contains('is-selected')).toBe(true)`
 * passes whether or not the rule that paints it exists.
 */
describe('stylesheet contracts', () => {
  /**
   * The single rule whose selector list is exactly `selector`.
   *
   * Whitespace before `{` is arbitrary in CSS - column-aligned rules are
   * common - so the gap is `\s+`, not one literal space. Matching a bare
   * `selector {` also silently matches GROUPED rules (`.a, .b {` contains
   * `.b {`), which has produced false passes twice in this migration, so the
   * selector must start the line and be followed only by the brace.
   */
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = VIEW_CSS.match(new RegExp(`^${escaped}\\s*\\{[^}]*\\}`, 'm'));
    expect(match).not.toBeNull();
    return match[0];
  };

  test('the nav highlight is box-shadow, never a toggled background', () => {
    const active = rule('.esi-nav-item.is-active');
    expect(active).toContain('box-shadow:');
    // Binding rule 1: a background-color set on a row highlighted at first
    // paint does not clear reliably.
    expect(active).not.toMatch(/background(-color)?:/);
  });

  test('the nav base keeps a constant transparent background', () => {
    const base = rule('.esi-nav-item');
    expect(base).toContain('background-color: transparent');
    expect(base).toContain('box-shadow: none');
  });

  test('both nav branches set the same property so the highlight resets', () => {
    // Binding rule 3: a property set in only one branch never resets.
    expect(rule('.esi-nav-item')).toContain('box-shadow:');
    expect(rule('.esi-nav-item.is-active')).toContain('box-shadow:');
    expect(rule('.esi-nav-item:hover')).toContain('box-shadow:');
  });

  test('the call row stripe survives selection', () => {
    // The stripe encodes STATUS. If the selected branch omitted it, selecting
    // a row would erase its status colour.
    expect(rule('.esi-call')).toContain('inset 4px 0 0 var(--qf-call-accent');
    expect(rule('.esi-call.is-selected')).toContain('inset 4px 0 0 var(--qf-call-accent');
  });

  test('selection does not repaint the call row background', () => {
    const selected = rule('.esi-call.is-selected');
    expect(selected).toContain('box-shadow:');
    expect(selected).not.toMatch(/background(-color)?:/);
  });

  test('the view scrolls per pane, never as a whole', () => {
    // A single scrolling view would move the nav and detail panes along with
    // a long call list.
    expect(rule('.esi-view')).toContain('height: 100%');
    expect(VIEW_CSS).toMatch(/\.esi-view > \* \{[^}]*overflow-y: auto/);
  });

  test('hidden wins against the explicit displays in this view', () => {
    // Binding rule 6a: `hidden` is only a browser-DEFAULT display:none.
    expect(VIEW_CSS).toContain('#esi-status-view [hidden] { display: none !important; }');
  });

  test('the calls header is not a bare <header> tag', () => {
    // styles.css styles the bare `header` tag as a full-bleed page header
    // (dark wash, 2px border, page-header padding) and `header h1` with a
    // gradient text fill. Both landed on this block purely by tag name and
    // repainted it. A <div> sidesteps the collision at the source; styles.css
    // is left alone because every un-ported page still relies on it.
    expect(VIEW_HTML).toContain('<div class="esi-calls-head">');
    expect(VIEW_HTML).not.toMatch(/<header[^>]*class="esi-calls-head"/);
  });

  test('every status dot colour is defined', () => {
    ['is-green', 'is-red', 'is-yellow', 'is-gray'].forEach((cls) => {
      expect(rule(`.esi-dot.${cls}`)).toContain('background:');
    });
  });
});
