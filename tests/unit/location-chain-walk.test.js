/**
 * Asset location chain walking.
 *
 * An asset's location_id is a chain, not a place: it may point at a station, a
 * system, a player structure, or at the item_id of another asset (ship,
 * container, hangar) which itself has a location_id.
 * See https://docs.esi.evetech.net/docs/asset_location_id.html
 *
 * THE BUG THESE TESTS PIN: the old walk terminated on
 *   `type === 'npc-station' || type === 'structure'`
 * but its classifier could never return 'structure'. Anything nested inside a
 * container at a player structure fell through to a fallthrough branch that
 * produced `locationType: 'asset'`, which the name resolver had no case for -
 * so it resolved to "Unknown". A top-level item at the SAME structure worked,
 * which is what made this so confusing to observe.
 */

// location-resolver pulls in Electron-dependent modules at load time; the walk
// itself is pure, so stub the I/O modules out.
jest.mock('../../src/main/esi-assets', () => ({ getAssets: () => [] }));
jest.mock('../../src/main/sde-database', () => ({
  getLocationName: jest.fn(async () => null),
  getSystemNameFromStation: jest.fn(async () => null),
  getSystemName: jest.fn(async () => null),
  getTypeName: jest.fn(async () => 'Container'),
}));

const {
  walkChain, findUltimateLocation, indexAssets,
} = require('../../src/main/location-resolver');

/**
 * Build the index the way the app does.
 *
 * Uses the REAL indexAssets rather than a hand-rolled Map/Set, because a
 * hand-rolled one is exactly what hid the production bug: the assets table
 * stores `item_id` as TEXT and `location_id` as INTEGER, and a fixture that
 * used numeric ids for both made a broken classifier look correct.
 */
function index(assets) {
  return indexAssets(assets);
}

/** Fixtures in the REAL storage shape: item_id TEXT, location_id INTEGER. */
function asStored(assets) {
  return assets.map((a) => ({ ...a, itemId: String(a.itemId) }));
}

const STRUCTURE_ID = 1035466617946;
const NPC_STATION_ID = 60003760; // Jita 4-4
const SYSTEM_ID = 30000142;      // Jita

describe('the regression: nesting at a player structure', () => {
  // container -> ship -> player structure
  const assets = [
    { itemId: 1040000000001, typeId: 11488, locationId: STRUCTURE_ID, locationFlag: 'Hangar' },
    { itemId: 1040000000002, typeId: 3465, locationId: 1040000000001, locationFlag: 'Cargo' },
  ];

  test('a nested item resolves to the STRUCTURE, not to "asset"', () => {
    const result = walkChain(1040000000002, index(assets));

    expect(result.terminalKind).toBe('structure');
    expect(result.terminalId).toBe(STRUCTURE_ID);
  });

  test('it walks through every container on the way', () => {
    const result = walkChain(1040000000002, index(assets));
    expect(result.containerPath).toHaveLength(2);
  });

  test('nested and top-level items at the same structure agree', () => {
    // The old code disagreed: top-level worked, nested said "Unknown".
    const nested = walkChain(1040000000002, index(assets));
    const topLevel = walkChain(STRUCTURE_ID, index(assets));

    expect(nested.terminalId).toBe(topLevel.terminalId);
    expect(nested.terminalKind).toBe(topLevel.terminalKind);
  });
});

describe('terminating at each kind of real place', () => {
  test('NPC station', () => {
    const assets = [{ itemId: 1040000000001, typeId: 11488, locationId: NPC_STATION_ID }];
    const result = walkChain(1040000000001, index(assets));
    expect(result.terminalKind).toBe('npc-station');
    expect(result.terminalId).toBe(NPC_STATION_ID);
  });

  test('solar system (e.g. a ship in space)', () => {
    const assets = [{ itemId: 1040000000001, typeId: 11488, locationId: SYSTEM_ID }];
    expect(walkChain(1040000000001, index(assets)).terminalKind).toBe('system');
  });

  test('asset safety', () => {
    const assets = [{ itemId: 1040000000001, typeId: 11488, locationId: 2004 }];
    expect(walkChain(1040000000001, index(assets)).terminalKind).toBe('asset-safety');
  });

  test('a location that is already terminal needs no walking', () => {
    const result = walkChain(NPC_STATION_ID, index([]));
    expect(result.terminalKind).toBe('npc-station');
    expect(result.containerPath).toHaveLength(0);
  });
});

