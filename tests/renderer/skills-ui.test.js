/**
 * @jest-environment jsdom
 *
 * Skills Manager shell view.
 *
 * The override behaviour is the reason this screen exists, so it is what these
 * tests weight most heavily. The rules carried over from the live screen:
 *
 *   - clicking the ACTUAL trained level CLEARS the override rather than storing
 *     a redundant one - it is the only way back to "no override" from the UI
 *   - the trained level stays marked while an override is in effect, so you can
 *     always see what you really have
 *   - Trained and Untrained filters are mutually exclusive
 *   - "Overridden" is exclusive: when on, ONLY overridden skills show
 *
 * Fixtures use REAL shapes:
 *   - getCharacter -> { skills: { totalSp, skills: { [id]: { skillId,
 *     trainedSkillLevel, skillpointsInSkill } } }, skillOverrides: { [id]: n } }
 *     NOTE skills is a MAP keyed by skill id, not an array.
 *   - sde.getSkillInfo -> { [id]: { name, groupId, groupName, rank } }
 *
 * console.error is captured and any unexpected entry FAILS the test.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/skills.view.html'),
  'utf8'
);
const VIEW_CSS = fs.readFileSync(
  path.join(__dirname, '../../public/skills-view.css'),
  'utf8'
);

/* --------------------------------------------------------------- fixtures */

let character;
let skillInfo;
let cacheStatus;
let setOverrideResult;
let clearOverridesResult;
let fetchResult;
let calls;
let consoleErrors = [];
let expectedErrorPatterns = [];
let registered;
let subscribers;

function allowErrors(...patterns) {
  expectedErrorPatterns.push(...patterns);
}

function subscribe(channel, cb) {
  if (!subscribers[channel]) subscribers[channel] = [];
  subscribers[channel].push(cb);
  return () => {
    subscribers[channel] = subscribers[channel].filter((c) => c !== cb);
  };
}

/** Build the cached character record in its real shape. */
function makeCharacter(skills, overrides = {}) {
  const map = {};
  skills.forEach((s) => {
    map[s.skillId] = {
      skillId: s.skillId,
      trainedSkillLevel: s.trained,
      activeSkillLevel: s.trained,
      skillpointsInSkill: s.sp || 0,
    };
  });
  return {
    characterId: 91316135,
    characterName: 'Buckwalter',
    portrait: 'https://images.evetech.net/characters/91316135/portrait',
    skills: { totalSp: 84200000, skills: map },
    skillOverrides: overrides,
  };
}

function makeApi() {
  return {
    esi: {
      getCharacter: async (id) => {
        calls.push({ fn: 'esi.getCharacter', id });
        return character;
      },
      getDefaultCharacter: async () => character,
    },
    skills: {
      fetch: async (id) => {
        calls.push({ fn: 'skills.fetch', id });
        return fetchResult;
      },
      setOverride: async (id, skillId, level) => {
        calls.push({ fn: 'skills.setOverride', id, skillId, level });
        return setOverrideResult;
      },
      clearOverrides: async (id) => {
        calls.push({ fn: 'skills.clearOverrides', id });
        return clearOverridesResult;
      },
      getCacheStatus: async (id) => {
        calls.push({ fn: 'skills.getCacheStatus', id });
        return cacheStatus;
      },
    },
    sde: {
      getSkillInfo: async (ids) => {
        calls.push({ fn: 'sde.getSkillInfo', count: ids.length });
        return skillInfo;
      },
      // Present so a fallback to the name-only call would be observable.
      getSkillNames: async (ids) => {
        calls.push({ fn: 'sde.getSkillNames', count: ids.length });
        return {};
      },
    },
    data: {
      onChanged: (cb) => subscribe('esi:data-changed', cb),
      onCycleComplete: (cb) => subscribe('esi:cycle-complete', cb),
    },
  };
}

/* ---------------------------------------------------------------- harness */

function loadRenderer() {
  jest.isolateModules(() => {
    require('../../src/renderer/skills-view-renderer.js');
  });
}

