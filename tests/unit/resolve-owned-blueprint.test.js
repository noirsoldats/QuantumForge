/**
 * resolveOwnedBlueprint - which owned copy supplies a blueprint's ME/TE.
 *
 * Replaces a lookup with three defects, all pre-existing and all shared by the
 * Blueprint Calculator and the plan intermediate expansion:
 *
 *   1. corp blueprints were silently in scope (stored against the same
 *      character_id with is_corporation = 1, nothing filtering them). A corp
 *      ME 8 BPO overrode a personal ME 7 copy with no way to tell why.
 *   2. `.find()` returned the first row in TABLE ORDER, so which copy won could
 *      change after a re-fetch - arbitrary, not "best".
 *   3. BPOs and BPCs ranked equally, so a 1-run ME 2 BPC could beat an ME 10
 *      BPO.
 */

let mockBlueprints;
let mockOverrides;
let mockSources;
let mockDefaultCharacterId;

jest.mock('../../src/main/settings-manager', () => ({
  getBlueprints: (characterId) => mockBlueprints[characterId] || [],
  getEffectiveBlueprintValues: (itemId) => mockOverrides[itemId] || null,
  getBlueprintSources: () => mockSources,
  loadSettings: () => ({ accounts: { defaultCharacterId: mockDefaultCharacterId } }),
}));

const {
  resolveOwnedBlueprint,
  getEffectiveBlueprintSources,
} = require('../../src/main/blueprint-calculator');

const CARACAL_BP = 687;

/** ESI-shaped blueprint row. */
function bp(overrides = {}) {
  return {
    itemId: `item-${Math.random()}`,
    typeId: CARACAL_BP,
    materialEfficiency: 0,
    timeEfficiency: 0,
    isCopy: false,
    isCorporation: false,
    locationFlag: 'Hangar',
    ...overrides,
  };
}

beforeEach(() => {
  mockBlueprints = {};
  mockOverrides = {};
  mockSources = { characterIds: [111], divisionsByCharacter: {} };
  mockDefaultCharacterId = 111;
});

describe('source filtering', () => {
  test('personal blueprints are unconditional for an enabled character', () => {
    mockBlueprints[111] = [bp({ materialEfficiency: 7 })];

    expect(resolveOwnedBlueprint(CARACAL_BP).me).toBe(7);
  });

  test('a character that is not enabled contributes nothing', () => {
    mockBlueprints[222] = [bp({ materialEfficiency: 10 })];
    mockSources = { characterIds: [111], divisionsByCharacter: {} };

    expect(resolveOwnedBlueprint(CARACAL_BP)).toBeNull();
  });

  test('resolves across ALL enabled characters, not just one', () => {
    // The old lookup took a single characterId, so a better blueprint on an
    // alt was invisible.
    mockBlueprints[111] = [bp({ materialEfficiency: 4 })];
    mockBlueprints[222] = [bp({ materialEfficiency: 9 })];
    mockSources = { characterIds: [111, 222], divisionsByCharacter: {} };

    const resolved = resolveOwnedBlueprint(CARACAL_BP);
    expect(resolved.me).toBe(9);
    expect(resolved.characterId).toBe(222);
  });

  test('corp blueprints are EXCLUDED when no division is enabled', () => {
    // The reported bug: an ME 8 corp BPO silently beat a personal ME 7 copy.
    mockBlueprints[111] = [
      bp({ materialEfficiency: 7 }),
      bp({ materialEfficiency: 8, isCorporation: true, locationFlag: 'CorpSAG2' }),
    ];

    expect(resolveOwnedBlueprint(CARACAL_BP).me).toBe(7);
  });

  test('corp blueprints are INCLUDED once their division is enabled', () => {
    mockBlueprints[111] = [
      bp({ materialEfficiency: 7 }),
      bp({ materialEfficiency: 8, isCorporation: true, locationFlag: 'CorpSAG2' }),
    ];
    mockSources = { characterIds: [111], divisionsByCharacter: { 111: [2] } };

    const resolved = resolveOwnedBlueprint(CARACAL_BP);
    expect(resolved.me).toBe(8);
    expect(resolved.isCorporation).toBe(true);
  });

  test('a corp blueprint in a DIFFERENT division stays excluded', () => {
    mockBlueprints[111] = [
      bp({ materialEfficiency: 8, isCorporation: true, locationFlag: 'CorpSAG5' }),
    ];
    mockSources = { characterIds: [111], divisionsByCharacter: { 111: [2] } };

    expect(resolveOwnedBlueprint(CARACAL_BP)).toBeNull();
  });

  test('an unattributable corp blueprint is excluded even with divisions on', () => {
    // Hard rule: cannot parse the division -> do not use it.
    mockBlueprints[111] = [
      bp({ materialEfficiency: 10, isCorporation: true, locationFlag: 'CorpDeliveries' }),
    ];
    mockSources = { characterIds: [111], divisionsByCharacter: { 111: [1, 2, 3, 4, 5, 6, 7] } };

    expect(resolveOwnedBlueprint(CARACAL_BP)).toBeNull();
  });

  test("divisions are per character, not shared", () => {
    mockBlueprints[111] = [
      bp({ materialEfficiency: 9, isCorporation: true, locationFlag: 'CorpSAG1' }),
    ];
    mockBlueprints[222] = [
      bp({ materialEfficiency: 3, isCorporation: true, locationFlag: 'CorpSAG1' }),
    ];
    // Only 222 has division 1 enabled.
    mockSources = { characterIds: [111, 222], divisionsByCharacter: { 222: [1] } };

    const resolved = resolveOwnedBlueprint(CARACAL_BP);
    expect(resolved.me).toBe(3);
    expect(resolved.characterId).toBe(222);
  });
});

