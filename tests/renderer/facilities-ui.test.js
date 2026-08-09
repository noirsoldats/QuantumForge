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

// Record every timer the renderer sets. Without this, the two-step delete's
// 4s arm timer keeps the Jest worker alive after the suite finishes.
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

  bonusesByType = {
    35825: {
      structureName: 'Raitaru',
      structureType: 'engineering',
      rigSize: 2,
      materialEfficiency: 1.0,
      timeEfficiency: 15.0,
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
  // Most tests never unmount, so any timer the view scheduled (the two-step
  // delete arms one for 4s) would otherwise keep the worker alive after the
  // suite finishes - which reads as a hang, not a failure.
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
      const btn = document.querySelector('[data-fac-remove="f2"]');
      btn.dispatchEvent(new window.MouseEvent('click'));
      await settle(20);
      btn.dispatchEvent(new window.MouseEvent('click'));
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
  test('Edit loads the facility into the form', async () => {
    await mountView();
    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(document.getElementById('fac-name').value).toBe('Forge Prime Assembly');
    expect(document.getElementById('fac-type').value).toBe('structure');
    expect(document.getElementById('fac-tax').value).toBe('2.50');
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
  test('the first click arms rather than deletes', async () => {
    // A native confirm() blocks the whole renderer, which under the shell
    // freezes every view in the window.
    await mountView();
    const btn = document.querySelector('[data-fac-remove="f1"]');

    btn.dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(calls.some((c) => c.fn === 'removeFacility')).toBe(false);
    expect(btn.classList.contains('is-armed')).toBe(true);
  });

  test('a second click removes', async () => {
    await mountView();
    const btn = document.querySelector('[data-fac-remove="f1"]');

    btn.dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    btn.dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(calls.find((c) => c.fn === 'removeFacility').id).toBe('f1');
  });

  test('removing the facility being edited clears the form', async () => {
    // Otherwise the form points at something that no longer exists.
    await mountView();
    document.querySelector('[data-fac-edit="f1"]').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    const btn = document.querySelector('[data-fac-remove="f1"]');
    btn.dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    btn.dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

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
