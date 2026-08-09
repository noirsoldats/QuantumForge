/**
 * getPlanMaterialDrift - live prices for drift DISPLAY.
 *
 * The load-bearing property is what this function does NOT do: a plan's cost
 * basis is its locked price, and reading drift must never write anything.
 * Binding rule 7 - only an explicit "Re-lock Prices" adopts live prices.
 *
 * Everything on the shopping list prices on the INPUT side, intermediates
 * included: an intermediate is a blueprint's product but the plan CONSUMES it,
 * so it is bought like any other material. Pricing it against the output side
 * was a real bug fixed during the Market port.
 */

const RealDatabase = require('better-sqlite3');

let mockDb;
let mockPrices;
// Jest only lets a jest.mock factory close over variables whose names begin
// with "mock" - hence mockPriceCalls rather than priceCalls.
let mockPriceCalls;

jest.mock('../../src/main/character-database', () => ({
  getCharacterDatabase: jest.fn(() => mockDb),
}));

jest.mock('../../src/main/market-pricing', () => ({
  calculateRealisticPrice: jest.fn(async (typeId, regionId, locationId, priceType, qty, settings) => {
    mockPriceCalls.push({ typeId, regionId, locationId, priceType, qty, settings });
    if (mockPrices[typeId] === 'throw') throw new Error(`no price for ${typeId}`);
    if (mockPrices[typeId] === undefined) return { price: undefined };
    return { price: mockPrices[typeId] };
  }),
}));

const { getPlanMaterialDrift } = require('../../src/main/manufacturing-plans');

const MARKET_SET = {
  id: 'set-jita',
  name: 'Jita 4-4',
  inputMaterials: { regionId: 10000002, locationId: 60003760, priceType: 'sell' },
  outputProducts: { regionId: 10000002, locationId: 60003760, priceType: 'buy' },
};

function buildSchema(db) {
  db.exec(`
    CREATE TABLE plan_material_nodes (
      node_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      type_id INTEGER NOT NULL,
      node_type TEXT NOT NULL,
      quantity_needed REAL,
      price_each REAL,
      price_frozen_at INTEGER
    );
  `);
}