function makeCtx() {
  const tracked = [];
  return {
    tracked,
    ctx: {
      on: (target, type, handler) => target && target.addEventListener(type, handler),
      track: (fn) => { tracked.push(fn); return fn; },
      setInterval: () => 0,
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

function skillRows(container) {
  return [...container.querySelectorAll('.sk-row')];
}

function rowFor(container, name) {
  return skillRows(container).find(
    (r) => r.querySelector('.sk-row-name').textContent === name
  );
}

/** The six 0-5 pips on a row. */
function pipsFor(container, name) {
  return [...rowFor(container, name).querySelectorAll('.sk-level')];
}

function groupCards(container) {
  return [...container.querySelectorAll('.sk-group')];
}

beforeEach(() => {
  consoleErrors = [];
  expectedErrorPatterns = [];
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(
      args
        .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : ''))
        .filter(Boolean)
        .join(' ')
    );
  });

  calls = [];
  subscribers = {};

  character = makeCharacter([
    { skillId: 3380, trained: 5, sp: 256000 },   // Industry
    { skillId: 3388, trained: 4, sp: 452000 },   // Advanced Industry
    { skillId: 3402, trained: 5, sp: 256000 },   // Science
    { skillId: 3403, trained: 0, sp: 0 },        // Research (untrained)
    { skillId: 3392, trained: 3, sp: 90000 },    // Accounting
  ]);

  skillInfo = {
    3380: { name: 'Industry', groupId: 268, groupName: 'Production', rank: 1 },
    3388: { name: 'Advanced Industry', groupId: 268, groupName: 'Production', rank: 3 },
    3402: { name: 'Science', groupId: 270, groupName: 'Science', rank: 1 },
    3403: { name: 'Research', groupId: 270, groupName: 'Science', rank: 5 },
    3392: { name: 'Accounting', groupId: 274, groupName: 'Trade', rank: 3 },
  };

  cacheStatus = { isCached: false, expiresAt: null, remainingSeconds: 0 };
  setOverrideResult = true;
  clearOverridesResult = true;
  fetchResult = { success: true };

  registered = null;
  window.QFShell = {
    router: {
      register: (id, def) => { registered = { id, def }; },
      show: (id, params) => calls.push({ fn: 'router.show', id, params }),
    },
  };
  window.electronAPI = makeApi();
  // The REAL QFToast API: a single show(message, type). There are no per-type
  // methods - inventing them here let a silent TypeError in the renderer
  // (QFToast.info(...)) pass every test while no toast ever appeared.
  window.QFToast = {
    show: (m, type = 'info') => calls.push({ fn: `toast.${type}`, m }),
    setDefaultPosition: () => {},
    dismissAll: () => {},
  };
  // The countdown is exercised in its own suite; stub it so this one is not
  // driving timers.
  window.QFCacheCountdown = {
    attach: () => () => {},
    formatRemaining: () => '',
    setLabel: () => {},
  };

  global.fetch = jest.fn(async () => ({ text: async () => VIEW_HTML }));

  document.body.innerHTML = '';
  loadRenderer();
});

afterEach(() => {
  const unexpected = consoleErrors.filter(
    (e) => !expectedErrorPatterns.some((p) => e.includes(p))
  );
  expect(unexpected).toEqual([]);
  jest.restoreAllMocks();
  delete global.fetch;
});

/* ------------------------------------------------------------------ tests */

describe('registration', () => {
  test('registers itself as the "skills" view', () => {
    expect(registered).not.toBeNull();
    expect(registered.id).toBe('skills');
    expect(typeof registered.def.mount).toBe('function');
  });
});

