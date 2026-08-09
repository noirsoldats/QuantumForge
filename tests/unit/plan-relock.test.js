/**
 * getPlansUsingType + relockPlanMaterialPrice (in-memory better-sqlite3).
 *
 * These back the Market Manager inspector's "Plans using <item>" section.
 * The re-lock semantics are deliberately narrow and worth pinning:
 *
 *   - it updates ONE material in ONE plan, never other plans or other types
 *   - it never creates a plan_price_overrides row (a re-lock captures the
 *     market; an override pins a manual price)
 *   - it behaves exactly as a full "Refresh Prices" does for that one item:
 *     with an override set, price_each keeps the override while
 *     price_frozen_at and last_market_price both advance
 */

const RealDatabase = require('better-sqlite3');

let mockDb;
jest.mock('../../src/main/character-database', () => ({
  getCharacterDatabase: jest.fn(() => mockDb),
}));

const {
  getPlansUsingType,
  relockPlanMaterialPrice,
} = require('../../src/main/manufacturing-plans');

/** Minimal slice of the schema these two functions touch. */
function buildSchema(db) {
  db.exec(`
    CREATE TABLE manufacturing_plans (
      plan_id TEXT PRIMARY KEY,
      character_id INTEGER,
      plan_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE plan_material_nodes (
      node_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      type_id INTEGER NOT NULL,
      node_type TEXT NOT NULL DEFAULT 'material',
      quantity_needed REAL,
      price_each REAL,
      last_market_price REAL,
      price_frozen_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );
    -- Post-migration-025 shape: last_market_price lives on the NODE, not here.
    CREATE TABLE plan_price_overrides (
      plan_id TEXT NOT NULL,
      type_id INTEGER NOT NULL,
      price REAL NOT NULL,
      created_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (plan_id, type_id)
    );
  `);
}

function addPlan(id, name, status = 'active') {
  mockDb.prepare(
    'INSERT INTO manufacturing_plans (plan_id, plan_name, status) VALUES (?, ?, ?)'
  ).run(id, name, status);
}

/**
 * A node as a market lock would leave it: price_each and last_market_price both
 * hold the locked market price, paired with price_frozen_at.
 */
