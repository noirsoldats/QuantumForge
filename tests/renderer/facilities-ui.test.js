/**
 * @jest-environment jsdom
 *
 * Facilities Manager shell view.
 *
 * The renderer is an IIFE that registers itself with the shell router and
 * exposes nothing, so these tests drive it the way a user does: mount it,
 * type and click, then assert on the DOM.
 *
 * The fixtures below use the REAL field names each IPC returns - cost indices
 * key on `activity`, structure bonuses on materialEfficiency/timeEfficiency/
 * costReduction, and getAllSystems returns raw SDE columns
 * (solarSystemID/solarSystemName/regionID). Inventing friendlier names in a
 * fixture is how a renderer ends up reading fields that do not exist.
 *
 * console.error is captured and any unexpected entry FAILS the test: this
 * renderer swallows its own failures into logs, so a green suite would
 * otherwise say nothing about whether the view actually rendered.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/facilities.view.html'),
  'utf8'
);

require('../../public/shared/qf-search-select.js');
// Sets window.QFUI, the same way index.html loads it before every view
// renderer. The renderer calls QFUI.withButtonBusy on its action buttons.
require('../../public/shared/ui-helpers.js');
// Sets window.QFFacilityImport, the same way index.html loads it before the
// view renderer. Without it both import buttons no-op.
require('../../src/renderer/facility-import-parsers.js');

/* --------------------------------------------------------------- fixtures */

let regions;
let allSystems;
let structureTypes;
let structureRigs;
let facilities;
let costIndices;
let structureBonuses;
/** Optional per-structure-type overrides, so dedup is observable. */
let bonusesByType;
let rigEffects;
let calls;
let consoleErrors = [];
let expectedErrorPatterns = [];
let registered;
/** Timer ids the view scheduled, so teardown can cancel them. */
let pendingTimers = [];

// Record every timer the renderer sets, so teardown can cancel it: an
// uncancelled timer keeps the Jest worker alive after the suite finishes,
// which reads as a hang rather than a failure. The renderer schedules none
// today (the two-step delete's 4s arm timer is gone), but QFSearchSelect and
// any future timer still land here.
const realSetTimeout = global.setTimeout;
global.setTimeout = function trackedSetTimeout(fn, ms, ...rest) {
  const id = realSetTimeout(fn, ms, ...rest);
  pendingTimers.push(id);
  return id;
};

function allowErrors(...patterns) {
  expectedErrorPatterns.push(...patterns);
}

function makeApi() {
  return {
    facilities: {
      getAllRegions: async () => regions,
      getStructureTypes: async () => structureTypes,
      getStructureRigs: async (structureType) => {
        calls.push({ fn: 'getStructureRigs', structureType });
        // main filters on rigCategory, not structureType.
        return structureType
          ? structureRigs.filter((r) => r.rigCategory === structureType)
          : structureRigs;
      },
      getStructureBonuses: async (typeId) => {
        calls.push({ fn: 'getStructureBonuses', typeId });
        // Per-type when the test supplies one, so dedup is observable.
        return bonusesByType[String(typeId)] || structureBonuses;
      },
      getCostIndices: async (systemId) => {
        calls.push({ fn: 'getCostIndices', systemId });
        return costIndices;
      },
      // Takes ONE rig id, not an array.
      getRigEffects: async (typeId) => {
        calls.push({ fn: 'getRigEffects', typeId });
        return rigEffects[typeId] || [];
      },
      getFacilities: async () => {
        calls.push({ fn: 'getFacilities' });
        return facilities;
      },
      addFacility: async (payload) => {
        calls.push({ fn: 'addFacility', payload });
        return { id: 'new' };
      },
      updateFacility: async (id, payload) => {
        calls.push({ fn: 'updateFacility', id, payload });
        return true;
      },
      removeFacility: async (id) => {
        calls.push({ fn: 'removeFacility', id });
        return true;
      },
    },
    sde: {
      // Called with NO argument: every system, for naming facilities in any
      // region. Raw SDE column names.
      getAllSystems: async (regionId) => {
        calls.push({ fn: 'getAllSystems', regionId });
        return allSystems;
      },
    },
  };
}

/* ---------------------------------------------------------------- harness */

function loadRenderer() {
  jest.isolateModules(() => {
    require('../../src/renderer/facilities-view-renderer.js');
  });
}

function makeCtx() {
  const listeners = [];
  const tracked = [];
  return {
    ctx: {
      on: (target, type, handler) => {
        if (!target) return;
        target.addEventListener(type, handler);
        listeners.push([target, type, handler]);
      },
      track: (fn) => tracked.push(fn),
      dispose: () => {
        listeners.forEach(([t, ty, h]) => t.removeEventListener(ty, h));
        tracked.forEach((fn) => fn());
      },
    },
  };
}

async function settle(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function mountView(params) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { ctx } = makeCtx();
  const instance = await registered.def.mount(container, params || {}, ctx);
  await settle();
  return { container, ctx, instance };
}

/**
 * Choose a structure by name from the native <select>.
 *
 * Not a QFSearchSelect: five fixed options, grouped into non-selectable
 * <optgroup> headers, so a plain select is both simpler and more correct.
 */
async function pickStructure(name) {
  const select = document.getElementById('fac-structure');
  const option = Array.from(select.options).find((o) => o.textContent.startsWith(name));
  if (!option) throw new Error(`No structure option starting "${name}"`);
  select.value = option.value;
  select.dispatchEvent(new window.Event('change'));
  await settle(30);
}

/** Pick an option from a QFSearchSelect by its visible label. */
async function pickOption(hostId, label) {
  document.querySelector(`#${hostId} .qf-ss-trigger`)
    .dispatchEvent(new window.MouseEvent('click'));
  await settle();

  const row = Array.from(document.querySelectorAll('.qf-ss-row'))
    .find((r) => r.textContent.includes(label));
  if (!row) throw new Error(`No option matching "${label}" in #${hostId}`);
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(30);
}