describe('loading', () => {
  test('reads skills from the CACHED character record, never ESI', async () => {
    await mountView({ characterId: 91316135 });

    expect(calls.some((c) => c.fn === 'esi.getCharacter')).toBe(true);
    // Opening the screen must not trigger a fetch.
    expect(calls.some((c) => c.fn === 'skills.fetch')).toBe(false);
  });

  test('resolves names, groups and ranks in ONE batched call', async () => {
    // A character has 300-500 skills; a per-skill lookup is the pattern that
    // made the Assets screen unusable.
    await mountView({ characterId: 91316135 });

    const info = calls.filter((c) => c.fn === 'sde.getSkillInfo');
    expect(info).toHaveLength(1);
    expect(info[0].count).toBe(5);
  });

  test('renders a row per skill with its level, SP and rank', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const row = rowFor(container, 'Advanced Industry');
    expect(row.textContent).toContain('Trained Level 4');
    expect(row.textContent).toContain('452,000');
    expect(row.textContent).toContain('rank x3');
  });

  test('groups skills by their SDE skill group', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const names = groupCards(container).map((g) =>
      g.querySelector('.sk-group-name').textContent);
    expect(names).toContain('Production');
    expect(names).toContain('Science');
  });

  test('a group header counts trained vs total', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const production = groupCards(container).find(
      (g) => g.querySelector('.sk-group-name').textContent === 'Production'
    );
    expect(production.querySelector('.sk-group-trained').textContent).toBe('2/2 trained');
  });

  test('a group collapses and expands', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    const before = skillRows(container).length;

    groupCards(container)[0].querySelector('.sk-group-head').click();
    expect(skillRows(container).length).toBeLessThan(before);

    groupCards(container)[0].querySelector('.sk-group-head').click();
    expect(skillRows(container)).toHaveLength(before);
  });

  test('a skill missing from the SDE still renders, with a fallback name', async () => {
    skillInfo = {}; // SDE returned nothing for these ids

    const { container } = await mountView({ characterId: 91316135 });

    expect(skillRows(container).length).toBeGreaterThan(0);
    expect(container.textContent).toContain('Skill 3380');
  });

  test('an SDE failure degrades to ids rather than an empty screen', async () => {
    allowErrors('Could not load skill info');
    window.electronAPI.sde.getSkillInfo = async () => {
      throw new Error('SDE database not found. Please download it first.');
    };

    const { container } = await mountView({ characterId: 91316135 });

    // 4 of the 5 fixture skills, because Research is untrained and the default
    // filter is Trained-only - the same count a healthy SDE would show. The
    // point is that the rows survive with id fallbacks instead of the screen
    // going blank.
    expect(skillRows(container)).toHaveLength(4);
    expect(container.querySelector('#sk-empty').hidden).toBe(true);
    expect(container.textContent).toContain('Skill 3380');
  });

  test('a character with no skills shows the "not loaded" empty state', async () => {
    character = { ...character, skills: { totalSp: 0, skills: {} } };

    const { container } = await mountView({ characterId: 91316135 });

    expect(container.querySelector('#sk-empty').hidden).toBe(false);
    expect(container.querySelector('#sk-empty-title').textContent).toBe('No skills loaded');
  });
});