describe('duplicate corp rows across characters', () => {
  // A corp blueprint is stored ONCE PER CHARACTER who can see it - both tables
  // are keyed on (character_id, item_id). Two characters in the same corp
  // therefore yield two rows for the same physical BPO.
  //
  // Resolution picks a MAXIMUM rather than summing, so duplicates cannot
  // inflate anything. These tests pin that property instead of leaving it to
  // luck - if this ever starts aggregating, it must dedupe on itemId first.

  test('the same corp blueprint seen by two characters resolves once', () => {
    const shared = {
      itemId: 'corp-bpo-1',
      typeId: CARACAL_BP,
      materialEfficiency: 8,
      isCopy: false,
      isCorporation: true,
      locationFlag: 'CorpSAG2',
    };
    mockBlueprints[111] = [{ ...shared }];
    mockBlueprints[222] = [{ ...shared }];
    mockSources = {
      characterIds: [111, 222],
      divisionsByCharacter: { 111: [2], 222: [2] },
    };

    const resolved = resolveOwnedBlueprint(CARACAL_BP);
    expect(resolved.me).toBe(8);
    expect(resolved.itemId).toBe('corp-bpo-1');
  });

  test('duplication does not beat a genuinely better personal blueprint', () => {
    const shared = {
      itemId: 'corp-bpo-1',
      typeId: CARACAL_BP,
      materialEfficiency: 6,
      isCopy: false,
      isCorporation: true,
      locationFlag: 'CorpSAG2',
    };
    mockBlueprints[111] = [{ ...shared }, bp({ materialEfficiency: 9 })];
    mockBlueprints[222] = [{ ...shared }];
    mockSources = {
      characterIds: [111, 222],
      divisionsByCharacter: { 111: [2], 222: [2] },
    };

    expect(resolveOwnedBlueprint(CARACAL_BP).me).toBe(9);
  });
});

describe('tie-breaking', () => {
  test('a BPO beats a higher-ME BPC', () => {
    // A BPC's runs are consumed; adopting its ME implies a job that may not be
    // repeatable.
    mockBlueprints[111] = [
      bp({ materialEfficiency: 10, isCopy: true }),
      bp({ materialEfficiency: 2, isCopy: false }),
    ];

    const resolved = resolveOwnedBlueprint(CARACAL_BP);
    expect(resolved.me).toBe(2);
    expect(resolved.isCopy).toBe(false);
  });

  test('highest ME wins among BPOs', () => {
    mockBlueprints[111] = [
      bp({ materialEfficiency: 4 }),
      bp({ materialEfficiency: 10 }),
      bp({ materialEfficiency: 7 }),
    ];

    expect(resolveOwnedBlueprint(CARACAL_BP).me).toBe(10);
  });

  test('highest ME wins among BPCs when no BPO exists', () => {
    mockBlueprints[111] = [
      bp({ materialEfficiency: 2, isCopy: true }),
      bp({ materialEfficiency: 6, isCopy: true }),
    ];

    const resolved = resolveOwnedBlueprint(CARACAL_BP);
    expect(resolved.me).toBe(6);
    expect(resolved.isCopy).toBe(true);
  });

  test('the winner does not depend on row order', () => {
    // The old `.find()` returned whatever the DB listed first.
    const rows = [
      bp({ materialEfficiency: 3 }),
      bp({ materialEfficiency: 10 }),
      bp({ materialEfficiency: 5 }),
    ];
    mockBlueprints[111] = rows;
    const forward = resolveOwnedBlueprint(CARACAL_BP).me;

    mockBlueprints[111] = [...rows].reverse();
    const backward = resolveOwnedBlueprint(CARACAL_BP).me;

    expect(forward).toBe(10);
    expect(backward).toBe(10);
  });
});