beforeEach(() => {
  consoleErrors = [];
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    // Only the message text. Stringifying every argument walks whatever was
    // logged - an Error carrying a DOM node or a QFSearchSelect instance
    // serialises an enormous graph, which burns a core for minutes and reads
    // as a hang rather than a failure.
    consoleErrors.push(
      args
        .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : ''))
        .filter(Boolean)
        .join(' ')
    );
  });

  calls = [];

  regions = [
    { regionId: 10000002, regionName: 'The Forge' },
    { regionId: 10000043, regionName: 'Domain' },
  ];

  allSystems = [
    { solarSystemID: 30000142, solarSystemName: 'Jita', security: 0.946, regionID: 10000002 },
    { solarSystemID: 30000144, solarSystemName: 'Perimeter', security: 1.0, regionID: 10000002 },
    { solarSystemID: 30002510, solarSystemName: 'Amarr', security: 1.0, regionID: 10000043 },
    { solarSystemID: 30004759, solarSystemName: '1DQ1-A', security: -0.4, regionID: 10000060 },
  ];

  // getStructureTypes maps typeName -> `name`, same as getStructureRigs.
  // Reading typeName here rendered every option as "undefined — Engineering
  // Complex".
  structureTypes = [
    {
      typeId: 35827, name: 'Sotiyo', groupName: 'Engineering Complex',
      groupId: 1404, structureType: 'engineering', size: 'L',
    },
    {
      typeId: 35825, name: 'Raitaru', groupName: 'Engineering Complex',
      groupId: 1404, structureType: 'engineering', size: 'M',
    },
    {
      typeId: 35835, name: 'Athanor', groupName: 'Refinery',
      groupId: 1406, structureType: 'refinery', size: 'M',
    },
  ];

  // getStructureRigs returns `name` (NOT typeName), a NUMERIC rigSize
  // (2=M, 3=L, 4=XL) and `rigCategory` (NOT structureType). Inventing
  // friendlier names here is exactly what let the renderer read fields that
  // do not exist and render empty chips.
  structureRigs = [
    {
      typeId: 43931,
      name: 'Standup L-Set Advanced Material Efficiency II',
      groupName: 'Structure Engineering Rig L',
      rigSize: 3,
      rigCategory: 'engineering',
      sizeLabel: 'L',
    },
    {
      typeId: 43920,
      name: 'Standup M-Set Basic Material Efficiency I',
      groupName: 'Structure Engineering Rig M',
      rigSize: 2,
      rigCategory: 'engineering',
      sizeLabel: 'M',
    },
    {
      typeId: 46496,
      name: 'Standup M-Set Basic Reprocessing I',
      groupName: 'Structure Resource Rig M',
      rigSize: 2,
      rigCategory: 'refinery',
      sizeLabel: 'M',
    },
  ];

  structureBonuses = {
    structureName: 'Sotiyo',
    structureType: 'engineering',
    // NUMERIC, from dgmTypeAttributes attribute 1547. Not a size label.
    rigSize: 3,
    materialEfficiency: 1.0,
    timeEfficiency: 30.0,
    costReduction: 5.0,
  };

  // Any type NOT listed here falls through to `structureBonuses` above - the
  // Sotiyo, which is engineering/rigSize 3. A refinery left unlisted would
  // therefore be described as an engineering complex, and its own rigs would
  // read as unfittable, so every structureType in the fixture needs an entry.
  bonusesByType = {
    35825: {
      structureName: 'Raitaru',
      structureType: 'engineering',
      rigSize: 2,
      materialEfficiency: 1.0,
      timeEfficiency: 15.0,
      costReduction: 3.0,
    },
    35835: {
      structureName: 'Athanor',
      structureType: 'refinery',
      rigSize: 2,
      materialEfficiency: 2.0,
      timeEfficiency: 20.0,
      costReduction: 3.0,
    },
  };

  // Raw dogma attributes: most are fitting metadata the panel must filter out.
  rigEffects = {
    43931: [
      { displayName: 'Manufacturing Material Bonus', value: -2.4 },
      { displayName: 'Rig Size', value: 3 },
      { displayName: 'Calibration Cost', value: 200 },
    ],
  };

  costIndices = [
    { activity: 'manufacturing', costIndex: 0.0412 },
    { activity: 'copying', costIndex: 0.0189 },
  ];

  facilities = [
    {
      id: 'f1',
      name: 'Forge Prime Assembly',
      usage: 'default',
      facilityType: 'structure',
      regionId: 10000002,
      systemId: 30000142,
      securityStatus: 0.946,
      structureTypeId: 35827,
      rigs: [43931],
      facilityTax: 2.5,
    },
    {
      id: 'f2',
      name: 'Jita IV-4 CNAP',
      usage: 'copy',
      facilityType: 'station',
      regionId: 10000002,
      systemId: 30000142,
      securityStatus: 0.946,
    },
  ];

  registered = null;
  window.QFShell = {
    router: {
      register: (id, def) => { registered = { id, def }; },
    },
  };
  window.QFToast = { show: jest.fn() };
  window.electronAPI = makeApi();

  document.body.innerHTML = VIEW_HTML;
  loadRenderer();
});

afterEach(() => {
  const unexpected = consoleErrors.filter(
    (e) => !expectedErrorPatterns.some((p) => p.test(e))
  );
  expectedErrorPatterns = [];
  console.error.mockRestore();
  // Most tests never unmount, so any timer the view scheduled would otherwise
  // keep the worker alive after the suite finishes - a hang, not a failure.
  pendingTimers.forEach((id) => clearTimeout(id));
  pendingTimers = [];
  document.body.innerHTML = '';

  if (unexpected.length > 0) {
    throw new Error(
      `Renderer logged ${unexpected.length} unexpected error(s):\n  ` + unexpected.join('\n  ')
    );
  }
});

/* ------------------------------------------------------------------ tests */

describe('registration', () => {
  test('registers as a native shell view, not a framed page', () => {
    expect(registered.id).toBe('facilities');
    expect(typeof registered.def.mount).toBe('function');
  });
});

describe('mount', () => {
  test('renders the view and lists configured facilities', async () => {
    await mountView();

    expect(document.getElementById('fac-view')).not.toBeNull();
    expect(document.querySelectorAll('#fac-list .fac-facility')).toHaveLength(2);
  });

  test('shows the facility count', async () => {
    await mountView();
    expect(document.getElementById('fac-count').textContent).toBe('2');
  });

  test('the list header carries its own count pill', async () => {
    await mountView();
    expect(document.getElementById('fac-list-count').textContent).toBe('2');
  });

  test('the global bare-`header` chrome is reset inside the view', () => {
    // styles.css styles the BARE `header` element for the legacy pages: a
    // dark fill, padding and a 2px bottom border. The headers here are
    // section labels, so that page chrome has to be neutralised or the
    // "Manufacturing Facilities" heading renders as a dark block.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/facilities-view.css'),
      'utf8'
    );
    const reset = css.match(/#fac-view header\s*\{[^}]*\}/);
    expect(reset).not.toBeNull();
    expect(reset[0]).toMatch(/background:\s*none/);
    expect(reset[0]).toMatch(/padding:\s*0/);
    expect(reset[0]).toMatch(/border-bottom:\s*none/);
  });

  test('the form card header keeps its own padding and divider', () => {
    // The reset above is view-wide, so the card header must restate what it
    // actually wants rather than inheriting it.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/facilities-view.css'),
      'utf8'
    );
    const rule = css.match(/#fac-view \.fac-card-head\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/padding:\s*15px/);
    expect(rule).toMatch(/border-bottom:\s*1px/);
  });

  test('the count pill is a rounded pill, not a square block', () => {
    // jsdom applies no stylesheets, so assert against the real CSS.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/facilities-view.css'),
      'utf8'
    );
    const rule = css.match(/#fac-view\s+\.fac-list-count\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/border-radius:\s*var\(--qf-radius-pill\)/);
    expect(rule).toMatch(/background-color:\s*var\(--qf-surface\)/);
  });

  test('loads ALL systems, not one region', async () => {
    // Cards name facilities in any region; a region-scoped list would render
    // "Unknown System" for everything outside the current selection.
    await mountView();

    const call = calls.find((c) => c.fn === 'getAllSystems');
    expect(call.regionId).toBeUndefined();
  });

  test('every element toggled by `hidden` is hideable by CSS (rule 6a)', () => {
    // jsdom applies no stylesheets, so el.hidden proves nothing about what
    // the user sees. Assert against the real CSS instead.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/facilities-view.css'),
      'utf8'
    );
    expect(css).toMatch(/#fac-view\s*\[hidden\]\s*\{[^}]*display:\s*none/);
  });
});