describe('overrides', () => {
  test('clicking a level above the trained one sets an override', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    pipsFor(container, 'Advanced Industry')[5].click();
    await settle();

    const call = calls.find((c) => c.fn === 'skills.setOverride');
    expect(call).toMatchObject({ skillId: 3388, level: 5 });
  });

  test('clicking the ACTUAL trained level CLEARS the override', async () => {
    // The only way back to "no override" from the UI - storing a redundant
    // override instead would leave the skill permanently marked.
    character = makeCharacter(
      [{ skillId: 3388, trained: 4, sp: 452000 }],
      { 3388: 5 }
    );

    const { container } = await mountView({ characterId: 91316135 });

    pipsFor(container, 'Advanced Industry')[4].click();
    await settle();

    const call = calls.find((c) => c.fn === 'skills.setOverride');
    expect(call.level).toBeNull();
  });

  test('an overridden skill shows a badge with the effective level', async () => {
    character = makeCharacter(
      [{ skillId: 3388, trained: 4, sp: 452000 }],
      { 3388: 5 }
    );

    const { container } = await mountView({ characterId: 91316135 });

    const badge = rowFor(container, 'Advanced Industry').querySelector('.sk-override-badge');
    expect(badge.textContent).toBe('Override 5');
  });

  test('the trained level stays marked while an override is in effect', async () => {
    // Losing sight of what you actually have would make the screen misleading.
    character = makeCharacter(
      [{ skillId: 3388, trained: 4, sp: 452000 }],
      { 3388: 5 }
    );

    const { container } = await mountView({ characterId: 91316135 });
    const pips = pipsFor(container, 'Advanced Industry');

    expect(pips[4].classList.contains('is-trained-marker')).toBe(true);
    expect(pips[5].classList.contains('is-current')).toBe(true);
    expect(pips[5].classList.contains('is-override')).toBe(true);
  });

  test('an override of 0 is honoured, not treated as "no override"', async () => {
    // 0 is falsy; a truthiness check here would silently drop the override.
    character = makeCharacter(
      [{ skillId: 3388, trained: 4, sp: 452000 }],
      { 3388: 0 }
    );

    const { container } = await mountView({ characterId: 91316135 });

    const badge = rowFor(container, 'Advanced Industry').querySelector('.sk-override-badge');
    expect(badge.textContent).toBe('Override 0');
  });

  test('the pips update immediately, before the save round-trips', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    pipsFor(container, 'Advanced Industry')[5].click();

    // No await: the UI must respond on click, not after IPC.
    expect(pipsFor(container, 'Advanced Industry')[5].classList.contains('is-current')).toBe(true);
    await settle();
  });

  test('a failed save rolls the pips back', async () => {
    allowErrors('Could not set override');
    setOverrideResult = false;

    const { container } = await mountView({ characterId: 91316135 });

    pipsFor(container, 'Advanced Industry')[5].click();
    await settle();

    const pips = pipsFor(container, 'Advanced Industry');
    expect(pips[4].classList.contains('is-current')).toBe(true);
    expect(calls.some((c) => c.fn === 'toast.error')).toBe(true);
  });
});

describe('clear all overrides', () => {
  test('the button only appears when there is something to clear', async () => {
    const clean = await mountView({ characterId: 91316135 });
    expect(clean.container.querySelector('#sk-clear-overrides').hidden).toBe(true);

    character = makeCharacter([{ skillId: 3388, trained: 4 }], { 3388: 5 });
    const dirty = await mountView({ characterId: 91316135 });
    expect(dirty.container.querySelector('#sk-clear-overrides').hidden).toBe(false);
  });

  test('it confirms before clearing, and does nothing on cancel', async () => {
    character = makeCharacter([{ skillId: 3388, trained: 4 }], { 3388: 5 });
    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#sk-clear-overrides').click();
    expect(container.querySelector('#sk-confirm-modal').hidden).toBe(false);

    container.querySelector('#sk-confirm-cancel').click();
    await settle();

    expect(container.querySelector('#sk-confirm-modal').hidden).toBe(true);
    expect(calls.some((c) => c.fn === 'skills.clearOverrides')).toBe(false);
  });

  test('confirming clears them', async () => {
    character = makeCharacter([{ skillId: 3388, trained: 4 }], { 3388: 5 });
    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#sk-clear-overrides').click();
    container.querySelector('#sk-confirm-ok').click();
    await settle();

    expect(calls.some((c) => c.fn === 'skills.clearOverrides')).toBe(true);
    expect(calls.some((c) => c.fn === 'toast.success')).toBe(true);
  });

  test('Escape closes the confirmation', async () => {
    character = makeCharacter([{ skillId: 3388, trained: 4 }], { 3388: 5 });
    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#sk-clear-overrides').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(container.querySelector('#sk-confirm-modal').hidden).toBe(true);
  });
});