function addNode(nodeId, planId, typeId, price, qty = 100, frozenAt = 1000, nodeType = 'material') {
  mockDb.prepare(`
    INSERT INTO plan_material_nodes
      (node_id, plan_id, type_id, node_type, quantity_needed, price_each, last_market_price, price_frozen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nodeId, planId, typeId, nodeType, qty, price, price, frozenAt);
}

/** The market snapshot recorded on a node. */
function nodeSnapshot(nodeId) {
  return mockDb.prepare('SELECT last_market_price FROM plan_material_nodes WHERE node_id = ?')
    .get(nodeId).last_market_price;
}

function nodePrice(nodeId) {
  return mockDb.prepare('SELECT price_each FROM plan_material_nodes WHERE node_id = ?')
    .get(nodeId).price_each;
}

beforeEach(() => {
  mockDb = new RealDatabase(':memory:');
  buildSchema(mockDb);
});

afterEach(() => {
  mockDb.close();
});

describe('getPlansUsingType', () => {
  test('returns every plan referencing the type, with its locked price', () => {
    addPlan('p1', 'Capital Build');
    addPlan('p2', 'Ammo Run');
    addNode('n1', 'p1', 34, 5.42);
    addNode('n2', 'p2', 34, 5.10);

    const plans = getPlansUsingType(34);

    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.planName)).toEqual(['Ammo Run', 'Capital Build']);
    expect(plans.find((p) => p.planId === 'p1').lockedPrice).toBe(5.42);
  });

  test('returns nothing for a type no plan uses', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42);

    expect(getPlansUsingType(35)).toEqual([]);
  });

  test('collapses multiple nodes of the same type into one row per plan', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100);
    addNode('n2', 'p1', 34, 5.42, 250);

    const plans = getPlansUsingType(34);

    expect(plans).toHaveLength(1);
    expect(plans[0].quantity).toBe(350);
  });

  test('reports the most recent freeze timestamp', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000);
    addNode('n2', 'p1', 34, 5.42, 100, 9999);

    expect(getPlansUsingType(34)[0].lockedAt).toBe(9999);
  });

  test('flags a plan whose price is a user override', () => {
    addPlan('p1', 'Pinned');
    addPlan('p2', 'Market');
    addNode('n1', 'p1', 34, 9.99);
    addNode('n2', 'p2', 34, 5.42);
    mockDb.prepare(
      'INSERT INTO plan_price_overrides (plan_id, type_id, price) VALUES (?, ?, ?)'
    ).run('p1', 34, 9.99);

    const plans = getPlansUsingType(34);

    expect(plans.find((p) => p.planId === 'p1').isOverride).toBe(true);
    expect(plans.find((p) => p.planId === 'p2').isOverride).toBe(false);
  });

  test('returns the market snapshot behind an override, for accurate drift', () => {
    // While an override is active, price_each is the OVERRIDE, so drift against
    // the live market must be measured from last_market_price - the price
    // captured by the most recent lock, paired with price_frozen_at.
    addPlan('p1', 'Pinned');
    // A lock recorded 5.42, then the user pinned 9.99 over it.
    addNode('n1', 'p1', 34, 5.42);
    mockDb.prepare(
      'INSERT INTO plan_price_overrides (plan_id, type_id, price) VALUES (?, ?, ?)'
    ).run('p1', 34, 9.99);
    mockDb.prepare('UPDATE plan_material_nodes SET price_each = 9.99 WHERE node_id = ?').run('n1');

    const plan = getPlansUsingType(34)[0];

    expect(plan.lockedPrice).toBe(9.99);
    expect(plan.lastMarketPrice).toBe(5.42);
  });

  test('lastMarketPrice is recorded even without an override', () => {
    // The snapshot lives on the node, so ANY lock records it - that is what
    // makes a later override + removal revert correctly.
    addPlan('p1', 'Market');
    addNode('n1', 'p1', 34, 5.42);

    expect(getPlansUsingType(34)[0].lastMarketPrice).toBe(5.42);
  });

  test('includes the plan status so the UI can distinguish archived plans', () => {
    addPlan('p1', 'Old Plan', 'archived');
    addNode('n1', 'p1', 34, 5.42);

    expect(getPlansUsingType(34)[0].status).toBe('archived');
  });
});

describe('relockPlanMaterialPrice', () => {
  test('updates the locked price, the snapshot and the freeze time', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000);

    const before = Date.now();
    const result = relockPlanMaterialPrice('p1', 34, 6.10);

    expect(result.success).toBe(true);
    expect(result.overridden).toBe(false);
    const row = mockDb.prepare('SELECT * FROM plan_material_nodes WHERE node_id = ?').get('n1');
    expect(row.price_each).toBe(6.10);
    // With no override, the lock sets the snapshot too - that is what a later
    // override removal reverts to.
    expect(row.last_market_price).toBe(6.10);
    expect(row.price_frozen_at).toBeGreaterThanOrEqual(before);
  });

  test('does NOT create a plan price override', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42);

    relockPlanMaterialPrice('p1', 34, 6.10);

    const overrides = mockDb.prepare('SELECT COUNT(*) AS n FROM plan_price_overrides').get().n;
    expect(overrides).toBe(0);
  });

  test('touches only the named plan', () => {
    addPlan('p1', 'Target');
    addPlan('p2', 'Bystander');
    addNode('n1', 'p1', 34, 5.42);
    addNode('n2', 'p2', 34, 5.42);

    relockPlanMaterialPrice('p1', 34, 6.10);

    expect(nodePrice('n1')).toBe(6.10);
    expect(nodePrice('n2')).toBe(5.42);
  });

  test('touches only the named type', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42);
    addNode('n2', 'p1', 35, 11.30);

    relockPlanMaterialPrice('p1', 34, 6.10);

    expect(nodePrice('n1')).toBe(6.10);
    expect(nodePrice('n2')).toBe(11.30);
  });

  test('updates every node of that type within the plan', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42);
    addNode('n2', 'p1', 34, 5.42);

    const result = relockPlanMaterialPrice('p1', 34, 6.10);

    expect(result.nodesUpdated).toBe(2);
    expect(nodePrice('n1')).toBe(6.10);
    expect(nodePrice('n2')).toBe(6.10);
  });

  describe('when a plan price override is set', () => {
    /** Mirrors what a full "Refresh Prices" run does for an overridden item. */
    beforeEach(() => {
      addPlan('p1', 'Pinned');
      // Locked at 5.00, then pinned at 9.99: price_each is the override while
      // last_market_price still records what the market was.
      addNode('n1', 'p1', 34, 5.00, 100, 1000);
      mockDb.prepare(
        'INSERT INTO plan_price_overrides (plan_id, type_id, price) VALUES (?, ?, ?)'
      ).run('p1', 34, 9.99);
      mockDb.prepare('UPDATE plan_material_nodes SET price_each = 9.99 WHERE node_id = ?').run('n1');
    });

    test('the override still wins for the locked price', () => {
      relockPlanMaterialPrice('p1', 34, 6.10);
      expect(nodePrice('n1')).toBe(9.99);
    });

    test('the market snapshot behind the override is refreshed', () => {
      relockPlanMaterialPrice('p1', 34, 6.10);

      expect(nodeSnapshot('n1')).toBe(6.10);
    });

    test('last_market_price and price_frozen_at move together', () => {
      // They are a matched pair: what the market was, and when it was locked.
      // Writing one without the other leaves the pair lying, so both branches
      // of relockPlanMaterialPrice update them in a single statement.
      const before = Date.now();
      relockPlanMaterialPrice('p1', 34, 6.10);

      const row = mockDb.prepare(
        'SELECT last_market_price, price_frozen_at FROM plan_material_nodes WHERE node_id = ?'
      ).get('n1');
      expect(row.last_market_price).toBe(6.10);
      expect(row.price_frozen_at).toBeGreaterThanOrEqual(before);
    });

    test('price_frozen_at is stamped, as a full refresh would', () => {
      const before = Date.now();
      relockPlanMaterialPrice('p1', 34, 6.10);

      const frozen = mockDb.prepare(
        'SELECT price_frozen_at FROM plan_material_nodes WHERE node_id = ?'
      ).get('n1').price_frozen_at;
      expect(frozen).toBeGreaterThanOrEqual(before);
    });

    test('reports that the override still applies, so the UI can say so', () => {
      const result = relockPlanMaterialPrice('p1', 34, 6.10);

      expect(result.success).toBe(true);
      expect(result.overridden).toBe(true);
      expect(result.overridePrice).toBe(9.99);
      expect(result.marketPrice).toBe(6.10);
    });

    test('does not delete or duplicate the override row', () => {
      relockPlanMaterialPrice('p1', 34, 6.10);

      const rows = mockDb.prepare('SELECT COUNT(*) AS n FROM plan_price_overrides').get().n;
      expect(rows).toBe(1);
    });
  });

  test('rejects a non-positive or non-numeric price', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42);

    expect(() => relockPlanMaterialPrice('p1', 34, 0)).toThrow(/invalid re-lock price/i);
    expect(() => relockPlanMaterialPrice('p1', 34, -5)).toThrow(/invalid re-lock price/i);
    expect(() => relockPlanMaterialPrice('p1', 34, NaN)).toThrow(/invalid re-lock price/i);
    expect(nodePrice('n1')).toBe(5.42);
  });

  test('is a no-op when the plan does not use the type', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42);

    const result = relockPlanMaterialPrice('p1', 999, 6.10);

    expect(result.success).toBe(true);
    expect(result.nodesUpdated).toBe(0);
    expect(nodePrice('n1')).toBe(5.42);
  });
});

/**
 * price_frozen_at and last_market_price are a MATCHED PAIR: together they record
 * when the user last locked the market price, and what that price was.
 *
 * "Refresh Prices" and a single-item re-lock both ARE market locks, so both
 * update the pair. Creating, editing or deleting an override is NOT a lock -
 * it never fetches a market price - so it must leave the pair untouched.
 * The override's own age lives in plan_price_overrides.created_at/updated_at.
 */
describe('price_frozen_at describes only the market lock', () => {
  const {
    setPlanPriceOverride,
    removePlanPriceOverride,
  } = require('../../src/main/manufacturing-plans');

  function frozenAt(nodeId) {
    return mockDb.prepare('SELECT price_frozen_at FROM plan_material_nodes WHERE node_id = ?')
      .get(nodeId).price_frozen_at;
  }

  test('setting an override does not restamp the market lock time', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000);

    setPlanPriceOverride('p1', 34, 9.99);

    expect(frozenAt('n1')).toBe(1000);
    expect(nodePrice('n1')).toBe(9.99);
  });

  test('setting an override records its own age separately', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000);

    const before = Date.now();
    setPlanPriceOverride('p1', 34, 9.99);

    const row = mockDb.prepare(
      'SELECT created_at, updated_at FROM plan_price_overrides WHERE plan_id = ? AND type_id = ?'
    ).get('p1', 34);
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.updated_at).toBeGreaterThanOrEqual(before);
  });

  test('editing an override does not restamp the market lock time', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000);
    setPlanPriceOverride('p1', 34, 9.99);
    setPlanPriceOverride('p1', 34, 12.50);

    expect(frozenAt('n1')).toBe(1000);
    expect(nodePrice('n1')).toBe(12.50);
  });

  test('removing an override restores the locked price without restamping', () => {
    // The node was locked at 5.42 (addNode records the snapshot, as a lock
    // does), then overridden. Removing the override reverts to that lock.
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000);
    setPlanPriceOverride('p1', 34, 9.99);

    removePlanPriceOverride('p1', 34);

    expect(nodePrice('n1')).toBe(5.42);
    expect(frozenAt('n1')).toBe(1000);
  });

  test('a re-lock DOES advance the pair, even while overridden', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000);
    setPlanPriceOverride('p1', 34, 9.99);

    const before = Date.now();
    relockPlanMaterialPrice('p1', 34, 6.10);

    expect(frozenAt('n1')).toBeGreaterThanOrEqual(before);
    expect(nodeSnapshot('n1')).toBe(6.10);
    // The override still wins for the actual price.
    expect(nodePrice('n1')).toBe(9.99);
  });

  test('after a re-lock, deleting the override reverts to the re-locked price', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000);
    setPlanPriceOverride('p1', 34, 9.99);
    relockPlanMaterialPrice('p1', 34, 6.10);

    removePlanPriceOverride('p1', 34);

    expect(nodePrice('n1')).toBe(6.10);
  });
});

/**
 * last_market_price must only ever be written by a real market lock.
 *
 * It previously got seeded from the node's current price_each when an override
 * was first created. That fabricates a "market" price the market never quoted -
 * and because price_each may ALREADY be an override value, a second override
 * could enshrine the first override's price as market data, which
 * removePlanPriceOverride would then faithfully restore.
 */
describe('last_market_price is never contaminated by price_each', () => {
  const {
    setPlanPriceOverride,
    removePlanPriceOverride,
  } = require('../../src/main/manufacturing-plans');

  function snapshot(planId, typeId) {
    const row = mockDb.prepare(
      'SELECT last_market_price FROM plan_material_nodes WHERE plan_id = ? AND type_id = ? LIMIT 1'
    ).get(planId, typeId);
    return row ? row.last_market_price : undefined;
  }

  test('creating an override leaves the locked market price untouched', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42);

    setPlanPriceOverride('p1', 34, 9.99);

    expect(nodePrice('n1')).toBe(9.99);
    expect(snapshot('p1', 34)).toBe(5.42);
  });

  test('an override price never becomes the market snapshot', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42);

    setPlanPriceOverride('p1', 34, 9.99);
    // price_each is now 9.99. Setting a second override must not capture it.
    setPlanPriceOverride('p1', 34, 12.50);

    expect(snapshot('p1', 34)).toBe(5.42);
    expect(snapshot('p1', 34)).not.toBe(9.99);
  });

  test('a real lock is what populates the snapshot', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42);
    setPlanPriceOverride('p1', 34, 9.99);

    relockPlanMaterialPrice('p1', 34, 6.10);

    expect(snapshot('p1', 34)).toBe(6.10);
  });

  test('an override set after a lock does not overwrite the locked snapshot', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42);
    setPlanPriceOverride('p1', 34, 9.99);
    relockPlanMaterialPrice('p1', 34, 6.10);

    setPlanPriceOverride('p1', 34, 20.00);

    expect(snapshot('p1', 34)).toBe(6.10);
  });

  test('removing an override with no recorded lock leaves price_each alone', () => {
    addPlan('p1', 'Capital Build');
    // A node that has never been locked: no snapshot to revert to.
    mockDb.prepare(`
      INSERT INTO plan_material_nodes
        (node_id, plan_id, type_id, quantity_needed, price_each, price_frozen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('n1', 'p1', 34, 100, 5.42, 1000);
    setPlanPriceOverride('p1', 34, 9.99);

    removePlanPriceOverride('p1', 34);

    // Nothing truthful to revert to, so the override value stays until the
    // next lock rather than a fabricated price being restored.
    expect(nodePrice('n1')).toBe(9.99);
  });

  test('removing an override after a lock reverts to the locked price', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42);
    setPlanPriceOverride('p1', 34, 9.99);
    relockPlanMaterialPrice('p1', 34, 6.10);

    removePlanPriceOverride('p1', 34);

    expect(nodePrice('n1')).toBe(6.10);
  });
});

