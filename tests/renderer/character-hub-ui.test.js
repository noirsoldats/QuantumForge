/**
 * @jest-environment jsdom
 *
 * Character Hub shell view.
 *
 * The renderer is an IIFE that registers itself with the shell router and
 * exposes nothing, so these tests drive it the way a user does.
 *
 * This screen is about to change shape: passes 2-4 convert each card's
 * Assets/Skills/Blueprints action from opening a window to mounting in place.
 * These tests pin what must survive that - the roster, the aggregate maths,
 * default-character handling, and the cache-only reads.
 *
 * Fixtures use the REAL shapes:
 *   - getCharacters -> [{ characterId, characterName, portrait, scopes,
 *     expiresAt, ... }]  (NOT `id`/`name`)
 *   - getCharacter  -> { ..., skills: { totalSp, skills: { [id]:
 *     { trainedSkillLevel } } } }  - skills is a MAP keyed by skill id
 *   - blueprints.getAll / assets.get -> arrays, counted by length
 *
 * console.error is captured and any unexpected entry FAILS the test.
 */

const fs = require('fs');
const path = require('path');

const VIEW_HTML = fs.readFileSync(
  path.join(__dirname, '../../public/character-hub.view.html'),
  'utf8'
);

require('../../public/shared/ui-helpers.js');

/* --------------------------------------------------------------- fixtures */

let characters;
let defaultCharacter;
let corporationNames;
let characterDetail;
let blueprintsByCharacter;
let assetsByCharacter;
let authResult;
let calls;
let consoleErrors = [];
let expectedErrorPatterns = [];
let registered;
let disposed;
let subscribers;

function allowErrors(...patterns) {
  expectedErrorPatterns.push(...patterns);
}

function subscribe(channel, cb) {
  if (!subscribers[channel]) subscribers[channel] = [];
  subscribers[channel].push(cb);
  return () => {
    disposed[channel] = (disposed[channel] || 0) + 1;
    subscribers[channel] = subscribers[channel].filter((c) => c !== cb);
  };
}

function makeApi() {
  return {
    esi: {
      getCharacters: async () => {
        calls.push({ fn: 'getCharacters' });
        return characters;
      },
      getDefaultCharacter: async () => defaultCharacter,
      // Cached read - returns skills from the local DB, never hits ESI.
      getCharacter: async (id) => {
        calls.push({ fn: 'getCharacter', id });
        return characterDetail[id] || null;
      },
      setDefaultCharacter: async (id) => {
        calls.push({ fn: 'setDefaultCharacter', id });
        defaultCharacter = characters.find((c) => c.characterId === id) || null;
        return true;
      },
      // Session-cached in main; returns id -> name, omitting ids that could
      // not be resolved.
      resolveCorporationNames: async (ids) => {
        calls.push({ fn: 'resolveCorporationNames', ids });
        return corporationNames;
      },
      authenticate: async () => {
        calls.push({ fn: 'authenticate' });
        return authResult;
      },
      onDefaultCharacterChanged: (cb) => subscribe('default-character-changed', cb),
    },
    blueprints: {
      getAll: async (id) => {
        calls.push({ fn: 'blueprints.getAll', id });
        return blueprintsByCharacter[id] || [];
      },
      // No per-screen openWindow: Blueprints opens via window.openView.
    },
    assets: {
      get: async (id, isCorporation) => {
        calls.push({ fn: 'assets.get', id, isCorporation });
        return assetsByCharacter[id] || [];
      },
      // No per-screen openWindow: Assets opens via the generic
      // window.openView(viewId, params).
    },
    skills: {
      // No per-screen openWindow: Skills opens via window.openView.
    },
    window: {
      openView: (viewId, params) => calls.push({ fn: 'window.openView', viewId, params }),
      isViewOpen: async () => false,
      focusView: async () => false,
    },
    data: {
      onChanged: (cb) => subscribe('esi:data-changed', cb),
      onCycleComplete: (cb) => subscribe('esi:cycle-complete', cb),
      onMarketChanged: (cb) => subscribe('market:data-changed', cb),
    },
  };
}

/* ---------------------------------------------------------------- harness */