describe('facility cards', () => {
  test('resolves system and region names from IDs', async () => {
    // The stored facility holds IDs only.
    await mountView();

    const card = document.querySelector('[data-fac-id="f1"]');
    expect(card.textContent).toContain('Jita');
    expect(card.textContent).toContain('The Forge');
    expect(card.textContent).not.toContain('Unknown System');
  });

  test('names a facility in a region other than the selected one', async () => {
    facilities.push({
      id: 'f3',
      name: 'Null Outpost',
      usage: 'capitals',
      facilityType: 'station',
      regionId: 10000060,
      systemId: 30004759,
    });
    await mountView();

    expect(document.querySelector('[data-fac-id="f3"]').textContent).toContain('1DQ1-A');
  });

  test('resolves structure type and rig names', async () => {
    await mountView();

    const card = document.querySelector('[data-fac-id="f1"]');
    expect(card.textContent).toContain('Sotiyo');
    expect(card.textContent).toContain('Standup L-Set Advanced Material Efficiency II');
  });

  test('installed rig chips are never empty', async () => {
    // Reading rig.typeName - which getStructureRigs does not return - made
    // every chip render as a blank bubble.
    await mountView();

    const chips = document.querySelectorAll('[data-fac-id="f1"] .fac-rig-chip-row .fac-rig-chip');
    expect(chips.length).toBeGreaterThan(0);
    chips.forEach((chip) => expect(chip.textContent.trim()).not.toBe(''));
  });

  test('installed rigs stack vertically', () => {
    // Rig names are long, so side by side they either widen the card or wrap
    // mid-name. jsdom computes no layout, so assert against the CSS.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/facilities-view.css'),
      'utf8'
    );
    const rule = css.match(/#fac-view\s+\.fac-rig-chip-row\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/flex-direction:\s*column/);
    expect(rule).not.toMatch(/flex-wrap/);
  });

  describe('truncated text stays reachable', () => {
    // Every element the CSS ellipsises must carry its full value as a title,
    // or the cut-off part is simply lost.
    test('a rig chip carries its full name on hover', async () => {
      await mountView();

      const chip = document.querySelector('[data-fac-id="f1"] .fac-rig-chip-row .fac-rig-chip');
      expect(chip.title).toBe('Standup L-Set Advanced Material Efficiency II');
    });

    test('the facility name carries its full value', async () => {
      facilities[0].name = 'An Extremely Long Facility Name That Will Not Fit';
      await mountView();

      expect(document.querySelector('[data-fac-id="f1"] .fac-facility-name').title)
        .toBe('An Extremely Long Facility Name That Will Not Fit');
    });

    test('the location carries its full value', async () => {
      await mountView();

      expect(document.querySelector('[data-fac-id="f1"] .fac-location-text').title)
        .toBe('Jita, The Forge');
    });

    test('the structure type carries its full value', async () => {
      await mountView();

      expect(document.querySelector('[data-fac-id="f1"] .fac-detail-value').title)
        .toBe('Sotiyo');
    });

    test('every ellipsised element is one that carries a title', () => {
      // Guards the pairing itself: adding text-overflow to a new element
      // without a title would silently make its content unreachable.
      const css = fs.readFileSync(
        path.join(__dirname, '../../public/facilities-view.css'),
        'utf8'
      );
      const ellipsised = [...css.matchAll(/#fac-view\s+([^{]+)\{[^}]*text-overflow:\s*ellipsis/g)]
        .map((m) => m[1].trim());

      // If this list grows, the new selector needs a truncatedCell() call too.
      expect(ellipsised.sort()).toEqual([
        '.fac-detail-value',
        '.fac-facility-name',
        '.fac-location-text',
        '.fac-rig-chip-row .fac-rig-chip',
      ]);
    });
  });

  test('an unknown rig id says so rather than rendering blank', async () => {
    facilities[0].rigs = [99999];
    await mountView();

    const chip = document.querySelector('[data-fac-id="f1"] .fac-rig-chip-row .fac-rig-chip');
    expect(chip.textContent).toBe('Unknown Rig');
  });

  test('badges the usage, marking Default apart', async () => {
    await mountView();

    const badge = document.querySelector('[data-fac-id="f1"] .fac-badge-usage');
    expect(badge.textContent).toBe('Default');
    expect(badge.getAttribute('data-usage')).toBe('default');
  });

  describe('structure bonus chips', () => {
    test('shows the structure ME/TE/Cost bonuses', async () => {
      await mountView();

      const chips = document.querySelector('[data-fac-id="f1"] .fac-bonus-chips');
      expect(chips.textContent).toContain('-1.0%');
      expect(chips.textContent).toContain('-30.0%');
      expect(chips.textContent).toContain('-5.0%');
    });

    test('EXCLUDES rig bonuses, and says so', async () => {
      // A rig's bonus depends on what is being built (rigAffectsProduct) and
      // on system security. A combined figure on a card would claim a
      // reduction that may not apply to the job in hand.
      await mountView();

      const chips = document.querySelector('[data-fac-id="f1"] .fac-bonus-chips');
      // Sotiyo TE is 30; the fitted rig would add 24 more if it counted.
      expect(chips.textContent).toContain('-30.0%');
      expect(chips.textContent).not.toContain('-54');
      expect(chips.title).toContain('not included');
    });

    test('a zero bonus is stated on the card, not hidden', async () => {
      structureBonuses = { ...structureBonuses, costReduction: 0 };
      await mountView();

      const zero = document.querySelector('[data-fac-id="f1"] .fac-bonus-chip.is-zero');
      expect(zero).not.toBeNull();
      expect(zero.textContent).toContain('0%');
    });

    test('one lookup per structure TYPE, not per facility', async () => {
      // Ten Raitarus share a bonus; fetching each would be nine wasted calls.
      facilities = [
        { id: 'a', name: 'A', usage: 'components', facilityType: 'structure', regionId: 10000002, systemId: 30000142, structureTypeId: 35827, rigs: [] },
        { id: 'b', name: 'B', usage: 'capitals', facilityType: 'structure', regionId: 10000002, systemId: 30000142, structureTypeId: 35827, rigs: [] },
        { id: 'c', name: 'C', usage: 'copy', facilityType: 'structure', regionId: 10000002, systemId: 30000142, structureTypeId: 35825, rigs: [] },
      ];
      await mountView();

      const ids = calls.filter((c) => c.fn === 'getStructureBonuses').map((c) => c.typeId);
      expect(ids.sort()).toEqual(['35825', '35827']);
    });

    test('NPC stations need no lookup', async () => {
      facilities = [facilities[1]]; // the station
      await mountView();

      expect(calls.some((c) => c.fn === 'getStructureBonuses')).toBe(false);
    });

    test('a reload reuses the cache rather than refetching', async () => {
      // The SDE does not change while the app runs, so the same structure
      // type must not be looked up again on every list reload.
      await mountView();
      expect(calls.filter((c) => c.fn === 'getStructureBonuses')).toHaveLength(1);
      calls.length = 0;

      // Removing the STATION reloads the list, which still contains the
      // Sotiyo facility - so a cacheless implementation would refetch it.
      document.querySelector('[data-fac-remove="f2"]')
        .dispatchEvent(new window.MouseEvent('click'));
      await settle(20);
      document.getElementById('fac-delete-ok')
        .dispatchEvent(new window.MouseEvent('click'));
      await settle(40);

      expect(calls.some((c) => c.fn === 'getFacilities')).toBe(true);
      expect(calls.some((c) => c.fn === 'getStructureBonuses')).toBe(false);
    });

    test('a failed lookup drops the chips without breaking the card', async () => {
      window.electronAPI.facilities.getStructureBonuses = async () => {
        throw new Error('sde gone');
      };
      allowErrors(/structure bonuses/);

      await mountView();

      const card = document.querySelector('[data-fac-id="f1"]');
      expect(card.querySelector('.fac-bonus-chips')).toBeNull();
      // The rest of the card is intact.
      expect(card.textContent).toContain('Sotiyo');
    });
  });

  test('shows facility tax for structures', async () => {
    await mountView();
    expect(document.querySelector('[data-fac-id="f1"]').textContent).toContain('2.50%');
  });

  test('an NPC station says it has no bonuses, and shows no tax', async () => {
    await mountView();

    const card = document.querySelector('[data-fac-id="f2"]');
    expect(card.textContent).toContain('no manufacturing bonuses');
    expect(card.textContent).not.toContain('Facility Tax');
  });

  test('colour-codes security by band', async () => {
    facilities = [
      { id: 'hi', name: 'A', usage: 'copy', facilityType: 'station', regionId: 10000002, systemId: 30000142, securityStatus: 0.9 },
      { id: 'lo', name: 'B', usage: 'copy', facilityType: 'station', regionId: 10000002, systemId: 30000142, securityStatus: 0.3 },
      // NOT id 'null': jsdom's attribute selector matches the FIRST element
      // for that value rather than the one that has it, so the assertion
      // would silently read the wrong card.
      { id: 'nul', name: 'C', usage: 'copy', facilityType: 'station', regionId: 10000002, systemId: 30000142, securityStatus: -0.4 },
    ];
    await mountView();

    expect(document.querySelector('[data-fac-id="hi"] .fac-sec').className).toContain('is-high');
    expect(document.querySelector('[data-fac-id="lo"] .fac-sec').className).toContain('is-low');
    expect(document.querySelector('[data-fac-id="nul"] .fac-sec').className).toContain('is-null');
  });

  test('an empty list renders an empty state', async () => {
    facilities = [];
    await mountView();

    expect(document.querySelector('#fac-list .fac-empty')).not.toBeNull();
    expect(document.getElementById('fac-count').textContent).toBe('0');
  });
});

describe('facility type', () => {
  test('structure-only fields are hidden for an NPC station', async () => {
    await mountView();

    expect(document.getElementById('fac-structure-field').hidden).toBe(true);
    expect(document.getElementById('fac-structure-extras').hidden).toBe(true);
  });

  test('choosing Player Structure reveals structure type, rigs and tax', async () => {
    await mountView();

    const select = document.getElementById('fac-type');
    select.value = 'structure';
    select.dispatchEvent(new window.Event('change'));

    expect(document.getElementById('fac-structure-field').hidden).toBe(false);
    expect(document.getElementById('fac-structure-extras').hidden).toBe(false);
  });

  test('a structure defaults to 0% tax; a station stores none', async () => {
    // NPC stations fall back to main's own default rate rather than storing
    // one here.
    await mountView();
    const select = document.getElementById('fac-type');

    select.value = 'structure';
    select.dispatchEvent(new window.Event('change'));
    expect(document.getElementById('fac-tax').value).toBe('0.00');

    select.value = 'station';
    select.dispatchEvent(new window.Event('change'));
    expect(document.getElementById('fac-tax').value).toBe('');
  });
});

describe('region and system', () => {
  test('systems are filtered to the chosen region', async () => {
    await mountView();
    await pickOption('fac-region-host', 'The Forge');

    document.querySelector('#fac-system-host .qf-ss-trigger')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const labels = Array.from(document.querySelectorAll('.qf-ss-row')).map((r) => r.textContent);
    expect(labels.some((l) => l.includes('Jita'))).toBe(true);
    expect(labels.some((l) => l.includes('Amarr'))).toBe(false);
  });

  test('filtering happens locally - no refetch per region', async () => {
    await mountView();
    calls.length = 0;

    await pickOption('fac-region-host', 'The Forge');

    expect(calls.filter((c) => c.fn === 'getAllSystems')).toHaveLength(0);
  });

  test('choosing a system loads its cost indices', async () => {
    await mountView();
    await pickOption('fac-region-host', 'The Forge');
    await pickOption('fac-system-host', 'Jita');

    const call = calls.find((c) => c.fn === 'getCostIndices');
    expect(call.systemId).toBe(30000142);
    expect(document.getElementById('fac-cost-panel').hidden).toBe(false);
  });

  test('cost index activity names are humanised, values shown as percent', async () => {
    costIndices = [{ activity: 'reaction_jobs', costIndex: 0.0412 }];
    await mountView();
    await pickOption('fac-region-host', 'The Forge');
    await pickOption('fac-system-host', 'Jita');

    const text = document.getElementById('fac-cost-indices').textContent;
    expect(text).toContain('Reaction Jobs');
    expect(text).toContain('4.12%');
  });

  test('a system with no index data says so rather than hiding the panel', async () => {
    costIndices = [];
    await mountView();
    await pickOption('fac-region-host', 'The Forge');
    await pickOption('fac-system-host', 'Jita');

    expect(document.getElementById('fac-cost-panel').hidden).toBe(false);
    expect(document.getElementById('fac-cost-indices').textContent)
      .toContain('No cost index data');
  });
});

describe('structure bonuses and rigs', () => {
  /**
   * Mount, switch to Player Structure, and select the Sotiyo.
   *
   * Deliberately NOT named pickStructure: a local of that name shadows the
   * module-level helper, so `pickStructure('Sotiyo')` inside it resolved to
   * itself - unbounded async recursion that pegged a core and read as a hang.
   */
  async function selectSotiyo() {
    await mountView();
    const select = document.getElementById('fac-type');
    select.value = 'structure';
    select.dispatchEvent(new window.Event('change'));
    await pickStructure('Sotiyo');
  }

  describe('structure dropdown', () => {
    async function openStructureForm() {
      await mountView();
      const select = document.getElementById('fac-type');
      select.value = 'structure';
      select.dispatchEvent(new window.Event('change'));
      await settle();
    }

    test('is a plain select, not a searchable combobox', async () => {
      // Five fixed options, and <optgroup> gives non-selectable category
      // headers natively (binding rule 5).
      await openStructureForm();

      expect(document.getElementById('fac-structure').tagName).toBe('SELECT');
      expect(document.querySelector('#fac-structure-host')).toBeNull();
    });

    test('groups options under non-selectable category headers', async () => {
      await openStructureForm();

      const groups = Array.from(document.querySelectorAll('#fac-structure optgroup'));
      expect(groups.map((g) => g.label)).toEqual([
        'Engineering Complexes (Manufacturing)',
        'Refineries (Reactions/Reprocessing)',
      ]);
      // A header is a heading, never something the user can select: only
      // <option> elements are selectable, and none of them is a group name.
      const optionLabels = Array.from(document.querySelectorAll('#fac-structure option'))
        .map((o) => o.textContent);
      expect(optionLabels).not.toContain('Engineering Complexes (Manufacturing)');
      expect(optionLabels).not.toContain('Refineries (Reactions/Reprocessing)');
    });

    test('labels each option "Name (Size-Set)"', async () => {
      // Matches the live app.
      await openStructureForm();

      const labels = Array.from(document.querySelectorAll('#fac-structure option'))
        .map((o) => o.textContent);
      expect(labels).toContain('Sotiyo (L-Set)');
      expect(labels).toContain('Raitaru (M-Set)');
      expect(labels).toContain('Athanor (M-Set)');
      // getStructureTypes returns `name`; reading typeName rendered every
      // option as "undefined".
      expect(labels.some((l) => l.includes('undefined'))).toBe(false);
    });

    test('refineries are grouped apart from engineering complexes', async () => {
      await openStructureForm();

      const [engineering, refinery] = document.querySelectorAll('#fac-structure optgroup');
      expect(Array.from(engineering.children).map((o) => o.textContent))
        .toEqual(['Sotiyo (L-Set)', 'Raitaru (M-Set)']);
      expect(Array.from(refinery.children).map((o) => o.textContent))
        .toEqual(['Athanor (M-Set)']);
    });
  });

  describe('rigs are gated on the structure type', () => {
    async function openStructureForm() {
      await mountView();
      const select = document.getElementById('fac-type');
      select.value = 'structure';
      select.dispatchEvent(new window.Event('change'));
      await settle();
    }

    test('no rigs are offered before a structure is chosen', async () => {
      // The pool depends on the structure's type AND size, so offering the
      // full list first lets a user pick a rig that cannot be fitted.
      await openStructureForm();

      document.querySelector('#fac-rig1-host .qf-ss-trigger')
        .dispatchEvent(new window.MouseEvent('click'));
      await settle();

      const labels = Array.from(document.querySelectorAll('.qf-ss-row')).map((r) => r.textContent);
      expect(labels.filter((l) => l.includes('Standup'))).toHaveLength(0);
    });

    test('no rigs are fetched at mount', async () => {
      await mountView();

      // The unfiltered list IS loaded once, to name rigs on saved
      // facilities - but with no structure type argument.
      const scoped = calls.filter((c) => c.fn === 'getStructureRigs' && c.structureType);
      expect(scoped).toHaveLength(0);
    });

    test('choosing a structure fills the rig dropdowns', async () => {
      await openStructureForm();
      await pickStructure('Sotiyo');

      document.querySelector('#fac-rig1-host .qf-ss-trigger')
        .dispatchEvent(new window.MouseEvent('click'));
      await settle();

      const labels = Array.from(document.querySelectorAll('.qf-ss-row')).map((r) => r.textContent);
      expect(labels.some((l) => l.includes('L-Set Advanced Material Efficiency'))).toBe(true);
    });

    test('changing the structure clears rigs picked for the old one', async () => {
      await openStructureForm();
      await pickStructure('Sotiyo');
      await pickOption('fac-rig1-host', 'Standup L-Set Advanced Material Efficiency II');

      // Raitaru is medium, so the large rig cannot be fitted to it.
      await pickStructure('Raitaru');

      document.getElementById('fac-name').value = 'Test';
      await pickOption('fac-usage-host', 'Components');
      await pickOption('fac-region-host', 'The Forge');
      await pickOption('fac-system-host', 'Jita');
      document.getElementById('fac-form').dispatchEvent(new window.Event('submit'));
      await settle(30);

      expect(calls.find((c) => c.fn === 'addFacility').payload.rigs).toEqual([]);
    });

    test('switching back to NPC station clears the structure selections', async () => {
      await openStructureForm();
      await pickStructure('Sotiyo');
      await pickOption('fac-rig1-host', 'Standup L-Set Advanced Material Efficiency II');

      const select = document.getElementById('fac-type');
      select.value = 'station';
      select.dispatchEvent(new window.Event('change'));
      await settle();

      document.getElementById('fac-name').value = 'Test';
      await pickOption('fac-usage-host', 'Components');
      await pickOption('fac-region-host', 'The Forge');
      await pickOption('fac-system-host', 'Jita');
      document.getElementById('fac-form').dispatchEvent(new window.Event('submit'));
      await settle(30);

      // A station carries no structure fields at all.
      const { payload } = calls.find((c) => c.fn === 'addFacility');
      expect(payload.structureTypeId).toBeUndefined();
      expect(payload.rigs).toBeUndefined();
    });
  });

  test('shows the structure bonus panel using the real field names', async () => {
    // materialEfficiency / timeEfficiency / costReduction - NOT
    // materialBonus / timeBonus / costBonus.
    await selectSotiyo();

    const text = document.getElementById('fac-bonuses').textContent;
    expect(text).toContain('-1.0%');
    expect(text).toContain('-30.0%');
    expect(text).toContain('-5.0%');
  });

  test('a zero bonus is stated, not hidden', async () => {
    structureBonuses = { ...structureBonuses, costReduction: 0 };
    await selectSotiyo();

    const zero = document.querySelector('#fac-bonuses .fac-bonus.is-zero');
    expect(zero).not.toBeNull();
    expect(zero.textContent).toContain('0%');
  });

  test('rigs are refetched for the structure TYPE', async () => {
    // Stage one of the two-stage filter.
    await selectSotiyo();

    const call = calls.filter((c) => c.fn === 'getStructureRigs').pop();
    expect(call.structureType).toBe('engineering');
  });

  test('rigs are then filtered by the structure RIG SIZE', async () => {
    // Stage two. Without it the form offers rigs that cannot be fitted.
    await selectSotiyo();

    document.querySelector('#fac-rig1-host .qf-ss-trigger')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const labels = Array.from(document.querySelectorAll('.qf-ss-row')).map((r) => r.textContent);
    expect(labels.some((l) => l.includes('L-Set Advanced Material Efficiency'))).toBe(true);
    // The M-Set rig is the same structure type but the wrong SIZE.
    expect(labels.some((l) => l.includes('M-Set Basic Material Efficiency'))).toBe(false);
  });

  test('selecting a rig fetches its effects one id at a time', async () => {
    await selectSotiyo();
    await pickOption('fac-rig1-host', 'Standup L-Set Advanced Material Efficiency II');

    const call = calls.find((c) => c.fn === 'getRigEffects');
    expect(call.typeId).toBe('43931');
  });

  test('rig effects filter out fitting metadata', async () => {
    // Rig Size and Calibration Cost are on the type but are not bonuses.
    await selectSotiyo();
    await pickOption('fac-rig1-host', 'Standup L-Set Advanced Material Efficiency II');

    const text = document.getElementById('fac-rig-effects').textContent;
    expect(text).toContain('Manufacturing Material Bonus');
    expect(text).not.toContain('Rig Size');
    expect(text).not.toContain('Calibration');
  });

  test('the rig name comes from the rig list, not the effects payload', async () => {
    await selectSotiyo();
    await pickOption('fac-rig1-host', 'Standup L-Set Advanced Material Efficiency II');

    expect(document.querySelector('.fac-rig-name').textContent)
      .toBe('Standup L-Set Advanced Material Efficiency II');
  });
});

describe('saving', () => {
  async function fillStation(name) {
    await mountView();
    document.getElementById('fac-name').value = name;
    await pickOption('fac-usage-host', 'Components');
    await pickOption('fac-region-host', 'The Forge');
    await pickOption('fac-system-host', 'Jita');
  }

  test('submits a station with its resolved security status', async () => {
    // Security is derived from the chosen system and stored with the
    // facility; downstream job-cost maths reads it from there.
    await fillStation('Test Station');
    document.getElementById('fac-form').dispatchEvent(new window.Event('submit'));
    await settle(30);

    const call = calls.find((c) => c.fn === 'addFacility');
    expect(call.payload).toMatchObject({
      name: 'Test Station',
      usage: 'components',
      facilityType: 'station',
      systemId: '30000142',
    });
    expect(call.payload.securityStatus).toBeCloseTo(0.946);
  });

  test('a station sends no structure fields', async () => {
    await fillStation('Test Station');
    document.getElementById('fac-form').dispatchEvent(new window.Event('submit'));
    await settle(30);

    const { payload } = calls.find((c) => c.fn === 'addFacility');
    expect(payload.structureTypeId).toBeUndefined();
    expect(payload.rigs).toBeUndefined();
    expect(payload.facilityTax).toBeUndefined();
  });

  test('missing required fields are refused before any IPC', async () => {
    await mountView();
    document.getElementById('fac-form').dispatchEvent(new window.Event('submit'));
    await settle(20);

    expect(calls.some((c) => c.fn === 'addFacility')).toBe(false);
    expect(window.QFToast.show).toHaveBeenCalled();
  });

  test("main's rejection is surfaced verbatim", async () => {
    // The single-default and duplicate-name rules live in settings-manager
    // and THROW. Their messages name the conflicting facility, so the view
    // shows them rather than duplicating the rules.
    window.electronAPI.facilities.addFacility = async () => {
      throw new Error('Only one Default facility is allowed. "Forge Prime Assembly" is already set as the Default facility.');
    };
    allowErrors(/save failed/);

    await fillStation('Another Default');
    document.getElementById('fac-form').dispatchEvent(new window.Event('submit'));
    await settle(30);

    expect(window.QFToast.show).toHaveBeenCalledWith(
      expect.stringContaining('Only one Default facility'),
      'error'
    );
  });
});

describe('editing', () => {
  test('Edit scrolls the view, never the document', async () => {
    // element.scrollIntoView() walks EVERY ancestor scrolling box up to the
    // document. The shell parks inactive static views (the Dashboard) as
    // body-level siblings, so scrolling <body> drags them into sight below
    // the footer - which is exactly what editing a facility used to do.
    await mountView();

    // Spied AFTER mounting: mount() clones the template into a fresh
    // container, so anything stubbed on the pre-mount DOM is discarded.
    const scrollSpy = jest.fn();
    document.querySelector('#fac-view .fac-scroll').scrollTo = scrollSpy;
    // Fails the test if anything reaches for the ancestor-walking API.
    document.getElementById('fac-form-card').scrollIntoView = () => {
      throw new Error('scrollIntoView must not be used: it scrolls <body> too');
    };

    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(scrollSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(document.getElementById('fac-name').value).toBe('Forge Prime Assembly');
  });

  test('Edit loads the facility into the form', async () => {
    await mountView();
    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(document.getElementById('fac-name').value).toBe('Forge Prime Assembly');
    expect(document.getElementById('fac-type').value).toBe('structure');
    expect(document.getElementById('fac-tax').value).toBe('2.50');
  });

  test('Edit restores the saved region and system', async () => {
    await mountView();
    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    // f1 is in Jita (30000142), The Forge (10000002).
    expect(document.querySelector('#fac-region-host .qf-ss-trigger').textContent)
      .toContain('The Forge');
    expect(document.querySelector('#fac-system-host .qf-ss-trigger').textContent)
      .toContain('Jita');
  });

  test('Edit narrows the system list to the saved region', async () => {
    await mountView();
    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    document.querySelector('#fac-system-host .qf-ss-trigger')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const labels = Array.from(document.querySelectorAll('.qf-ss-row'))
      .map((r) => r.textContent);
    // The Forge holds Jita and Perimeter; Amarr and 1DQ1-A are elsewhere.
    expect(labels.some((l) => l.includes('Jita'))).toBe(true);
    expect(labels.some((l) => l.includes('Perimeter'))).toBe(true);
    expect(labels.some((l) => l.includes('Amarr'))).toBe(false);
    // A raw sde.getAllSystems() result would render every option as
    // "undefined (NaN)" because it carries solarSystemName, not systemName.
    expect(labels.some((l) => l.includes('undefined'))).toBe(false);
  });

  test('Edit builds the system list without a further SDE fetch', async () => {
    await mountView();
    const before = calls.filter((c) => c.fn === 'getAllSystems').length;

    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    // state.allSystems already holds every system, re-keyed. Refetching also
    // reintroduces the raw-casing bug, since the IPC ignores its argument.
    expect(calls.filter((c) => c.fn === 'getAllSystems').length).toBe(before);
  });

  test('an edit saves the same system it restored', async () => {
    await mountView();
    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    document.getElementById('fac-form').dispatchEvent(new window.Event('submit'));
    await settle(40);

    const [update] = calls.filter((c) => c.fn === 'updateFacility');
    expect(update.payload).toMatchObject({
      regionId: '10000002',
      systemId: '30000142',
      securityStatus: 0.946,
    });
  });

  test('editing is visually distinct from adding', async () => {
    await mountView();
    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(document.getElementById('fac-editing-badge').hidden).toBe(false);
    expect(document.getElementById('fac-submit').textContent).toBe('Save Facility');
    expect(document.getElementById('fac-form-card').classList.contains('is-editing')).toBe(true);
  });

  test('saving an edit updates rather than adds', async () => {
    await mountView();
    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    document.getElementById('fac-form').dispatchEvent(new window.Event('submit'));
    await settle(40);

    expect(calls.find((c) => c.fn === 'updateFacility').id).toBe('f1');
    expect(calls.some((c) => c.fn === 'addFacility')).toBe(false);
  });

  test('the saved rigs survive the structure rebuild', async () => {
    // handleStructureChange rebuilds the rig selects, so restoring the saved
    // rigs afterwards is what stops them coming back empty.
    await mountView();
    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    document.getElementById('fac-form').dispatchEvent(new window.Event('submit'));
    await settle(40);

    expect(calls.find((c) => c.fn === 'updateFacility').payload.rigs).toEqual(['43931']);
  });

  test('Cancel returns the form to Add', async () => {
    await mountView();
    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    document.getElementById('fac-clear').dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(document.getElementById('fac-editing-badge').hidden).toBe(true);
    expect(document.getElementById('fac-submit').textContent).toBe('Add Facility');
    expect(document.getElementById('fac-name').value).toBe('');
  });
});

describe('removing', () => {
  /** Click a card's trash button. */
  async function clickRemove(id) {
    document.querySelector(`[data-fac-remove="${id}"]`)
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
  }

  const confirmRemove = async () => {
    document.getElementById('fac-delete-ok').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);
  };

  test('the trash button opens a confirmation dialog', async () => {
    // The button used to arm itself for a second click, which gave no hint
    // that a second click was needed and so read as a dead button. Every
    // other destructive action in the app is a Cancel/Remove dialog.
    await mountView();

    await clickRemove('f1');

    expect(document.getElementById('fac-delete-modal').hidden).toBe(false);
    expect(document.getElementById('fac-delete-text').textContent)
      .toContain('Forge Prime Assembly');
    // Nothing is deleted just by asking.
    expect(calls.some((c) => c.fn === 'removeFacility')).toBe(false);
  });

  test('confirming removes the facility', async () => {
    await mountView();

    await clickRemove('f1');
    await confirmRemove();

    expect(calls.find((c) => c.fn === 'removeFacility').id).toBe('f1');
    expect(document.getElementById('fac-delete-modal').hidden).toBe(true);
  });

  test('cancelling removes nothing', async () => {
    await mountView();

    await clickRemove('f1');
    document.getElementById('fac-delete-cancel')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.some((c) => c.fn === 'removeFacility')).toBe(false);
    expect(document.getElementById('fac-delete-modal').hidden).toBe(true);
  });

  test('Escape closes the dialog without removing', async () => {
    await mountView();

    await clickRemove('f1');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await settle(30);

    expect(calls.some((c) => c.fn === 'removeFacility')).toBe(false);
    expect(document.getElementById('fac-delete-modal').hidden).toBe(true);
  });

  test('a cancelled dialog does not leave the facility pending', async () => {
    // Reopening for a DIFFERENT card must not delete the earlier one.
    await mountView();

    await clickRemove('f1');
    document.getElementById('fac-delete-cancel')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    await clickRemove('f2');
    await confirmRemove();

    const removed = calls.filter((c) => c.fn === 'removeFacility');
    expect(removed).toHaveLength(1);
    expect(removed[0].id).toBe('f2');
  });

  test('removing the facility being edited clears the form', async () => {
    // Otherwise the form points at something that no longer exists.
    await mountView();
    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    await clickRemove('f1');
    await confirmRemove();

    expect(document.getElementById('fac-name').value).toBe('');
    expect(document.getElementById('fac-editing-badge').hidden).toBe(true);
  });
});

describe('lifecycle', () => {
  test('unmount destroys the dropdowns', async () => {
    // Each QFSearchSelect owns a document listener and can attach a popover
    // to <body>, so removing the container is not enough.
    const { instance } = await mountView();
    instance.destroy();

    expect(document.querySelectorAll('.qf-ss-popover')).toHaveLength(0);
  });

  test('remounting leaves one dropdown per host', async () => {
    const first = await mountView();
    first.instance.destroy();
    first.container.remove();

    await mountView();

    expect(document.querySelectorAll('#fac-usage-host .qf-ss-trigger')).toHaveLength(1);
  });
});

describe('resilience', () => {
  test('a failed facility load still renders the form', async () => {
    window.electronAPI.facilities.getFacilities = async () => { throw new Error('db gone'); };
    allowErrors(/facilities/);

    await mountView();

    expect(document.getElementById('fac-form')).not.toBeNull();
    expect(document.getElementById('fac-count').textContent).toBe('0');
  });

  test('a failed region load still renders the list', async () => {
    window.electronAPI.facilities.getAllRegions = async () => { throw new Error('no sde'); };
    allowErrors(/regions/);

    await mountView();

    expect(document.querySelectorAll('#fac-list .fac-facility')).toHaveLength(2);
  });
});

/* ======================================================= import: scanner */

/** Paste a scan and click Apply. */
async function applyScan(text) {
  document.getElementById('fac-import-scan')
    .dispatchEvent(new window.MouseEvent('click'));
  await settle();
  document.getElementById('fac-scan-input').value = text;
  document.getElementById('fac-scan-apply')
    .dispatchEvent(new window.MouseEvent('click'));
  await settle(40);
}

function scanSummaryText() {
  return document.getElementById('fac-scan-summary').textContent;
}

/** The label each rig combobox is currently showing. */
function rigTriggerLabels() {
  return [1, 2, 3].map((i) =>
    document.querySelector(`#fac-rig${i}-host .qf-ss-trigger`).textContent.trim()
  );
}

describe('import: ship scanner', () => {
  const M_RIG = 'Standup M-Set Basic Material Efficiency I';
  const L_RIG = 'Standup L-Set Advanced Material Efficiency II';

  test('applies the scanned rigs to the form', async () => {
    await mountView();
    await pickStructure('Raitaru');            // M-Set, engineering

    await applyScan(`Rig Slots\n${M_RIG}`);

    expect(document.getElementById('fac-scan-modal').hidden).toBe(true);
    expect(rigTriggerLabels()[0]).toBe(M_RIG);
  });

  test('reports the modules it could not use', async () => {
    await mountView();
    await pickStructure('Raitaru');

    await applyScan([
      'High Power Slots',
      'Standup Multirole Missile Launcher I',
      'Rig Slots',
      M_RIG,
      'Service Slots',
      'Standup Manufacturing Plant I',
    ].join('\n'));

    const [message] = window.QFToast.show.mock.calls.at(-1);
    expect(message).toMatch(/Applied 1 rig/);
    // Services are parsed and named, but the model has nowhere to put them.
    expect(message).toMatch(/Standup Manufacturing Plant I/);
    expect(message).toMatch(/2 non-rig modules ignored/);
  });

  test('drops a rig that does not fit the chosen structure', async () => {
    await mountView();
    await pickStructure('Raitaru');            // rigSize 2, so an L-Set cannot fit

    await applyScan(`Rig Slots\n${L_RIG}\n${M_RIG}`);

    expect(rigTriggerLabels()[0]).toBe(M_RIG);
    expect(rigTriggerLabels()).not.toContain(L_RIG);
    expect(window.QFToast.show.mock.calls.at(-1)[0]).toMatch(/does not fit/);
  });

  test('never sends more than three rigs to the form', async () => {
    await mountView();
    await pickStructure('Raitaru');

    // Four M-Set lines: the fourth has no slot to go in.
    await applyScan(`Rig Slots\n${M_RIG}\n${M_RIG}\n${M_RIG}\n${M_RIG}`);

    expect(window.QFToast.show.mock.calls.at(-1)[0]).toMatch(/more than three rigs/);
    expect(rigTriggerLabels().filter((l) => l === M_RIG)).toHaveLength(3);
  });

  test('infers an unambiguous structure when the form has none', async () => {
    await mountView();

    // A refinery M-Set rig can only be an Athanor in this fixture.
    await applyScan('Rig Slots\nStandup M-Set Basic Reprocessing I');

    expect(document.getElementById('fac-type').value).toBe('structure');
    expect(document.getElementById('fac-structure').value).toBe('35835');
    expect(rigTriggerLabels()[0]).toBe('Standup M-Set Basic Reprocessing I');
    // Selecting the hull but dropping its rig is a silent half-success, so
    // assert the modal actually closed rather than warning behind the scenes.
    expect(document.getElementById('fac-scan-modal').hidden).toBe(true);
  });

  test('asks for a structure when the rigs do not identify one', async () => {
    await mountView();

    // M-Set and L-Set engineering together match no single hull.
    await applyScan(`Rig Slots\n${M_RIG}\n${L_RIG}`);

    expect(document.getElementById('fac-scan-modal').hidden).toBe(false);
    expect(scanSummaryText()).toMatch(/Select a structure type/i);
  });

  test('rejects text that is not a scan', async () => {
    await mountView();
    await pickStructure('Raitaru');

    await applyScan('just some text I copied');

    expect(document.getElementById('fac-scan-modal').hidden).toBe(false);
    expect(scanSummaryText()).toMatch(/No slot headings/i);
  });

  test('reports a rig name the SDE does not know', async () => {
    await mountView();
    await pickStructure('Raitaru');

    await applyScan('Rig Slots\nStandup M-Set Nonexistent Rig X');

    expect(document.getElementById('fac-scan-modal').hidden).toBe(false);
    expect(scanSummaryText()).toMatch(/not found/i);
  });

  test('Escape closes the scanner modal', async () => {
    await mountView();
    document.getElementById('fac-import-scan')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();

    expect(document.getElementById('fac-scan-modal').hidden).toBe(true);
  });
});

/* ====================================================== import: ravworks */

/** A Ravworks export shaped like the real one, over the fixture's SDE data. */
function ravExport(structures, systems) {
  return JSON.stringify({
    manu_system: (systems && systems.manu) || 'Jita',
    react_system: (systems && systems.react) || 'Amarr',
    inv_system: (systems && systems.inv) || 'Jita',
    hidden_my_structures: structures.map((s, i) => ({
      id: s.id || `Structure ${i + 1}`,
      name: s.name,
      structure: s.structure,
      security: 'Null / Wormhole',
      Rig1: s.rigs && s.rigs[0] ? s.rigs[0] : 'No Rig',
      Rig2: s.rigs && s.rigs[1] ? s.rigs[1] : 'No Rig',
      Rig3: s.rigs && s.rigs[2] ? s.rigs[2] : 'No Rig',
    })),
  });
}

/** Drive the hidden file input the way a file picker would. */
async function importRav(json) {
  const input = document.getElementById('fac-rav-file');
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [{ text: async () => json }],
  });
  input.dispatchEvent(new window.Event('change'));
  await settle(60);
}

