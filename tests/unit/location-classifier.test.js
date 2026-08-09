/**
 * Location ID classification.
 *
 * This module exists because the previous classifier COULD NOT return
 * 'structure' - player structures and asset item_ids share the >= 1 trillion
 * range - yet two branches downstream compared against exactly that value and
 * were therefore dead. The symptom was an item nested inside a container at a
 * player structure resolving to "Unknown", while a top-level item at the SAME
 * structure resolved fine.
 *
 * The fix is the ownItemIds argument. These tests pin that it is what makes the
 * distinction possible, and that ranges match docs/eve-id-ranges.md.
 */

const { classify, isTerminal, ASSET_SAFETY_ID, SPAWNED_ITEM_MIN } = require('../../src/main/location-classifier');

describe('the structure-vs-container distinction', () => {
  // The whole reason this module exists.
  const STRUCTURE_ID = 1035466617946;
  const OUR_SHIP_ID = 1040000000001;
  const ownItemIds = new Set([OUR_SHIP_ID]);

  test('a >= 1T id that is NOT one of our items is a structure', () => {
    expect(classify(STRUCTURE_ID, ownItemIds)).toBe('structure');
  });

  test('a >= 1T id that IS one of our items is a container', () => {
    expect(classify(OUR_SHIP_ID, ownItemIds)).toBe('own-container');
  });

  test('a structure is terminal; a container is not', () => {
    // The walk must stop at a structure and keep going through a container.
    expect(isTerminal(classify(STRUCTURE_ID, ownItemIds))).toBe(true);
    expect(isTerminal(classify(OUR_SHIP_ID, ownItemIds))).toBe(false);
  });

  test('without the item-id set it refuses to guess', () => {
    // Reporting 'structure' here would resurrect the original bug in reverse:
    // our own containers would be sent to ESI as if they were structures.
    expect(classify(STRUCTURE_ID, null)).toBe('structure-or-container');
    expect(isTerminal('structure-or-container')).toBe(false);
  });

  test('the same id flips meaning with the set it is given', () => {
    const id = SPAWNED_ITEM_MIN + 5;
    expect(classify(id, new Set([id]))).toBe('own-container');
    expect(classify(id, new Set())).toBe('structure');
  });
});

describe('ID ranges (docs/eve-id-ranges.md)', () => {
  const empty = new Set();

  test('NPC stations are ONLY 60,000,000-60,999,999', () => {
    expect(classify(60000000, empty)).toBe('npc-station');
    expect(classify(60003760, empty)).toBe('npc-station'); // Jita 4-4
    expect(classify(60999999, empty)).toBe('npc-station');
    // 61M+ are outposts, NOT NPC stations - they do not resolve via staStations.
    expect(classify(61000000, empty)).not.toBe('npc-station');
  });

  test('solar systems span five sub-ranges, not one block', () => {
    expect(classify(30000142, empty)).toBe('system'); // known space (Jita)
    expect(classify(31000001, empty)).toBe('system'); // wormhole
    expect(classify(32000001, empty)).toBe('system'); // abyssal
    expect(classify(34000001, empty)).toBe('system'); // void
    expect(classify(36000001, empty)).toBe('system'); // hidden
  });

  test('33M and 35M are unallocated and are not systems', () => {
    // A naive 30M-36M range check would wrongly claim these.
    expect(classify(33000001, empty)).toBe('unknown');
    expect(classify(35000001, empty)).toBe('unknown');
  });

  test('outposts and station folders are distinguished, not lumped in', () => {
    expect(classify(61000123, empty)).toBe('outpost');
    expect(classify(63999999, empty)).toBe('outpost');
    expect(classify(66001234, empty)).toBe('station-folder');
    expect(classify(69999999, empty)).toBe('station-folder');
  });

  test('asset safety is its own fixed location', () => {
    expect(classify(ASSET_SAFETY_ID, empty)).toBe('asset-safety');
    expect(isTerminal('asset-safety')).toBe(true);
  });

  test('a station folder is a container, so the walk must not stop there', () => {
    expect(isTerminal(classify(66001234, empty))).toBe(false);
  });
});

describe('ownership beats range (regression: containers sent to ESI as structures)', () => {
  // THE BUG: the assets table stores `item_id` as TEXT and `location_id` as
  // INTEGER. classify() coerced the location to a Number and then did
  // ownItemIds.has(number) against a Set built from the TEXT column.
  // `Set.has` is strict-equality, so it NEVER matched, and every one of our own
  // containers - ships, cans, hangar boxes - was classified 'structure'.
  //
  // Each of those then went to ESI's /universe/structures/ endpoint, earned a
  // 403 (a ship is not a structure), and got cached as a 7-day access denial.
  // A single Assets load poisoned the cache with 70 bogus denials and spent the
  // application-wide error budget - the exact failure this layer exists to
  // prevent.
  //
  // The old tests passed because their fixtures used NUMERIC item ids. These
  // use the real TEXT shape.

  test('a container whose id is stored as TEXT is still recognised as ours', () => {
    const golemId = 1040208179061;
    const asStoredBySqlite = new Set(['1040208179061']); // TEXT, as the DB returns

    expect(classify(golemId, asStoredBySqlite)).toBe('own-container');
  });

  test('a legacy sub-1-trillion container is ours, despite the range', () => {
    // Ships and containers created before the 2010 id migration sit in the
    // hundreds of millions, well below the spawned-item floor. Testing range
    // before ownership classified them 'unknown', so the walk could not
    // recognise them.
    const legacyShipId = 574021976;
    expect(legacyShipId).toBeLessThan(SPAWNED_ITEM_MIN);

    expect(classify(legacyShipId, new Set([legacyShipId]))).toBe('own-container');
  });

  test('a legacy id that is NOT ours keeps its range-based classification', () => {
    // The ownership check must not swallow ids we do not own.
    expect(classify(60003760, new Set([999]))).toBe('npc-station');
    expect(classify(30000142, new Set([999]))).toBe('system');
  });

  test('ownership is checked before EVERY range, not just the >= 1T branch', () => {
    // A station id that somehow appears as one of our item_ids is still a
    // container to walk through - ownership is the stronger signal.
    const stationRangeId = 60003760;
    expect(classify(stationRangeId, new Set([stationRangeId]))).toBe('own-container');
  });

  test('mixed TEXT and numeric ids in one set both match', () => {
    const mixed = new Set(['1040208179061', 1050670708458]);
    expect(classify(1040208179061, mixed)).toBe('own-container');
    expect(classify(1050670708458, mixed)).toBe('own-container');
  });
});

describe('bad input', () => {
  test.each([
    [null, 'null'],
    [undefined, 'undefined'],
    [0, 'zero'],
    [-1, 'negative'],
    ['not-a-number', 'non-numeric string'],
    [NaN, 'NaN'],
  ])('%s (%s) is unknown, not a crash', (input) => {
    expect(classify(input, new Set())).toBe('unknown');
  });

  test('numeric strings are accepted (SQLite can hand back either)', () => {
    expect(classify('60003760', new Set())).toBe('npc-station');
  });
});