describe('filtering', () => {
  test('Trained is on by default and Untrained is hidden', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const names = skillRows(container).map((r) => r.querySelector('.sk-row-name').textContent);
    expect(names).toContain('Industry');
    expect(names).not.toContain('Research'); // trained 0
  });

  test('Trained and Untrained are mutually exclusive', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const filters = () => [...container.querySelectorAll('#sk-status-filters .sk-facet')];
    const untrained = filters().find((f) => f.textContent.includes('Untrained'));
    untrained.click();

    const after = filters();
    expect(after.find((f) => f.textContent.includes('Untrained')).classList.contains('is-on')).toBe(true);
    expect(after.find((f) => f.textContent.startsWith('Trained')).classList.contains('is-on')).toBe(false);

    const names = skillRows(container).map((r) => r.querySelector('.sk-row-name').textContent);
    expect(names).toEqual(['Research']);
  });

  test('Overridden is exclusive - only overridden skills show', async () => {
    character = makeCharacter([
      { skillId: 3380, trained: 5 },
      { skillId: 3388, trained: 4 },
    ], { 3388: 5 });

    const { container } = await mountView({ characterId: 91316135 });

    [...container.querySelectorAll('#sk-status-filters .sk-facet')]
      .find((f) => f.textContent.includes('Overridden')).click();

    const names = skillRows(container).map((r) => r.querySelector('.sk-row-name').textContent);
    expect(names).toEqual(['Advanced Industry']);
  });

  test('search matches on skill name', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const search = container.querySelector('#sk-search');
    search.value = 'advanced';
    search.dispatchEvent(new Event('input'));

    const names = skillRows(container).map((r) => r.querySelector('.sk-row-name').textContent);
    expect(names).toEqual(['Advanced Industry']);
  });

  test('search also matches on skill ID', async () => {
    // Genuinely useful when the SDE is missing and names are bare ids.
    const { container } = await mountView({ characterId: 91316135 });

    const search = container.querySelector('#sk-search');
    search.value = '3392';
    search.dispatchEvent(new Event('input'));

    const names = skillRows(container).map((r) => r.querySelector('.sk-row-name').textContent);
    expect(names).toEqual(['Accounting']);
  });

  test('a group facet filters to that group', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    [...container.querySelectorAll('#sk-group-facets .sk-facet')]
      .find((f) => f.textContent.includes('Production')).click();

    const groups = groupCards(container).map((g) =>
      g.querySelector('.sk-group-name').textContent);
    expect(groups).toEqual(['Production']);
  });

  test('Clear removes the group filter', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    const all = groupCards(container).length;

    [...container.querySelectorAll('#sk-group-facets .sk-facet')]
      .find((f) => f.textContent.includes('Production')).click();
    expect(groupCards(container).length).toBeLessThan(all);

    container.querySelector('#sk-clear-groups').click();
    expect(groupCards(container)).toHaveLength(all);
  });

  test('group facet counts are over ALL skills, not the filtered set', async () => {
    // Otherwise a group vanishes from the sidebar the moment a status filter
    // excludes its members, and cannot be selected again.
    const { container } = await mountView({ characterId: 91316135 });

    const science = [...container.querySelectorAll('#sk-group-facets .sk-facet')]
      .find((f) => f.textContent.includes('Science'));
    // Science holds Science (trained) + Research (untrained) = 2.
    expect(science.querySelector('.sk-facet-count').textContent).toBe('2');
  });

  test('filtering everything out shows the "no match" state', async () => {
    const { container } = await mountView({ characterId: 91316135 });

    const search = container.querySelector('#sk-search');
    search.value = 'nothing-matches-this';
    search.dispatchEvent(new Event('input'));

    expect(container.querySelector('#sk-empty').hidden).toBe(false);
    expect(container.querySelector('#sk-empty-title').textContent).toBe('No skills match');
  });
});

describe('summary strip', () => {
  test('reports total SP, trained count, level 5s and overrides', async () => {
    character = makeCharacter([
      { skillId: 3380, trained: 5 },
      { skillId: 3388, trained: 4 },
      { skillId: 3403, trained: 0 },
    ], { 3403: 3 });

    const { container } = await mountView({ characterId: 91316135 });

    const values = [...container.querySelectorAll('.sk-stat')].map((s) => ({
      label: s.querySelector('.sk-stat-label').textContent,
      value: s.querySelector('.sk-stat-value').textContent,
    }));

    expect(values).toEqual([
      { label: 'Total SP', value: '84,200,000' },
      // An overridden untrained skill counts as trained.
      { label: 'Skills Trained', value: '3' },
      { label: 'At Level 5', value: '1' },
      { label: 'Overrides', value: '1' },
    ]);
  });
});