/**
 * A plan 'product' is ONLY ever a final product. An 'intermediate' is a
 * cascading INPUT - it is some blueprint's product, but the plan consumes it
 * rather than selling it, so it is priced on the input side.
 *
 * Getting this wrong prices intermediates against the output market set (often
 * a different location, price type and calculation method), which silently
 * skews every plan that builds sub-components.
 */
describe('intermediates are inputs, not outputs', () => {
  test('a material node reports the input scope', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000, 'material');

    expect(getPlansUsingType(34)[0].scope).toBe('input');
  });

  test('an intermediate node reports the INPUT scope', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000, 'intermediate');

    expect(getPlansUsingType(34)[0].scope).toBe('input');
  });

  test('only a final product reports the output scope', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000, 'product');

    expect(getPlansUsingType(34)[0].scope).toBe('output');
  });

  test('a type that is both consumed and sold yields one row per scope', () => {
    // Same type, same plan, both sides - they price differently, so collapsing
    // them into one row would mis-price one.
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000, 'material');
    addNode('n2', 'p1', 34, 9.00, 50, 1000, 'product');

    const rows = getPlansUsingType(34);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.scope).sort()).toEqual(['input', 'output']);
  });

  test('materials and intermediates of one type collapse into a single input row', () => {
    addPlan('p1', 'Capital Build');
    addNode('n1', 'p1', 34, 5.42, 100, 1000, 'material');
    addNode('n2', 'p1', 34, 5.42, 200, 1000, 'intermediate');

    const rows = getPlansUsingType(34);

    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe('input');
    expect(rows[0].quantity).toBe(300);
  });
});
