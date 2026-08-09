/**
 * Audit record name resolution
 *
 * Audit records store type IDs only - deliberately. `recordPricing` fires
 * hundreds of times per plan recalculation, so an SDE lookup at each of the 9
 * call sites would put a query on a hot path for data only read when the user
 * opens the Audit Log. Names are resolved lazily and in ONE batched query.
 *
 * Before this existed the screen showed "Blueprint 12345" and "Type 34" for
 * every row, because no caller has ever passed a name.
 */

const path = require('path');

const RECORDER = path.join(__dirname, '../../src/main/audit-recorder.js');
const SDE_DATABASE = path.join(__dirname, '../../src/main/sde-database.js');
const SDE_MANAGER = path.join(__dirname, '../../src/main/sde-manager.js');
const BROADCAST = path.join(__dirname, '../../src/main/broadcast.js');

let queries;
let names;
let sdePresent;

function loadRecorder({ throws = false } = {}) {
  jest.resetModules();
  queries = [];

  jest.doMock(SDE_MANAGER, () => ({ sdeExists: () => sdePresent }));
  jest.doMock(SDE_DATABASE, () => ({
    getTypeNames: async (ids) => {
      queries.push(ids);
      if (throws) throw new Error('sde unavailable');
      const out = {};
      ids.forEach((id) => { if (names[id]) out[id] = names[id]; });
      return out;
    },
  }));
  jest.doMock(BROADCAST, () => ({ broadcast: () => {}, sendToWindow: () => {} }));

  return require(RECORDER);
}

beforeEach(() => {
  sdePresent = true;
  names = {
    34: 'Tritanium',
    691: 'Raven Blueprint',
    12345: 'Ishtar Blueprint',
    34203: 'Accelerant Decryptor',
  };
});

afterEach(() => {
  jest.resetModules();
});

const pricing = (typeId) => ({ id: 1, type: 'pricing', pricing: { typeId, price: 5 } });
const materials = (blueprintTypeId) => ({ id: 2, type: 'materials', materials: { blueprintTypeId } });
const invention = (blueprintTypeId, decryptorTypeId) => ({
  id: 3,
  type: 'invention',
  invention: { blueprintTypeId, decryptorTypeId },
});

describe('withTypeNames', () => {
  test('names a pricing record', async () => {
    const rec = loadRecorder();
    const [out] = await rec.withTypeNames([pricing(34)]);
    expect(out.pricing.itemName).toBe('Tritanium');
  });

  test('names a materials record', async () => {
    const rec = loadRecorder();
    const [out] = await rec.withTypeNames([materials(691)]);
    expect(out.materials.blueprintName).toBe('Raven Blueprint');
  });

  test('names both the blueprint and the decryptor on an invention record', async () => {
    const rec = loadRecorder();
    const [out] = await rec.withTypeNames([invention(12345, 34203)]);
    expect(out.invention.blueprintName).toBe('Ishtar Blueprint');
    expect(out.invention.decryptorName).toBe('Accelerant Decryptor');
  });

  test('resolves a whole batch in ONE query', async () => {
    const rec = loadRecorder();
    await rec.withTypeNames([pricing(34), materials(691), invention(12345, 34203)]);

    expect(queries).toHaveLength(1);
    expect(queries[0].sort()).toEqual([34, 691, 12345, 34203].sort());
  });

  test('deduplicates ids across records', async () => {
    const rec = loadRecorder();
    await rec.withTypeNames([pricing(34), pricing(34), pricing(34)]);

    expect(queries[0]).toEqual([34]);
  });

  test('does not mutate the buffered record', async () => {
    // The buffer stays name-free so a later SDE update never serves stale
    // names from memory.
    const rec = loadRecorder();
    const original = pricing(34);
    const [out] = await rec.withTypeNames([original]);

    expect(original.pricing.itemName).toBeUndefined();
    expect(out).not.toBe(original);
  });

  test('leaves the id in place when the name is unknown', async () => {
    const rec = loadRecorder();
    const [out] = await rec.withTypeNames([pricing(999999)]);

    expect(out.pricing.itemName).toBeUndefined();
    expect(out.pricing.typeId).toBe(999999);
  });

  test('returns records untouched when the SDE is missing', async () => {
    sdePresent = false;
    const rec = loadRecorder();
    const [out] = await rec.withTypeNames([pricing(34)]);

    expect(queries).toHaveLength(0);
    expect(out.pricing.itemName).toBeUndefined();
  });

  test('survives an SDE query failure', async () => {
    const errors = [];
    jest.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));

    const rec = loadRecorder({ throws: true });
    const out = await rec.withTypeNames([pricing(34)]);

    expect(out).toHaveLength(1);
    expect(out[0].pricing.itemName).toBeUndefined();
    expect(errors.join(' ')).toMatch(/Could not resolve type names/);

    console.error.mockRestore();
  });

  test('an empty batch never touches the SDE', async () => {
    const rec = loadRecorder();
    await expect(rec.withTypeNames([])).resolves.toEqual([]);
    expect(queries).toHaveLength(0);
  });

  test('a batch with no resolvable ids never queries', async () => {
    const rec = loadRecorder();
    const batch = [{ id: 9, type: 'pricing', pricing: {} }];
    await rec.withTypeNames(batch);
    expect(queries).toHaveLength(0);
  });

  test('an invention record with no decryptor asks for only the blueprint', async () => {
    const rec = loadRecorder();
    await rec.withTypeNames([invention(12345, null)]);
    expect(queries[0]).toEqual([12345]);
  });
});