describe('refresh', () => {
  test('fetches from ESI then reloads', async () => {
    const { container } = await mountView({ characterId: 91316135 });
    calls.length = 0;

    container.querySelector('#sk-refresh-btn').click();
    await settle();

    expect(calls.some((c) => c.fn === 'skills.fetch')).toBe(true);
    expect(calls.some((c) => c.fn === 'sde.getSkillInfo')).toBe(true);
  });

  test('reports failure as a toast, never a blocking alert', async () => {
    // alert() under the shell freezes the whole window behind a modal dialog.
    allowErrors('Refresh failed');
    fetchResult = { success: false, error: 'ESI down' };
    const alertSpy = jest.fn();
    window.alert = alertSpy;

    const { container } = await mountView({ characterId: 91316135 });
    container.querySelector('#sk-refresh-btn').click();
    await settle();

    expect(alertSpy).not.toHaveBeenCalled();
    expect(calls.some((c) => c.fn === 'toast.error')).toBe(true);
  });

  test('re-enables the button after a failure', async () => {
    allowErrors('Refresh failed');
    fetchResult = { success: false, error: 'ESI down' };

    const { container } = await mountView({ characterId: 91316135 });
    const btn = container.querySelector('#sk-refresh-btn');
    btn.click();
    await settle();

    expect(btn.disabled).toBe(false);
  });
});

describe('refresh while the ESI cache is still valid', () => {
  // THE BUG (user-reported): the button was DISABLED while gated. A disabled
  // <button> swallows the click, so no handler ran, no toast appeared and the
  // cursor did not change - it read as a completely dead button.
  //
  // It now stays clickable and explains why nothing was fetched.
  function gateTheCache() {
    window.QFCacheCountdown = {
      attach: (config) => {
        config.render({ cached: true, label: '3m 12s', remaining: 192 });
        return () => {};
      },
      formatRemaining: () => '3m 12s',
      setLabel: () => {},
    };
  }

  test('the button is NOT disabled while gated', async () => {
    gateTheCache();
    const { container } = await mountView({ characterId: 91316135 });

    const btn = container.querySelector('#sk-refresh-btn');
    expect(btn.disabled).toBe(false);
    expect(btn.classList.contains('is-gated')).toBe(true);
  });

  test('clicking it tells the user why, naming the remaining time', async () => {
    gateTheCache();
    const { container } = await mountView({ characterId: 91316135 });

    container.querySelector('#sk-refresh-btn').click();
    await settle();

    const info = calls.find((c) => c.fn === 'toast.info');
    expect(info).toBeDefined();
    expect(info.m).toContain('3m 12s');
  });

  test('it does NOT round-trip to ESI just to be refused', async () => {
    gateTheCache();
    const { container } = await mountView({ characterId: 91316135 });
    calls.length = 0;

    container.querySelector('#sk-refresh-btn').click();
    await settle();

    expect(calls.some((c) => c.fn === 'skills.fetch')).toBe(false);
  });

  test('the label and tooltip both say the cache is still valid', async () => {
    gateTheCache();
    const { container } = await mountView({ characterId: 91316135 });

    const btn = container.querySelector('#sk-refresh-btn');
    expect(container.querySelector('#sk-refresh-label').textContent).toBe('Cached (3m 12s)');
    expect(btn.title).toContain('3m 12s');
    expect(container.querySelector('#sk-cache-status').textContent).toContain('3m 12s');
  });

  test('a gated result from main is still reported if one slips through', async () => {
    // Belt and braces: the renderer-side check is the fast path, but main can
    // gate independently (e.g. the error budget), so that answer must surface.
    fetchResult = { success: true, skipped: true, reason: 'Nothing newer yet.' };

    const { container } = await mountView({ characterId: 91316135 });
    container.querySelector('#sk-refresh-btn').click();
    await settle();

    expect(calls.find((c) => c.fn === 'toast.info').m).toBe('Nothing newer yet.');
  });
});