function loadRenderer() {
  jest.isolateModules(() => {
    require('../../src/renderer/character-hub-renderer.js');
  });
}

function makeCtx() {
  const tracked = [];
  return {
    ctx: {
      on: (target, type, handler) => target && target.addEventListener(type, handler),
      track: (fn) => tracked.push(fn),
      dispose: () => tracked.forEach((fn) => fn()),
    },
  };
}

async function settle(times = 30) {
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

/** One skill entry, as the cached character record stores them. */
function skillsAt(levels) {
  const map = {};
  levels.forEach((level, i) => {
    map[1000 + i] = { skillId: 1000 + i, trainedSkillLevel: level, activeSkillLevel: level };
  });
  return map;
}

beforeEach(() => {
  consoleErrors = [];
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(
      args
        .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : ''))
        .filter(Boolean)
        .join(' ')
    );
  });

  calls = [];
  disposed = {};
  subscribers = {};

  // getCharacters stores only corporationId - there is no corporationName,
  // and the view says "Corporation <id>" rather than inventing one.
  characters = [
    {
      characterId: 91316135,
      characterName: 'Buckwalter',
      corporationId: 98000001,
      portrait: 'https://images.evetech.net/characters/91316135/portrait',
      scopes: ['esi-skills.read_skills.v1', 'esi-assets.read_assets.v1'],
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
    {
      characterId: 96061222,
      characterName: 'Alt Pilot',
      corporationId: 98000002,
      portrait: 'https://images.evetech.net/characters/96061222/portrait',
      scopes: ['esi-skills.read_skills.v1'],
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  ];

  // Alt Pilot is default, so the roster must reorder to put it first.
  defaultCharacter = characters[1];

  corporationNames = {
    98000001: 'Forge Dynamics',
    98000002: 'Nyx Salvage Co.',
  };

  characterDetail = {
    91316135: {
      characterId: 91316135,
      skills: { totalSp: 84_200_000, skills: skillsAt([5, 5, 4, 5, 3]) },
    },
    96061222: {
      characterId: 96061222,
      skills: { totalSp: 51_600_000, skills: skillsAt([5, 3, 2]) },
    },
  };

  blueprintsByCharacter = {
    91316135: new Array(38).fill({ itemId: 'bp' }),
    96061222: new Array(12).fill({ itemId: 'bp' }),
  };

  assetsByCharacter = {
    91316135: new Array(1204).fill({ itemId: 'a' }),
    96061222: new Array(842).fill({ itemId: 'a' }),
  };

  authResult = { success: true };

  registered = null;
  window.QFShell = {
    router: {
      register: (id, def) => { registered = { id, def }; },
      show: (id, params) => calls.push({ fn: 'router.show', id, params }),
    },
  };
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
  document.body.innerHTML = '';

  if (unexpected.length > 0) {
    throw new Error(
      `Renderer logged ${unexpected.length} unexpected error(s):\n  ` + unexpected.join('\n  ')
    );
  }
});

/* ------------------------------------------------------------------ tests */

describe('registration', () => {
  test('registers as the `characters` shell view', () => {
    expect(registered.id).toBe('characters');
    expect(typeof registered.def.mount).toBe('function');
    expect(registered.def.title).toBe('Characters');
  });
});