function addNode(nodeId, typeId, nodeType, quantity, priceEach) {
  mockDb.prepare(
    'INSERT INTO plan_material_nodes VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(nodeId, 'plan-1', typeId, nodeType, quantity, priceEach, 1000);
}

beforeEach(() => {
  mockDb = new RealDatabase(':memory:');
  buildSchema(mockDb);
  mockPrices = {};
  mockPriceCalls = [];
});

afterEach(() => mockDb.close());

describe('drift computation', () => {
  test('reports live, locked and both drift forms', async () => {
    addNode('n1', 34, 'material', 1000, 5.00);
    mockPrices[34] = 6.00;

    const drift = await getPlanMaterialDrift('plan-1', MARKET_SET);

    expect(drift[34]).toEqual({
      livePrice: 6.0,
      lockedPrice: 5.0,
      driftAbsolute: 1.0,
      driftPercent: 20,
    });
  });

  test('a fall below the locked price is negative drift', async () => {
    addNode('n1', 34, 'material', 1000, 10.00);
    mockPrices[34] = 8.00;

    const drift = await getPlanMaterialDrift('plan-1', MARKET_SET);

    expect(drift[34].driftAbsolute).toBe(-2);
    expect(drift[34].driftPercent).toBe(-20);
  });

  test('no movement is zero drift, not null', async () => {
    // Zero and "cannot compute" are different answers and must stay distinct.
    addNode('n1', 34, 'material', 1000, 5.00);
    mockPrices[34] = 5.00;

    const drift = await getPlanMaterialDrift('plan-1', MARKET_SET);

    expect(drift[34].driftPercent).toBe(0);
    expect(drift[34].driftAbsolute).toBe(0);
  });

  test('aggregates quantity across nodes of the same type', async () => {
    // One type can appear under several blueprints; the price lookup is
    // quantity-sensitive, so it must see the TOTAL.
    addNode('n1', 34, 'material', 1000, 5.00);
    addNode('n2', 34, 'material', 500, 5.00);
    mockPrices[34] = 6.00;

    await getPlanMaterialDrift('plan-1', MARKET_SET);

    expect(mockPriceCalls).toHaveLength(1);
    expect(mockPriceCalls[0].qty).toBe(1500);
  });
});

describe('pricing side', () => {
  test('prices on the INPUT side', async () => {
    addNode('n1', 34, 'material', 1000, 5.00);
    mockPrices[34] = 6.00;

    await getPlanMaterialDrift('plan-1', MARKET_SET);

    // 'sell' is the input priceType here; 'buy' would mean it read the output
    // side, which is the intermediate-scope bug in another guise.
    expect(mockPriceCalls[0].priceType).toBe('sell');
    expect(mockPriceCalls[0].locationId).toBe(60003760);
  });

  test('only material nodes are priced', async () => {
    addNode('n1', 34, 'material', 1000, 5.00);
    addNode('n2', 587, 'product', 1, 1000000);
    mockPrices[34] = 6.00;
    mockPrices[587] = 1100000;

    const drift = await getPlanMaterialDrift('plan-1', MARKET_SET);

    expect(drift[34]).toBeDefined();
    expect(drift[587]).toBeUndefined();
    expect(mockPriceCalls).toHaveLength(1);
  });
});

describe('missing or unusable data', () => {
  test('a material with no locked price reports live but null drift', async () => {
    // Drift needs a basis to measure from; inventing one would be a lie.
    addNode('n1', 34, 'material', 1000, null);
    mockPrices[34] = 6.00;

    const drift = await getPlanMaterialDrift('plan-1', MARKET_SET);

    expect(drift[34].livePrice).toBe(6);
    expect(drift[34].driftPercent).toBeNull();
    expect(drift[34].driftAbsolute).toBeNull();
  });

  test('a locked price of zero does not divide by zero', async () => {
    addNode('n1', 34, 'material', 1000, 0);
    mockPrices[34] = 6.00;

    const drift = await getPlanMaterialDrift('plan-1', MARKET_SET);

    expect(drift[34].driftPercent).toBeNull();
    expect(Number.isFinite(drift[34].driftPercent)).toBe(false);
  });

  test('one unpriceable material does not blank the others', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    addNode('n1', 34, 'material', 1000, 5.00);
    addNode('n2', 35, 'material', 500, 10.00);
    mockPrices[34] = 'throw';
    mockPrices[35] = 12.00;

    const drift = await getPlanMaterialDrift('plan-1', MARKET_SET);

    expect(drift[34]).toBeUndefined();
    expect(drift[35].driftPercent).toBe(20);
    warn.mockRestore();
  });

  test('a price of undefined is treated as unpriceable', async () => {
    addNode('n1', 34, 'material', 1000, 5.00);
    mockPrices[34] = undefined;

    const drift = await getPlanMaterialDrift('plan-1', MARKET_SET);
    expect(drift[34]).toBeUndefined();
  });

  test('a plan with no materials returns an empty map', async () => {
    expect(await getPlanMaterialDrift('plan-1', MARKET_SET)).toEqual({});
    expect(mockPriceCalls).toHaveLength(0);
  });

  test('no market set returns empty rather than throwing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    addNode('n1', 34, 'material', 1000, 5.00);

    // No set passed and none configured - the UI shows no drift column rather
    // than the tab failing to load.
    const drift = await getPlanMaterialDrift('plan-1', null);

    expect(drift).toEqual({});
    warn.mockRestore();
  });
});

describe('read-only guarantee (binding rule 7)', () => {
  test('reading drift never changes the locked price', async () => {
    addNode('n1', 34, 'material', 1000, 5.00);
    mockPrices[34] = 99.00;

    const before = mockDb
      .prepare('SELECT price_each, price_frozen_at FROM plan_material_nodes WHERE node_id = ?')
      .get('n1');

    await getPlanMaterialDrift('plan-1', MARKET_SET);

    const after = mockDb
      .prepare('SELECT price_each, price_frozen_at FROM plan_material_nodes WHERE node_id = ?')
      .get('n1');

    // The whole point: a 20x market move leaves the plan's cost basis alone.
    expect(after).toEqual(before);
    expect(after.price_each).toBe(5.0);
  });

  test('does not scope to another plan', async () => {
    addNode('n1', 34, 'material', 1000, 5.00);
    mockDb.prepare('INSERT INTO plan_material_nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n2', 'plan-2', 35, 'material', 500, 10.0, 1000);
    mockPrices[34] = 6.0;
    mockPrices[35] = 12.0;

    const drift = await getPlanMaterialDrift('plan-1', MARKET_SET);

    expect(drift[34]).toBeDefined();
    expect(drift[35]).toBeUndefined();
  });
});
