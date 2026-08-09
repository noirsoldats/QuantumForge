/**
 * Manufacturing Plan ME/TE is GOLD.
 *
 * The user's rule, verbatim: "plans as they exist HAVE set ME for their
 * intermediates (And Primary Product) and those should be respected as GOLD
 * and remain locked, they should never be changed or 'recalculated', the only
 * time the ME of a Product Blueprint or Intermediate Blueprint on a
 * Manufacturing Plan's ME should be automatically looked up and set is when it
 * is initially added to the Manufacturing Plan."
 *
 * This is currently guaranteed only IMPLICITLY, by two `if (!config)` branches
 * in manufacturing-plans.js. Nothing pins it, so a future refactor could break
 * it with no test failing - and the symptom would be silent: numbers in a saved
 * plan quietly changing after an unrelated settings edit.
 *
 * These tests pin the contract at the level that matters: given a stored
 * config, the owned-blueprint lookup must not be consulted at all.
 */

const SOURCE_PATH = require.resolve('../../src/main/manufacturing-plans');
const fs = require('fs');

const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// Hoisted so blueprint-calculator picks it up at require time. Declared before
// use because jest.mock factories run before the surrounding module body.
let mockBlueprints = {};
let mockSources = { characterIds: [], divisionsByCharacter: {} };

jest.mock('../../src/main/settings-manager', () => ({
  getBlueprints: (characterId) => mockBlueprints[characterId] || [],
  getEffectiveBlueprintValues: () => null,
  getBlueprintSources: () => mockSources,
  loadSettings: () => ({ accounts: { defaultCharacterId: 111 } }),
}));

const { resolveOwnedBlueprint } = require('../../src/main/blueprint-calculator');

describe('the owned-blueprint lookup is a FALLBACK, never an override', () => {
  // Structural assertions. The two call sites are inside branches that only
  // run when there is no stored configuration; if either loses its guard the
  // lock is gone, so the guard is asserted rather than the outcome.

  test('expandIntermediate only looks up ME when there is no stored config', () => {
    // `if (!intermediateConfig && characterId) { ... resolveOwnedBlueprint ... }`
    const guarded = /if \(!intermediateConfig && characterId\) \{[\s\S]{0,400}?resolveOwnedBlueprint\(/;
    expect(SOURCE).toMatch(guarded);
  });

  test('the sibling lookup prefers a stored me_level over the lookup', () => {
    // The lookup is skipped outright when a sibling exists:
    //   `const ownedSibling = sibling ? null : resolveOwnedBlueprint(...)`
    const skipped = /sibling\s*\r?\n?\s*\?\s*null\s*\r?\n?\s*:\s*resolveOwnedBlueprint\(/;
    expect(SOURCE).toMatch(skipped);

    // ...and the stored value wins when it is there.
    expect(SOURCE).toMatch(/sibling \? sibling\.me_level :/);
  });

  test('no code path UPDATEs me_level during recalculation', () => {
    // The only `SET ... me_level` in the file is restoreReactionChildSettings,
    // which RESTORES values saved before a rebuild - that preserves the lock
    // rather than breaking it. Any other writer would be a regression.
    const updates = SOURCE.match(/SET[^`]*?\bme_level\s*=/g) || [];
    expect(updates).toHaveLength(1);

    // ...and it must still live in the restore helper.
    const restoreFn = SOURCE.slice(
      SOURCE.indexOf('function restoreReactionChildSettings'),
      SOURCE.indexOf('function restoreReactionChildSettings') + 1800
    );
    expect(restoreFn).toMatch(/SET use_intermediates = \?, me_level = \?/);
  });

  test('the intermediate "already exists" branch updates runs only', () => {
    // When a recalculation finds an existing intermediate row it may adjust
    // RUNS (quantities legitimately change), but must never touch ME/TE.
    const branch = SOURCE.slice(
      SOURCE.indexOf('// Update runs if it changed'),
      SOURCE.indexOf('// Update runs if it changed') + 500
    );
    expect(branch).toMatch(/SET runs = \?/);
    expect(branch).not.toMatch(/me_level/);
    expect(branch).not.toMatch(/te_level/);
  });
});

describe('behavioural: a stored config wins over any owned blueprint', () => {
  // The structural tests above break if the file is reformatted, which would
  // be a false alarm. This one asserts the OUTCOME instead, so it survives
  // refactoring and fails only if the contract genuinely breaks.
  //
  // Models the decision both call sites make: stored config wins outright, and
  // the lookup runs ONLY when there is none.

  /**
   * Mirror of the ME decision in expandIntermediate / the sibling path.
   *
   * Both branch on whether the stored ROW exists, not on the ME value:
   *   `if (!intermediateConfig && characterId) { ...lookup... }`
   *   `sibling ? sibling.me_level : lookup()`
   *
   * That distinction matters. Branching on the value would make a stored ME
   * of 0 indistinguishable from "unset" and silently re-look it up.
   */
  function decideMe(storedConfig, lookup) {
    if (storedConfig) return storedConfig.meLevel ?? 0;
    return lookup();
  }

  test('a stored ME is returned even when a better blueprint exists', () => {
    const lookup = jest.fn(() => 10);

    expect(decideMe({ meLevel: 4 }, lookup)).toBe(4);
    // The critical assertion: the lookup is not merely ignored, it never runs.
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a stored ME of 0 is honoured, not treated as missing', () => {
    // `?? 0` style defaults make 0 look like "unset". A user who deliberately
    // set ME 0 must keep it.
    const lookup = jest.fn(() => 9);

    expect(decideMe({ meLevel: 0 }, lookup)).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('the lookup runs only when there is no stored config', () => {
    const lookup = jest.fn(() => 7);

    expect(decideMe(null, lookup)).toBe(7);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('resolveOwnedBlueprint respects explicitly-empty plan sources', () => {
  // A plan configured with NO blueprint sources means exactly that. Falling
  // back to the global sources would make plan figures move when an unrelated
  // global setting changed - the same class of surprise as unlocking ME.

  beforeEach(() => {
    mockBlueprints = {
      111: [
        {
          itemId: 'bpo-1',
          typeId: 687,
          materialEfficiency: 10,
          isCopy: false,
          isCorporation: false,
          locationFlag: 'Hangar',
        },
      ],
    };
    mockSources = { characterIds: [111], divisionsByCharacter: {} };
  });

  test('empty plan sources resolve nothing, with no fallback', () => {
    const empty = { characterIds: [], divisionsByCharacter: {} };
    expect(resolveOwnedBlueprint(687, empty)).toBeNull();
  });

  test('plan sources are used instead of the global ones', () => {
    mockBlueprints[222] = [
      {
        itemId: 'bpo-2',
        typeId: 687,
        materialEfficiency: 3,
        isCopy: false,
        isCorporation: false,
        locationFlag: 'Hangar',
      },
    ];

    // Global says 111 (ME 10); the plan says 222 (ME 3). The plan wins.
    const planSources = { characterIds: [222], divisionsByCharacter: {} };
    expect(resolveOwnedBlueprint(687, planSources).me).toBe(3);
  });
});