describe('roster', () => {
  test('renders one card per connected character', async () => {
    await mountView();

    expect(document.querySelectorAll('#ch-cards .ch-card')).toHaveLength(2);
  });

  test('puts the default character first, then alphabetical', async () => {
    // The gold star should lead, whatever the character's name.
    await mountView();

    const ids = Array.from(document.querySelectorAll('#ch-cards .ch-card'))
      .map((c) => c.getAttribute('data-character-id'));
    expect(ids).toEqual(['96061222', '91316135']);
  });

  test('marks the default character', async () => {
    await mountView();

    const first = document.querySelector('#ch-cards .ch-card');
    expect(first.classList.contains('is-default')).toBe(true);
    expect(document.querySelectorAll('#ch-cards .ch-card.is-default')).toHaveLength(1);
  });

  test('shows the character name', async () => {
    await mountView();

    const card = document.querySelector('[data-character-id="91316135"]');
    expect(card.querySelector('.ch-name').textContent).toBe('Buckwalter');
  });

  test('resolves the corporation name', async () => {
    await mountView();

    const card = document.querySelector('[data-character-id="91316135"]');
    expect(card.querySelector('.ch-corp').textContent).toBe('Forge Dynamics');
  });

  test('resolves every corporation in ONE deduped call', async () => {
    // Several characters often share a corp, and the result is session-cached
    // in main - so this must not be a per-character lookup.
    await mountView();

    const resolveCalls = calls.filter((c) => c.fn === 'resolveCorporationNames');
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].ids).toEqual([98000002, 98000001]);
  });

  test('falls back to the bare ID when a name cannot be resolved', async () => {
    // Rate-limited, offline, or a corporation that no longer exists - the
    // character must still be identifiable.
    corporationNames = {};
    await mountView();

    const card = document.querySelector('[data-character-id="91316135"]');
    expect(card.querySelector('.ch-corp').textContent).toBe('Corporation 98000001');
  });

  test('a failed resolve does not blank the roster', async () => {
    window.electronAPI.esi.resolveCorporationNames = async () => {
      throw new Error('esi down');
    };
    await mountView();

    expect(document.querySelectorAll('#ch-cards .ch-card')).toHaveLength(2);
    expect(document.querySelector('[data-character-id="91316135"] .ch-corp').textContent)
      .toBe('Corporation 98000001');
  });

  test('the token-status line is hidden, not removed', async () => {
    // "Token expires in 18m" is a normal state - tokens refresh
    // automatically - so showing a countdown invites the reader to think
    // something needs doing. Parked until there is something useful to put
    // there; the element stays so restoring it is a one-line change.
    await mountView();

    const status = document.querySelector('[data-character-id="91316135"] .ch-status');
    expect(status).not.toBeNull();
    expect(status.hidden).toBe(true);
  });

  test('the hidden status line is hideable by CSS (rule 6a)', () => {
    // .ch-status sets display:inline-flex, which beats the `hidden`
    // attribute - so without a catch-all the line stays visible. jsdom
    // applies no stylesheets, so assert against the real CSS.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/character-hub.css'),
      'utf8'
    );
    expect(css).toMatch(/#character-hub\s*\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  test('renders an empty state when nothing is connected', async () => {
    characters = [];
    defaultCharacter = null;
    await mountView();

    expect(document.getElementById('ch-empty').hidden).toBe(false);
    expect(document.querySelectorAll('#ch-cards .ch-card')).toHaveLength(0);
  });

  test('the empty state is hidden once a character exists', async () => {
    await mountView();
    expect(document.getElementById('ch-empty').hidden).toBe(true);
  });
});

describe('per-character stats', () => {
  test('reads from CACHED sources only - no ESI fetch', async () => {
    // The Hub loads on navigation, so it must never trigger a fetch. Any
    // skills.fetch / assets.fetch here would hit ESI once per character.
    await mountView();

    expect(calls.some((c) => c.fn === 'getCharacter')).toBe(true);
    expect(calls.some((c) => String(c.fn).endsWith('.fetch'))).toBe(false);
  });

  test('asks for personal assets, not corporation assets', async () => {
    await mountView();

    const call = calls.find((c) => c.fn === 'assets.get');
    expect(call.isCorporation).toBe(false);
  });

  test('derives "At Level 5" by counting trained level-5 skills', async () => {
    // Not stored anywhere, so it is computed from the cached per-skill map
    // rather than adding an IPC handler for one number.
    await mountView();

    const card = document.querySelector('[data-character-id="91316135"]');
    // skillsAt([5, 5, 4, 5, 3]) -> three at level 5.
    expect(card.textContent).toContain('3');
  });

  test('counts blueprints and assets by array length', async () => {
    await mountView();

    const card = document.querySelector('[data-character-id="91316135"]');
    expect(card.textContent).toContain('1,204');   // assets
    expect(card.textContent).toContain('38');      // blueprints
  });

  test('a character with no cached skills shows zero, not a crash', async () => {
    characterDetail[91316135] = { characterId: 91316135, skills: null };
    await mountView();

    const card = document.querySelector('[data-character-id="91316135"]');
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('0');
  });

  test('one character failing does not blank the others', async () => {
    window.electronAPI.blueprints.getAll = async (id) => {
      if (id === 91316135) throw new Error('db gone');
      return blueprintsByCharacter[id] || [];
    };
    await mountView();

    // collectStats catches per-source, so both cards still render.
    expect(document.querySelectorAll('#ch-cards .ch-card')).toHaveLength(2);
  });
});