describe('live updates', () => {
  test('reloads when the background cycle lands new skill data', async () => {
    await mountView({ characterId: 91316135 });
    calls.length = 0;

    subscribers['esi:data-changed'].forEach((cb) => cb({ endpointType: 'skills' }));
    await settle();

    expect(calls.some((c) => c.fn === 'esi.getCharacter')).toBe(true);
  });

  test('ignores endpoints this screen does not display', async () => {
    await mountView({ characterId: 91316135 });
    calls.length = 0;

    subscribers['esi:data-changed'].forEach((cb) => cb({ endpointType: 'assets' }));
    await settle();

    expect(calls.some((c) => c.fn === 'esi.getCharacter')).toBe(false);
  });

  test('the subscription is tracked so a remount cannot duplicate it', async () => {
    const { made } = await mountView({ characterId: 91316135 });
    expect(made.tracked.length).toBeGreaterThan(0);
  });
});

describe('remount hygiene', () => {
  test('a remount does not inherit the previous filters', async () => {
    // `state` is module-level and survives unmount.
    const first = await mountView({ characterId: 91316135 });

    const search = first.container.querySelector('#sk-search');
    search.value = 'advanced';
    search.dispatchEvent(new Event('input'));
    expect(skillRows(first.container)).toHaveLength(1);

    first.ctx.dispose();
    if (registered.def.destroy) registered.def.destroy();

    const second = await mountView({ characterId: 91316135 });

    expect(second.container.querySelector('#sk-search').value).toBe('');
    expect(skillRows(second.container).length).toBeGreaterThan(1);
  });
});

describe('CSS contracts (jsdom applies no stylesheets - assert on the text)', () => {
  test('binding rule 6a: hidden beats any explicit display', () => {
    // This view toggles the group list, empty state, loading state, the Clear
    // Overrides button and the modal via `hidden`, and they all set a display.
    // A DOM assertion cannot catch it: expect(el.hidden).toBe(true) passes
    // while the user sees the element.
    expect(VIEW_CSS).toMatch(/#skills-view\s*\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  test('binding rule 1: row highlights use box-shadow, never a toggled background', () => {
    const facet = VIEW_CSS.match(/\.sk-facet\s*\{[^}]*\}/)[0];
    const facetOn = VIEW_CSS.match(/\.sk-facet\.is-on\s*\{[^}]*\}/)[0];
    expect(facet).toContain('background-color: transparent');
    expect(facetOn).toContain('box-shadow');
    expect(facetOn).not.toMatch(/background-color:\s*var/);

    const row = VIEW_CSS.match(/\.sk-row\s*\{[^}]*\}/)[0];
    const rowOn = VIEW_CSS.match(/\.sk-row\.is-overridden\s*\{[^}]*\}/)[0];
    expect(row).toContain('background-color: transparent');
    expect(rowOn).toContain('box-shadow');
  });

  test('binding rule 3: every level-pip state sets the same properties', () => {
    // Otherwise a property set by one state never resets when another applies,
    // and pips keep stale colouring as the effective level moves.
    const base = VIEW_CSS.match(/\.sk-level\s*\{[^}]*\}/)[0];
    ['color', 'background-color', 'border'].forEach((prop) => {
      expect(base).toMatch(new RegExp(`${prop}(-color)?:`));
    });

    ['is-filled', 'is-current', 'is-trained-marker'].forEach((cls) => {
      const rule = VIEW_CSS.match(new RegExp(`\\.sk-level\\.${cls}[^{]*\\{[^}]*\\}`))[0];
      expect(rule).toMatch(/color:/);
      expect(rule).toMatch(/background-color:/);
      expect(rule).toMatch(/border-color:/);
    });
  });

  test('binding rule 4: inputs use --qf-surface-sunken, not --qf-surface', () => {
    const inputRule = VIEW_CSS.match(/\.sk-input\s*\{[^}]*\}/)[0];
    expect(inputRule).toContain('var(--qf-surface-sunken)');
  });

  test('a gated button is dimmed but never pointer-events: none', () => {
    // Suppressing pointer events would recreate the dead-button bug in CSS
    // after it was fixed in JS: the click would be swallowed again and the
    // explanatory toast would never fire.
    const rule = VIEW_CSS.match(/\.btn\.is-gated\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/opacity:/);
    expect(rule).not.toMatch(/pointer-events:\s*none/);
  });
});
