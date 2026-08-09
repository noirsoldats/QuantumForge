/**
 * Corp hangar division helper.
 *
 * THE RULE: a corp item is used only when it can be attributed to an ENABLED
 * division. No divisions configured -> nothing. Unparseable flag -> that item
 * is out. Assets and blueprints, every tool, no exceptions.
 *
 * This replaced two copies that had drifted apart - cleanup-tool.js included
 * corp items when no divisions were configured or the flag would not parse.
 * That was a bug, and these tests pin the corrected behaviour, because a wrong
 * answer here is invisible in the UI: items simply appear or vanish.
 */

const {
  divisionFromLocationFlag,
  isInEnabledDivision,
  unionDivisionsByCorp,
} = require('../../src/main/corp-divisions');

describe('divisionFromLocationFlag', () => {
  test('parses every valid corp hangar division', () => {
    for (let i = 1; i <= 7; i += 1) {
      expect(divisionFromLocationFlag(`CorpSAG${i}`)).toBe(i);
    }
  });

  test('rejects divisions outside 1-7', () => {
    // EVE has exactly seven corp hangar divisions.
    expect(divisionFromLocationFlag('CorpSAG0')).toBeNull();
    expect(divisionFromLocationFlag('CorpSAG8')).toBeNull();
    expect(divisionFromLocationFlag('CorpSAG9')).toBeNull();
  });

  test('is anchored - a longer flag is not a partial match', () => {
    // The previous unanchored /CorpSAG(\d)/ read "CorpSAG12" as division 1 and
    // "XCorpSAG3" as division 3. Both are wrong and both silently mis-filed
    // assets into a division the user may have enabled.
    expect(divisionFromLocationFlag('CorpSAG12')).toBeNull();
    expect(divisionFromLocationFlag('XCorpSAG3')).toBeNull();
    expect(divisionFromLocationFlag('CorpSAG1Extra')).toBeNull();
  });

  test('returns null for non-hangar and malformed flags', () => {
    expect(divisionFromLocationFlag('CorpDeliveries')).toBeNull();
    expect(divisionFromLocationFlag('Hangar')).toBeNull();
    expect(divisionFromLocationFlag('')).toBeNull();
    expect(divisionFromLocationFlag(null)).toBeNull();
    expect(divisionFromLocationFlag(undefined)).toBeNull();
    expect(divisionFromLocationFlag(42)).toBeNull();
  });
});

describe('isInEnabledDivision', () => {
  test('an enabled division is included', () => {
    expect(isInEnabledDivision('CorpSAG2', [1, 2, 3])).toBe(true);
    expect(isInEnabledDivision('CorpSAG1', [1])).toBe(true);
  });

  test('a division that is not enabled is excluded', () => {
    expect(isInEnabledDivision('CorpSAG5', [1, 2, 3])).toBe(false);
    expect(isInEnabledDivision('CorpSAG7', [1])).toBe(false);
  });

  test('no divisions configured means NO corp items', () => {
    // Not "include everything" - the user has opted into nothing.
    expect(isInEnabledDivision('CorpSAG1', [])).toBe(false);
    expect(isInEnabledDivision('CorpSAG1', null)).toBe(false);
    expect(isInEnabledDivision('CorpSAG1', undefined)).toBe(false);
  });

  test('an unattributable flag is excluded even with divisions enabled', () => {
    // Deliveries, containers, ship holds: real corp locations, but not a
    // numbered hangar, so there is no division to check against.
    expect(isInEnabledDivision('CorpDeliveries', [1, 2, 3, 4, 5, 6, 7])).toBe(false);
    expect(isInEnabledDivision('Hangar', [1])).toBe(false);
    expect(isInEnabledDivision(null, [1])).toBe(false);
    expect(isInEnabledDivision('', [1])).toBe(false);
  });

  test('a mis-parseable flag cannot sneak into an enabled division', () => {
    // With the old unanchored regex "CorpSAG12" read as division 1, so a user
    // with division 1 enabled silently picked up items from a location that
    // is not division 1 at all.
    expect(isInEnabledDivision('CorpSAG12', [1])).toBe(false);
    expect(isInEnabledDivision('XCorpSAG3', [3])).toBe(false);
  });
});