describe('overrides and values', () => {
  test('a manual ME override wins over the ESI value', () => {
    const row = bp({ materialEfficiency: 4, itemId: 'item-a' });
    mockBlueprints[111] = [row];
    mockOverrides['item-a'] = { materialEfficiency: 9, timeEfficiency: 18 };

    const resolved = resolveOwnedBlueprint(CARACAL_BP);
    expect(resolved.me).toBe(9);
    expect(resolved.te).toBe(18);
  });

  test('returns TE alongside ME', () => {
    mockBlueprints[111] = [bp({ materialEfficiency: 7, timeEfficiency: 14 })];

    expect(resolveOwnedBlueprint(CARACAL_BP).te).toBe(14);
  });

  test('an owned ME 0 blueprint is distinguishable from not owned', () => {
    // `|| 0` collapsed these two; callers need to tell them apart.
    mockBlueprints[111] = [bp({ materialEfficiency: 0 })];

    const resolved = resolveOwnedBlueprint(CARACAL_BP);
    expect(resolved).not.toBeNull();
    expect(resolved.me).toBe(0);

    mockBlueprints[111] = [];
    expect(resolveOwnedBlueprint(CARACAL_BP)).toBeNull();
  });

  test('ignores blueprints of other types', () => {
    mockBlueprints[111] = [bp({ typeId: 999, materialEfficiency: 10 })];

    expect(resolveOwnedBlueprint(CARACAL_BP)).toBeNull();
  });
});

describe('explicit sources', () => {
  test('passed-in sources override the configured ones', () => {
    // Plans pass their OWN snapshot so they do not drift with global settings.
    mockBlueprints[111] = [bp({ materialEfficiency: 3 })];
    mockBlueprints[222] = [bp({ materialEfficiency: 8 })];
    mockSources = { characterIds: [111], divisionsByCharacter: {} };

    const planSources = { characterIds: [222], divisionsByCharacter: {} };
    expect(resolveOwnedBlueprint(CARACAL_BP, planSources).me).toBe(8);
  });

  test('empty explicit sources resolve nothing - no silent fallback', () => {
    // A plan configured with no blueprint sources means exactly that; falling
    // back to the global sources would make plan figures unpredictable.
    mockBlueprints[111] = [bp({ materialEfficiency: 10 })];

    const empty = { characterIds: [], divisionsByCharacter: {} };
    expect(resolveOwnedBlueprint(CARACAL_BP, empty)).toBeNull();
  });
});

describe('self-healing fallback', () => {
  test('falls back to the default character when nothing is enabled', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSources = { characterIds: [], divisionsByCharacter: {} };
    mockDefaultCharacterId = 111;

    const sources = getEffectiveBlueprintSources();

    expect(sources.characterIds).toEqual([111]);
    // Loud, not silent: this state means a bootstrap path was missed.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('the fallback does NOT infer corp divisions', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSources = { characterIds: [], divisionsByCharacter: {} };

    expect(getEffectiveBlueprintSources().divisionsByCharacter).toEqual({});
    warn.mockRestore();
  });

  test('does not fire when a character IS enabled', () => {
    // Someone who enabled SOME character has made a choice; their other
    // characters must stay excluded.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSources = { characterIds: [222], divisionsByCharacter: {} };
    mockDefaultCharacterId = 111;

    expect(getEffectiveBlueprintSources().characterIds).toEqual([222]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('resolves nothing when there is no default character either', () => {
    mockSources = { characterIds: [], divisionsByCharacter: {} };
    mockDefaultCharacterId = undefined;

    expect(getEffectiveBlueprintSources().characterIds).toEqual([]);
  });
});

describe('callers read ME and TE off the resolved blueprint', () => {
  // getOwnedBlueprintME was deleted: it ignored its first argument, collapsed
  // "owns an ME 0 blueprint" and "owns nothing" into the same 0, and threw
  // away the TE the resolver had already fetched. Callers now use
  // resolveOwnedBlueprint directly and apply their own default.

  test('a caller can distinguish "not owned" from ME 0', () => {
    mockBlueprints[111] = [bp({ materialEfficiency: 0, timeEfficiency: 0 })];
    const owned = resolveOwnedBlueprint(CARACAL_BP);
    expect(owned).not.toBeNull();
    expect(owned.me).toBe(0);

    mockBlueprints[111] = [];
    expect(resolveOwnedBlueprint(CARACAL_BP)).toBeNull();
  });

  test('ME and TE come from ONE lookup', () => {
    // The old wrapper returned ME only, so callers defaulted TE to 0 even when
    // the very same blueprint knew it.
    mockBlueprints[111] = [bp({ materialEfficiency: 9, timeEfficiency: 18 })];

    const owned = resolveOwnedBlueprint(CARACAL_BP);
    expect(owned.me).toBe(9);
    expect(owned.te).toBe(18);
  });

  test('the default when nothing is owned is the caller\'s choice', () => {
    const owned = resolveOwnedBlueprint(CARACAL_BP);
    expect(owned ? owned.me : 0).toBe(0);
  });
});