describe('aggregate strip', () => {
  test('sums SP, assets and blueprints across characters', async () => {
    await mountView();

    const text = document.getElementById('ch-totals').textContent;
    expect(text).toContain('2');          // character count
    expect(text).toContain('2,046');      // 1204 + 842 assets
    expect(text).toContain('50');         // 38 + 12 blueprints
  });

  test('shows combined SP in millions', async () => {
    // 84.2M + 51.6M = 135.8M
    await mountView();

    expect(document.getElementById('ch-totals').textContent).toContain('135.8M');
  });

  test('is emptied when no characters are connected', async () => {
    characters = [];
    defaultCharacter = null;
    await mountView();

    expect(document.getElementById('ch-totals').textContent).toBe('');
  });
});

describe('actions', () => {
  test('each card deep-links into assets, skills and blueprints', async () => {
    await mountView();

    const card = document.querySelector('[data-character-id="91316135"]');
    const actions = card.querySelectorAll('.ch-act');
    expect(actions).toHaveLength(3);
    expect(Array.from(actions).map((a) => a.textContent.replace(/[\d,.\sM]/g, '')))
      .toEqual(['Assets', 'Skills', 'Blueprints']);
  });

  test('the deep links carry the character id', async () => {
    // Each sub-view is per-character; opening the wrong one is silent.
    //
    // All three now go through the GENERIC window.openView(viewId, params) -
    // the one universal way any screen gets its own window, and what the
    // pop-out feature uses. No per-screen openWindow remains.
    await mountView();

    const card = document.querySelector('[data-character-id="91316135"]');
    card.querySelectorAll('.ch-act').forEach((btn) => {
      btn.dispatchEvent(new window.MouseEvent('click'));
    });

    const assets = calls.find((c) => c.fn === 'window.openView' && c.viewId === 'assets');
    expect(assets.params).toEqual({ characterId: 91316135 });
    const skills = calls.find((c) => c.fn === 'window.openView' && c.viewId === 'skills');
    expect(skills.params).toEqual({ characterId: 91316135 });
    const blueprints = calls.find(
      (c) => c.fn === 'window.openView' && c.viewId === 'blueprints'
    );
    expect(blueprints.params).toEqual({ characterId: 91316135 });
  });

  test('only a non-default character offers Set Default', async () => {
    await mountView();

    const def = document.querySelector('[data-character-id="96061222"]');
    const other = document.querySelector('[data-character-id="91316135"]');
    expect(def.querySelector('.is-gold')).toBeNull();
    expect(other.querySelector('.is-gold')).not.toBeNull();
  });

  test('Set Default writes and re-renders', async () => {
    await mountView();

    document.querySelector('[data-character-id="91316135"] .is-gold')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(calls.find((c) => c.fn === 'setDefaultCharacter').id).toBe(91316135);
    // Re-rendered: the newly-default character now leads the roster.
    const ids = Array.from(document.querySelectorAll('#ch-cards .ch-card'))
      .map((c) => c.getAttribute('data-character-id'));
    expect(ids[0]).toBe('91316135');
  });

  test('a failed Set Default is reported, not silent', async () => {
    window.electronAPI.esi.setDefaultCharacter = async () => {
      throw new Error('write failed');
    };
    allowErrors(/set default/);
    await mountView();

    document.querySelector('[data-character-id="91316135"] .is-gold')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(consoleErrors.some((e) => /set default/.test(e))).toBe(true);
  });

  test('Manage opens Settings', async () => {
    await mountView();

    document.querySelectorAll('[data-character-id="91316135"] .ch-act-text')
      .forEach((b) => {
        if (b.textContent.includes('Manage')) {
          b.dispatchEvent(new window.MouseEvent('click'));
        }
      });

    expect(calls.find((c) => c.fn === 'router.show').id).toBe('settings');
  });
});