describe('unionDivisionsByCorp', () => {
  // Corp items are stored once per character who can SEE them (both tables are
  // keyed on (character_id, item_id)), so reading every character's corp rows
  // double-counts. The previous guard deduped by skipping a corp after the
  // first character - which silently adopted that character's division list and
  // discarded everyone else's.

  test('collapses several characters in one corp to a single read', () => {
    const result = unionDivisionsByCorp([
      { characterId: 111, corporationId: 900, divisions: [1] },
      { characterId: 222, corporationId: 900, divisions: [1] },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].corporationId).toBe(900);
    expect(result[0].divisions).toEqual([1]);
  });

  test('unions divisions rather than taking the first character\'s', () => {
    // A enables 1; B enables 1 and 2. Division 2 must survive.
    const result = unionDivisionsByCorp([
      { characterId: 111, corporationId: 900, divisions: [1] },
      { characterId: 222, corporationId: 900, divisions: [1, 2] },
    ]);

    expect(result[0].divisions).toEqual([1, 2]);
  });

  test('the union does not depend on iteration order', () => {
    const forward = unionDivisionsByCorp([
      { characterId: 111, corporationId: 900, divisions: [3] },
      { characterId: 222, corporationId: 900, divisions: [1, 7] },
    ]);
    const backward = unionDivisionsByCorp([
      { characterId: 222, corporationId: 900, divisions: [1, 7] },
      { characterId: 111, corporationId: 900, divisions: [3] },
    ]);

    expect(forward[0].divisions).toEqual([1, 3, 7]);
    expect(backward[0].divisions).toEqual([1, 3, 7]);
  });

  test('keeps separate corporations separate', () => {
    const result = unionDivisionsByCorp([
      { characterId: 111, corporationId: 900, divisions: [1] },
      { characterId: 222, corporationId: 901, divisions: [4] },
    ]);

    expect(result).toHaveLength(2);
    expect(result.find((c) => c.corporationId === 900).divisions).toEqual([1]);
    expect(result.find((c) => c.corporationId === 901).divisions).toEqual([4]);
  });

  test('a character with no divisions contributes nothing but does not erase others', () => {
    const result = unionDivisionsByCorp([
      { characterId: 111, corporationId: 900, divisions: [] },
      { characterId: 222, corporationId: 900, divisions: [5] },
    ]);

    expect(result[0].divisions).toEqual([5]);
  });

  test('names one character as the reader for the corp', () => {
    // The corp's rows are identical across its characters, so exactly one is
    // read - that is what removes the duplication.
    const result = unionDivisionsByCorp([
      { characterId: 111, corporationId: 900, divisions: [1] },
      { characterId: 222, corporationId: 900, divisions: [2] },
    ]);

    expect([111, 222]).toContain(result[0].readerCharacterId);
  });

  test('skips entries with no corporation', () => {
    const result = unionDivisionsByCorp([
      { characterId: 111, corporationId: null, divisions: [1] },
      { characterId: 222, corporationId: undefined, divisions: [2] },
    ]);

    expect(result).toEqual([]);
  });

  test('handles empty and missing input', () => {
    expect(unionDivisionsByCorp([])).toEqual([]);
    expect(unionDivisionsByCorp(null)).toEqual([]);
    expect(unionDivisionsByCorp(undefined)).toEqual([]);
  });
});

describe('callers apply the shared rule', () => {
  const { isAssetInEnabledDivision: cleanupCheck } = require('../../src/main/cleanup-tool');

  test('the cleanup tool now fails closed too', () => {
    // BEHAVIOUR CHANGE, deliberate: this tool used to include corp assets when
    // no divisions were configured or the flag would not parse.
    expect(cleanupCheck({ locationFlag: 'CorpSAG1' }, [])).toBe(false);
    expect(cleanupCheck({ locationFlag: 'CorpDeliveries' }, [1])).toBe(false);
    expect(cleanupCheck({ locationFlag: 'CorpSAG5' }, [1, 2])).toBe(false);
    // ...and still includes what it should.
    expect(cleanupCheck({ locationFlag: 'CorpSAG2' }, [1, 2])).toBe(true);
  });

  test('cleanup tool re-exports the parser under its old name', () => {
    const { extractDivisionId } = require('../../src/main/cleanup-tool');
    expect(extractDivisionId('CorpSAG3')).toBe(3);
  });
});