describe('deep and awkward chains', () => {
  test('walks a five-deep chain to the station', () => {
    const assets = [];
    for (let i = 1; i <= 5; i += 1) {
      assets.push({
        itemId: 1040000000000 + i,
        typeId: 3465,
        locationId: i === 1 ? NPC_STATION_ID : 1040000000000 + (i - 1),
      });
    }

    const result = walkChain(1040000000005, index(assets));
    expect(result.terminalKind).toBe('npc-station');
    expect(result.containerPath).toHaveLength(5);
  });

  test('a circular chain breaks out instead of hanging', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const assets = [
      { itemId: 111, typeId: 1, locationId: 222 },
      { itemId: 222, typeId: 1, locationId: 111 },
    ];

    const result = walkChain(111, index(assets));

    expect(result).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Circular reference'));
    warn.mockRestore();
  });

  test('a dangling parent reports the id it stopped at rather than throwing', () => {
    // The container is not in our asset list (not fetched, or corp-owned).
    const assets = [{ itemId: 1040000000002, typeId: 3465, locationId: 1040000000999 }];
    const result = walkChain(1040000000002, index(assets));

    expect(result.terminalId).toBe(1040000000999);
    // Not in our items, so it reads as a structure - which is the right guess:
    // it is a >= 1T id we do not own.
    expect(result.terminalKind).toBe('structure');
  });

  test('containerPath is ordered outermost-first', () => {
    const assets = [
      { itemId: 1040000000001, typeId: 11488, locationId: NPC_STATION_ID },
      { itemId: 1040000000002, typeId: 3465, locationId: 1040000000001 },
    ];

    const { containerPath } = walkChain(1040000000002, index(assets));
    expect(containerPath.map((c) => c.itemId)).toEqual([1040000000001, 1040000000002]);
  });
});

describe('regression: our own containers must never reach ESI', () => {
  // Reproduces the reported failure with the user's real ids. A Golem
  // (1040208179061) holding 29 items, inside a structure (1050080670181).
  //
  // item_id comes back from SQLite as TEXT while location_id is INTEGER, so the
  // Set lookup missed and the Golem was classified 'structure'. It was then
  // sent to /universe/structures/, answered 403, and was cached as a 7-day
  // access denial. 70 such rows were written from a single Assets load.
  const GOLEM = 1040208179061;
  const OTHER_SHIP = 1050670708458;
  const STRUCTURE = 1050080670181;

  const fleet = asStored([
    { itemId: GOLEM, typeId: 28710, locationId: STRUCTURE, locationFlag: 'Hangar' },
    { itemId: OTHER_SHIP, typeId: 17366, locationId: STRUCTURE, locationFlag: 'Hangar' },
    { itemId: 1040000000900, typeId: 3465, locationId: GOLEM, locationFlag: 'Cargo' },
  ]);

  test('an item inside our ship terminates at the STRUCTURE, not the ship', () => {
    const result = walkChain(1040000000900, index(fleet));

    expect(result.terminalId).toBe(STRUCTURE);
    expect(result.terminalKind).toBe('structure');
  });

  test('the ship itself is never a terminal, so it is never looked up', () => {
    // If this regresses, a ship gets sent to ESI's structure endpoint.
    const result = walkChain(GOLEM, index(fleet));

    expect(result.terminalId).toBe(STRUCTURE);
    expect(result.terminalKind).toBe('structure');
    expect(result.terminalId).not.toBe(GOLEM);
  });

  test('every own container in a fleet resolves to one structure lookup', () => {
    // 3 assets, 2 of them containers, but only ONE distinct structure.
    const terminals = new Set(
      fleet.map((a) => walkChain(a.locationId, index(fleet)).terminalId)
    );

    expect([...terminals]).toEqual([STRUCTURE]);
  });

  test('a legacy sub-1T ship is walked through, not looked up', () => {
    // Pre-2010 ids sit in the hundreds of millions, below the spawned-item
    // floor, and used to classify as 'unknown'.
    const legacy = asStored([
      { itemId: 574021976, typeId: 24445, locationId: 60003760, locationFlag: 'Hangar' },
      { itemId: 1040000000901, typeId: 3465, locationId: 574021976, locationFlag: 'Cargo' },
    ]);

    const result = walkChain(1040000000901, index(legacy));

    expect(result.terminalKind).toBe('npc-station');
    expect(result.terminalId).toBe(60003760);
  });
});

describe('indexAssets normalises the TEXT/INTEGER split', () => {
  test('a TEXT item_id is indexed as a Number', () => {
    const idx = indexAssets([{ itemId: '1040208179061', typeId: 1, locationId: 60003760 }]);

    expect(idx.itemIds.has(1040208179061)).toBe(true);
    expect(idx.byItemId.get(1040208179061)).toBeDefined();
  });

  test('locationId is normalised too, so the next hop matches', () => {
    const idx = indexAssets([{ itemId: '1', typeId: 1, locationId: '60003760' }]);

    expect(idx.byItemId.get(1).locationId).toBe(60003760);
  });

  test('a malformed id is skipped rather than poisoning the index', () => {
    const idx = indexAssets([
      { itemId: 'not-a-number', typeId: 1, locationId: 60003760 },
      { itemId: '42', typeId: 1, locationId: 60003760 },
    ]);

    expect(idx.itemIds.has(42)).toBe(true);
    expect(idx.itemIds.size).toBe(1);
  });
});

describe('findUltimateLocation (legacy array-taking wrapper)', () => {
  test('still accepts a plain assets array', () => {
    const assets = [
      { itemId: 1040000000001, typeId: 11488, locationId: STRUCTURE_ID },
      { itemId: 1040000000002, typeId: 3465, locationId: 1040000000001 },
    ];

    const result = findUltimateLocation(1040000000002, assets);

    expect(result.locationId).toBe(STRUCTURE_ID);
    expect(result.locationType).toBe('structure');
    expect(result.containerPath).toHaveLength(2);
  });

  test('survives an empty asset list', () => {
    expect(findUltimateLocation(NPC_STATION_ID, []).locationType).toBe('npc-station');
  });
});