describe('connecting a character', () => {
  test('authenticates and reloads the roster', async () => {
    await mountView();
    calls.length = 0;

    document.getElementById('ch-connect-btn').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(calls.some((c) => c.fn === 'authenticate')).toBe(true);
    expect(calls.some((c) => c.fn === 'getCharacters')).toBe(true);
  });

  test('the button is re-enabled even when auth fails', async () => {
    // Otherwise a declined login leaves the only way in permanently disabled.
    window.electronAPI.esi.authenticate = async () => { throw new Error('cancelled'); };
    allowErrors(/authentication error/);
    await mountView();

    const btn = document.getElementById('ch-connect-btn');
    btn.dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(btn.disabled).toBe(false);
  });

  test('an unsuccessful result is reported', async () => {
    authResult = { success: false, error: 'user cancelled' };
    allowErrors(/authentication failed/);
    await mountView();

    document.getElementById('ch-connect-btn').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(consoleErrors.some((e) => /authentication failed/.test(e))).toBe(true);
  });
});

describe('live updates', () => {
  test('re-renders when the default character changes elsewhere', async () => {
    await mountView();
    calls.length = 0;

    subscribers['default-character-changed'].forEach((cb) => cb());
    await settle(40);

    expect(calls.some((c) => c.fn === 'getCharacters')).toBe(true);
  });

  test('re-renders after a background refresh cycle', async () => {
    await mountView();
    calls.length = 0;

    subscribers['esi:cycle-complete'].forEach((cb) => cb({}));
    await settle(40);

    expect(calls.some((c) => c.fn === 'getCharacters')).toBe(true);
  });

  test('re-renders only for endpoints this screen shows', async () => {
    await mountView();
    calls.length = 0;

    // Market data is not on this screen.
    subscribers['esi:data-changed'].forEach((cb) => cb({ endpointType: 'market_orders' }));
    await settle(20);
    expect(calls.some((c) => c.fn === 'getCharacters')).toBe(false);

    subscribers['esi:data-changed'].forEach((cb) => cb({ endpointType: 'skills' }));
    await settle(40);
    expect(calls.some((c) => c.fn === 'getCharacters')).toBe(true);
  });

  test('a malformed event does not throw', async () => {
    await mountView();

    expect(() => {
      subscribers['esi:data-changed'].forEach((cb) => cb(null));
    }).not.toThrow();
  });
});

describe('lifecycle', () => {
  test('mount subscribes to each live channel exactly once', async () => {
    await mountView();

    expect(subscribers['default-character-changed']).toHaveLength(1);
    expect(subscribers['esi:cycle-complete']).toHaveLength(1);
    expect(subscribers['esi:data-changed']).toHaveLength(1);
  });

  test('unmount disposes every subscription', async () => {
    // This view can be mounted, left and re-entered in a persistent
    // document, so a leaked subscription re-renders a dead screen.
    const { ctx } = await mountView();
    ctx.dispose();

    expect(disposed['default-character-changed']).toBe(1);
    expect(disposed['esi:cycle-complete']).toBe(1);
    expect(disposed['esi:data-changed']).toBe(1);
    expect(subscribers['default-character-changed']).toHaveLength(0);
  });

  test('remounting leaves exactly one live subscription per channel', async () => {
    const first = await mountView();
    first.ctx.dispose();
    first.container.remove();
    document.body.innerHTML = VIEW_HTML;

    const second = await mountView();

    expect(subscribers['default-character-changed']).toHaveLength(1);
    expect(subscribers['esi:data-changed']).toHaveLength(1);
    second.ctx.dispose();
  });
});

describe('resilience', () => {
  test('a failed roster load reports and leaves the view intact', async () => {
    window.electronAPI.esi.getCharacters = async () => { throw new Error('db gone'); };
    allowErrors(/failed to load characters/);

    await mountView();

    expect(document.getElementById('character-hub')).not.toBeNull();
    // No characters resolved, so the empty state stands in.
    expect(document.getElementById('ch-empty').hidden).toBe(false);
  });
});