function ravRowEls() {
  return Array.from(document.querySelectorAll('#fac-rav-rows .fac-rav-row'));
}

function rowStatusText(tr) {
  return tr.querySelector('[data-rav-status]').textContent;
}

/** Pick from a preview row's own combobox, which has no stable id. */
async function pickRowOption(tr, hostClass, label) {
  tr.querySelector(`.${hostClass} .qf-ss-trigger`)
    .dispatchEvent(new window.MouseEvent('click'));
  await settle();
  const row = Array.from(document.querySelectorAll('.qf-ss-row'))
    .find((r) => r.textContent.includes(label));
  if (!row) throw new Error(`No option matching "${label}"`);
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(30);
}

const setUsage = (tr, label) => pickRowOption(tr, 'fac-rav-usage-host', label);

describe('import: ravworks', () => {
  test('lists a preview row per structure', async () => {
    await mountView();

    await importRav(ravExport([
      { name: 'Alpha', structure: 'Raitaru' },
      { name: 'Beta', structure: 'Athanor' },
    ]));

    expect(document.getElementById('fac-rav-modal').hidden).toBe(false);
    expect(ravRowEls()).toHaveLength(2);
  });

  test('defaults the system from what the hull is for', async () => {
    await mountView();

    await importRav(ravExport(
      [{ name: 'Alpha', structure: 'Raitaru' }, { name: 'Beta', structure: 'Athanor' }],
      { manu: 'Jita', react: 'Amarr', inv: 'Jita' }
    ));

    const [engineering, refinery] = ravRowEls();
    // An engineering complex manufactures; a refinery reacts.
    expect(engineering.querySelector('.fac-rav-system-host').textContent).toMatch(/Jita/);
    expect(refinery.querySelector('.fac-rav-system-host').textContent).toMatch(/Amarr/);
  });

  test('blocks a row whose hull is not in the SDE', async () => {
    await mountView();

    await importRav(ravExport([{ name: 'Alpha', structure: 'Fortizar' }]));

    const [tr] = ravRowEls();
    expect(tr.querySelector('[data-rav-check]').disabled).toBe(true);
    expect(rowStatusText(tr)).toMatch(/Unknown structure "Fortizar"/);
  });

  test('blocks a row until a usage is chosen', async () => {
    await mountView();

    await importRav(ravExport([{ name: 'Alpha', structure: 'Raitaru' }]));
    const [tr] = ravRowEls();
    expect(rowStatusText(tr)).toMatch(/Select a usage/);

    await setUsage(tr, 'Components');

    expect(tr.querySelector('[data-rav-check]').disabled).toBe(false);
    expect(document.getElementById('fac-rav-confirm').textContent)
      .toMatch(/Import 1 Facility/);
  });

  test('blocks a name that collides with an existing facility', async () => {
    await mountView();

    // Differs from the saved 'Forge Prime Assembly' only by case.
    await importRav(ravExport([{ name: 'forge prime assembly', structure: 'Raitaru' }]));
    const [tr] = ravRowEls();
    await setUsage(tr, 'Components');

    expect(rowStatusText(tr)).toMatch(/already exists/);
    expect(tr.querySelector('[data-rav-check]').disabled).toBe(true);
  });

  test('clears the collision when the name is edited', async () => {
    await mountView();

    await importRav(ravExport([{ name: 'Forge Prime Assembly', structure: 'Raitaru' }]));
    const [tr] = ravRowEls();
    await setUsage(tr, 'Components');

    const input = tr.querySelector('.fac-rav-name');
    input.value = 'Forge Prime Assembly II';
    input.dispatchEvent(new window.Event('input'));
    await settle();

    expect(tr.querySelector('[data-rav-check]').disabled).toBe(false);
  });

  test('blocks two rows claiming the same name', async () => {
    await mountView();

    await importRav(ravExport([
      { name: 'Twin', structure: 'Raitaru' },
      { name: 'Twin', structure: 'Athanor' },
    ]));
    const rows = ravRowEls();
    await setUsage(rows[0], 'Components');
    await setUsage(rows[1], 'Reactions');

    expect(rowStatusText(rows[1])).toMatch(/Duplicate name in this import/);
    expect(rows[1].querySelector('[data-rav-check]').disabled).toBe(true);
  });

  test('still catches a duplicate after an unrelated problem is fixed', async () => {
    await mountView();

    // Both rows start blocked on "no usage". Fixing that must not also
    // clear the duplicate-name conflict between them: a row's blocked state
    // and the user's intent to import it are different things, and gating
    // the cross-row checks on the former made this pair import cleanly.
    await importRav(ravExport([
      { name: 'Twin', structure: 'Raitaru' },
      { name: 'Twin', structure: 'Athanor' },
    ]));
    const rows = ravRowEls();
    expect(rowStatusText(rows[1])).toMatch(/Select a usage/);

    await setUsage(rows[0], 'Components');
    await setUsage(rows[1], 'Reactions');

    expect(rowStatusText(rows[1])).toMatch(/Duplicate name in this import/);
    expect(rows[1].querySelector('[data-rav-check]').disabled).toBe(true);
  });

  test('re-blocks a row when a fixed conflict is reintroduced', async () => {
    await mountView();

    await importRav(ravExport([
      { name: 'Alpha', structure: 'Raitaru' },
      { name: 'Beta', structure: 'Athanor' },
    ]));
    const rows = ravRowEls();
    await setUsage(rows[0], 'Components');
    await setUsage(rows[1], 'Reactions');
    expect(rows[1].querySelector('[data-rav-check]').disabled).toBe(false);

    const input = rows[1].querySelector('.fac-rav-name');
    input.value = 'Alpha';
    input.dispatchEvent(new window.Event('input'));
    await settle();

    expect(rowStatusText(rows[1])).toMatch(/Duplicate name in this import/);
    expect(rows[1].querySelector('[data-rav-check]').disabled).toBe(true);
  });

  test('blocks a second Default when one already exists', async () => {
    await mountView();

    // The fixture's 'Forge Prime Assembly' is already usage: 'default'.
    await importRav(ravExport([{ name: 'Alpha', structure: 'Raitaru' }]));
    const [tr] = ravRowEls();
    await setUsage(tr, 'Default');

    expect(rowStatusText(tr)).toMatch(/Default facility already exists/);
  });

  test('blocks two rows both claiming Default', async () => {
    facilities = facilities.filter((f) => f.usage !== 'default');
    await mountView();

    await importRav(ravExport([
      { name: 'Alpha', structure: 'Raitaru' },
      { name: 'Beta', structure: 'Athanor' },
    ]));
    const rows = ravRowEls();
    await setUsage(rows[0], 'Default');
    await setUsage(rows[1], 'Default');

    expect(rowStatusText(rows[1])).toMatch(/Another row is already the Default/);
    expect(rows[0].querySelector('[data-rav-check]').disabled).toBe(false);
  });

  test('marks a rig that cannot fit the hull without blocking the row', async () => {
    await mountView();

    await importRav(ravExport([{
      name: 'Alpha',
      structure: 'Raitaru',                                    // rigSize 2
      rigs: ['Standup L-Set Advanced Material Efficiency II'], // rigSize 3
    }]));
    const [tr] = ravRowEls();
    await setUsage(tr, 'Components');

    expect(tr.querySelector('.fac-rav-rig.is-invalid')).not.toBeNull();
    // A bad rig costs the rig, not the facility.
    expect(tr.querySelector('[data-rav-check]').disabled).toBe(false);
    expect(rowStatusText(tr)).toMatch(/does not fit/);
  });

  test('saves one facility per checked row, with the resolved ids', async () => {
    await mountView();

    await importRav(ravExport(
      [{
        name: 'Alpha',
        structure: 'Raitaru',
        rigs: ['Standup M-Set Basic Material Efficiency I'],
      }],
      { manu: 'Jita' }
    ));
    const [tr] = ravRowEls();
    await setUsage(tr, 'Components');

    document.getElementById('fac-rav-confirm')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(60);

    const added = calls.filter((c) => c.fn === 'addFacility');
    expect(added).toHaveLength(1);
    expect(added[0].payload).toEqual({
      usage: 'components',
      name: 'Alpha',
      facilityType: 'structure',
      regionId: '10000002',
      systemId: '30000142',
      // From the SDE system, not Ravworks' coarse "Null / Wormhole" band.
      securityStatus: 0.946,
      structureTypeId: '35825',
      rigs: ['43920'],
    });
    expect(document.getElementById('fac-rav-modal').hidden).toBe(true);
  });

  test('omits an unchecked row', async () => {
    await mountView();

    await importRav(ravExport([
      { name: 'Alpha', structure: 'Raitaru' },
      { name: 'Beta', structure: 'Athanor' },
    ]));
    const rows = ravRowEls();
    await setUsage(rows[0], 'Components');
    await setUsage(rows[1], 'Reactions');

    const check = rows[1].querySelector('[data-rav-check]');
    check.checked = false;
    check.dispatchEvent(new window.Event('change'));
    await settle();

    document.getElementById('fac-rav-confirm')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(60);

    const added = calls.filter((c) => c.fn === 'addFacility');
    expect(added).toHaveLength(1);
    expect(added[0].payload.name).toBe('Alpha');
  });

  test('one rejected row does not abort the rest of the batch', async () => {
    await mountView();
    window.electronAPI.facilities.addFacility = async (payload) => {
      calls.push({ fn: 'addFacility', payload });
      if (payload.name === 'Alpha') throw new Error('A facility named "Alpha" exists.');
      return { id: 'new' };
    };
    allowErrors(/ravworks import row failed/);

    await importRav(ravExport([
      { name: 'Alpha', structure: 'Raitaru' },
      { name: 'Beta', structure: 'Athanor' },
    ]));
    const rows = ravRowEls();
    await setUsage(rows[0], 'Components');
    await setUsage(rows[1], 'Reactions');

    document.getElementById('fac-rav-confirm')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(60);

    expect(calls.filter((c) => c.fn === 'addFacility')).toHaveLength(2);
    const [message] = window.QFToast.show.mock.calls.at(-1);
    expect(message).toMatch(/Imported 1 facility/);
    // settings-manager's message names the conflict, so it is kept verbatim.
    expect(message).toMatch(/A facility named "Alpha" exists\./);
  });

  test('reloads the facility list after importing', async () => {
    await mountView();
    const before = calls.filter((c) => c.fn === 'getFacilities').length;

    await importRav(ravExport([{ name: 'Alpha', structure: 'Raitaru' }]));
    await setUsage(ravRowEls()[0], 'Components');
    document.getElementById('fac-rav-confirm')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(60);

    expect(calls.filter((c) => c.fn === 'getFacilities').length).toBeGreaterThan(before);
  });

  test('rejects a file that is not a Ravworks export', async () => {
    await mountView();

    await importRav(JSON.stringify({ something: 'else' }));

    expect(document.getElementById('fac-rav-modal').hidden).toBe(true);
    expect(window.QFToast.show.mock.calls.at(-1)[0]).toMatch(/not a Ravworks export/i);
  });

  test('select-all skips rows that are blocked', async () => {
    await mountView();

    await importRav(ravExport([
      { name: 'Alpha', structure: 'Raitaru' },
      { name: 'Bad', structure: 'Fortizar' },
    ]));
    const rows = ravRowEls();
    await setUsage(rows[0], 'Components');

    const all = document.getElementById('fac-rav-all');
    all.checked = true;
    all.dispatchEvent(new window.Event('change'));
    await settle();

    expect(rows[0].querySelector('[data-rav-check]').checked).toBe(true);
    expect(rows[1].querySelector('[data-rav-check]').checked).toBe(false);
  });

  test('reuses one bonus lookup for repeated hulls', async () => {
    await mountView();
    const before = calls.filter((c) => c.fn === 'getStructureBonuses').length;

    await importRav(ravExport([
      { name: 'A', structure: 'Raitaru' },
      { name: 'B', structure: 'Raitaru' },
      { name: 'C', structure: 'Raitaru' },
    ]));

    const added = calls.filter((c) => c.fn === 'getStructureBonuses').length - before;
    expect(added).toBeLessThanOrEqual(1);
  });

  describe('lifecycle', () => {
    test('closing the modal destroys only the preview selects', async () => {
      await mountView();
      await importRav(ravExport([{ name: 'Alpha', structure: 'Raitaru' }]));
      expect(document.querySelectorAll('#fac-rav-rows .qf-ss-trigger').length)
        .toBeGreaterThan(0);

      document.getElementById('fac-rav-cancel')
        .dispatchEvent(new window.MouseEvent('click'));
      await settle();

      expect(document.querySelectorAll('#fac-rav-rows .qf-ss-trigger')).toHaveLength(0);
      // The form's own dropdowns must survive.
      expect(document.querySelectorAll('#fac-usage-host .qf-ss-trigger')).toHaveLength(1);
    });

    test('Escape closes the preview', async () => {
      await mountView();
      await importRav(ravExport([{ name: 'Alpha', structure: 'Raitaru' }]));

      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      await settle();

      expect(document.getElementById('fac-rav-modal').hidden).toBe(true);
    });

    test('the same file can be picked twice in a row', async () => {
      await mountView();
      const json = ravExport([{ name: 'Alpha', structure: 'Raitaru' }]);

      await importRav(json);
      document.getElementById('fac-rav-cancel')
        .dispatchEvent(new window.MouseEvent('click'));
      await settle();
      // A file input that keeps its value fires no change event next time.
      expect(document.getElementById('fac-rav-file').value).toBe('');

      await importRav(json);
      expect(ravRowEls()).toHaveLength(1);
    });

    test('unmounting with the preview open leaves no live selects', async () => {
      const { instance, container } = await mountView();
      await importRav(ravExport([{ name: 'Alpha', structure: 'Raitaru' }]));

      instance.destroy();
      container.remove();

      expect(document.querySelectorAll('.qf-ss-popover')).toHaveLength(0);
    });
  });
});
