/**
 * getPlanPriceOverrides - the Settings tab's override list.
 *
 * REGRESSION: this query still selected `last_market_price` from
 * plan_price_overrides after migration 025 moved that column onto
 * plan_material_nodes. Every call threw "no such column", and because the
 * function catches its own errors and returns [], the Settings tab simply
 * showed NO overrides - no error surfaced to the user, and no test caught it.
 *
 * That swallow-and-return-empty shape is why these tests assert on real rows
 * rather than "did not throw": an empty list is exactly what the bug produced.
 */

const RealDatabase = require('better-sqlite3');

let mockDb;
jest.mock('../../src/main/character-database', () => ({
  getCharacterDatabase: jest.fn(() => mockDb),
}));

const { getPlanPriceOverrides } = require('../../src/main/manufacturing-plans');

/**
 * Post-migration-025 schema.
 *
 * plan_price_overrides deliberately has NO last_market_price column - that is
 * the whole point. If this fixture ever grows one, the test stops guarding
 * anything.
 */
function buildSchema(db) {
  db.exec(`
    CREATE TABLE manufacturing_plans (
      plan_id TEXT PRIMARY KEY,
      plan_name TEXT NOT NULL
    );
    CREATE TABLE plan_price_overrides (
      plan_id TEXT NOT NULL,
      type_id INTEGER NOT NULL,
      price REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plan_id, type_id)
    );
    CREATE TABLE plan_material_nodes (
      node_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      type_id INTEGER NOT NULL,
      price_each REAL,
      last_market_price REAL,
      price_frozen_at INTEGER
    );
  `);
}

beforeEach(() => {
  mockDb = new RealDatabase(':memory:');
  buildSchema(mockDb);

  mockDb.prepare('INSERT INTO manufacturing_plans VALUES (?, ?)').run('plan-1', 'Test Plan');

  const override = mockDb.prepare(
    'INSERT INTO plan_price_overrides VALUES (?, ?, ?, ?, ?)'
  );
  override.run('plan-1', 34, 7.5, 1000, 3000);
  override.run('plan-1', 35, 12.0, 1000, 2000);

  const node = mockDb.prepare(
    'INSERT INTO plan_material_nodes VALUES (?, ?, ?, ?, ?, ?)'
  );
  // Tritanium: overridden AND previously locked, so a snapshot exists.
  node.run('node-1', 'plan-1', 34, 7.5, 5.25, 900);
  // Pyerite: overridden but never locked - snapshot is null.
  node.run('node-2', 'plan-1', 35, 12.0, null, null);
});

afterEach(() => mockDb.close());

describe('getPlanPriceOverrides', () => {
  test('returns the plan overrides', () => {
    const rows = getPlanPriceOverrides('plan-1');

    // The bug returned [] here, silently.
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.typeId).sort()).toEqual([34, 35]);
  });

  test('reads last_market_price from the NODE, not the override row', () => {
    const rows = getPlanPriceOverrides('plan-1');
    const tritanium = rows.find(r => r.typeId === 34);

    expect(tritanium.price).toBe(7.5);
    expect(tritanium.lastMarketPrice).toBe(5.25);
  });

  test('an override with no lock yet reports a null snapshot', () => {
    const rows = getPlanPriceOverrides('plan-1');
    const pyerite = rows.find(r => r.typeId === 35);

    expect(pyerite.price).toBe(12.0);
    expect(pyerite.lastMarketPrice).toBeNull();
  });

  test('an override with NO node row is still listed', () => {
    // An override can be set for a type that has no node (or whose nodes were
    // rebuilt). An inner join would silently drop it from the Settings tab.
    mockDb.prepare('INSERT INTO plan_price_overrides VALUES (?, ?, ?, ?, ?)')
      .run('plan-1', 36, 99.0, 1000, 4000);

    const rows = getPlanPriceOverrides('plan-1');
    const orphan = rows.find(r => r.typeId === 36);

    expect(orphan).toBeDefined();
    expect(orphan.price).toBe(99.0);
    expect(orphan.lastMarketPrice).toBeNull();
  });

  test('orders by most recently updated', () => {
    const rows = getPlanPriceOverrides('plan-1');
    expect(rows[0].typeId).toBe(34); // updated_at 3000
    expect(rows[1].typeId).toBe(35); // updated_at 2000
  });

  test('does not leak overrides from another plan', () => {
    mockDb.prepare('INSERT INTO manufacturing_plans VALUES (?, ?)').run('plan-2', 'Other');
    mockDb.prepare('INSERT INTO plan_price_overrides VALUES (?, ?, ?, ?, ?)')
      .run('plan-2', 34, 1.0, 1000, 5000);

    const rows = getPlanPriceOverrides('plan-1');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.price !== 1.0)).toBe(true);
  });

  test('a plan with no overrides returns an empty list', () => {
    mockDb.prepare('INSERT INTO manufacturing_plans VALUES (?, ?)').run('plan-3', 'Empty');
    expect(getPlanPriceOverrides('plan-3')).toEqual([]);
  });

  test('duplicate node rows do not duplicate the override', () => {
    // Nodes are per-blueprint, so one type can appear several times in a plan.
    // The subquery takes one snapshot; a join would multiply the rows.
    mockDb.prepare('INSERT INTO plan_material_nodes VALUES (?, ?, ?, ?, ?, ?)')
      .run('node-3', 'plan-1', 34, 7.5, 5.25, 900);

    const rows = getPlanPriceOverrides('plan-1');
    expect(rows.filter(r => r.typeId === 34)).toHaveLength(1);
  });
});
