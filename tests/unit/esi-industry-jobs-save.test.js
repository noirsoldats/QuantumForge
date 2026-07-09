/**
 * Unit tests for the durable-log upsert in saveIndustryJobs.
 *
 * saveIndustryJobs must NEVER blind-delete: ESI's include_completed only returns
 * a rolling window, so a delete-then-reinsert would silently drop completed jobs
 * that aged out. Instead it upserts by job_id (the PK) so:
 *  - a completed job missing from a later (smaller) response is RETAINED
 *  - an existing job re-saved active -> delivered updates in place (one row)
 *  - corp and personal jobs with distinct job_ids coexist
 */

const RealDatabase = require('better-sqlite3');

let mockDb;

jest.mock('../../src/main/character-database', () => ({
  getCharacterDatabase: jest.fn(() => mockDb),
}));

// esi-industry-jobs pulls in esi-fetch/settings-manager at require time; stub the
// network side so requiring the module is cheap and side-effect free.
jest.mock('../../src/main/esi-fetch', () => ({ esiFetch: jest.fn() }));
jest.mock('../../src/main/settings-manager', () => ({ getCharacter: jest.fn() }));

function makeJobsDb() {
  const db = new RealDatabase(':memory:');
  db.exec(`
    CREATE TABLE esi_industry_jobs (
      job_id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL,
      installer_id INTEGER NOT NULL,
      facility_id INTEGER NOT NULL,
      activity_id INTEGER NOT NULL,
      blueprint_type_id INTEGER NOT NULL,
      runs INTEGER NOT NULL,
      status TEXT NOT NULL,
      start_date INTEGER,
      end_date INTEGER,
      completed_date INTEGER,
      last_updated INTEGER NOT NULL,
      cache_expires_at INTEGER,
      is_corporation INTEGER DEFAULT 0,
      corporation_id INTEGER,
      cost REAL,
      product_type_id INTEGER
    );
  `);
  return db;
}

function job(overrides = {}) {
  return {
    job_id: 1,
    installer_id: 10,
    facility_id: 20,
    activity_id: 1,
    blueprint_type_id: 100,
    runs: 5,
    status: 'active',
    start_date: '2026-01-01T00:00:00Z',
    end_date: '2026-01-02T00:00:00Z',
    completed_date: null,
    ...overrides,
  };
}

describe('saveIndustryJobs durable upsert', () => {
  let saveIndustryJobs;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockDb = makeJobsDb();
    ({ saveIndustryJobs } = require('../../src/main/esi-industry-jobs'));
  });

  afterEach(() => {
    if (mockDb) mockDb.close();
    mockDb = null;
  });

  const rowCount = () => mockDb.prepare('SELECT COUNT(*) c FROM esi_industry_jobs').get().c;
  const getRow = (id) => mockDb.prepare('SELECT * FROM esi_industry_jobs WHERE job_id = ?').get(id);

  test('retains a completed job missing from a later smaller response', () => {
    // First refresh: two jobs (one active, one completed).
    saveIndustryJobs({
      characterId: 1, isCorporation: false, lastUpdated: 1000, cacheExpiresAt: null,
      jobs: [
        job({ job_id: 1, status: 'active' }),
        job({ job_id: 2, status: 'delivered', completed_date: '2026-01-03T00:00:00Z' }),
      ],
    });
    expect(rowCount()).toBe(2);

    // Second refresh: ESI no longer returns the completed job (aged out).
    saveIndustryJobs({
      characterId: 1, isCorporation: false, lastUpdated: 2000, cacheExpiresAt: null,
      jobs: [job({ job_id: 1, status: 'active' })],
    });

    // The completed job must still be present (no blind delete).
    expect(rowCount()).toBe(2);
    expect(getRow(2).status).toBe('delivered');
  });

  test('re-saving a job active -> delivered updates in place (one row)', () => {
    saveIndustryJobs({
      characterId: 1, isCorporation: false, lastUpdated: 1000, cacheExpiresAt: null,
      jobs: [job({ job_id: 7, status: 'active', completed_date: null })],
    });
    expect(getRow(7).status).toBe('active');

    saveIndustryJobs({
      characterId: 1, isCorporation: false, lastUpdated: 2000, cacheExpiresAt: null,
      jobs: [job({ job_id: 7, status: 'delivered', completed_date: '2026-01-05T00:00:00Z' })],
    });

    expect(rowCount()).toBe(1);
    const row = getRow(7);
    expect(row.status).toBe('delivered');
    expect(row.completed_date).toBe(new Date('2026-01-05T00:00:00Z').getTime());
    expect(row.last_updated).toBe(2000);
  });

  test('corp and personal jobs with distinct job_ids coexist', () => {
    saveIndustryJobs({
      characterId: 1, isCorporation: false, lastUpdated: 1000, cacheExpiresAt: null,
      jobs: [job({ job_id: 100 })],
    });
    saveIndustryJobs({
      characterId: 1, corporationId: 555, isCorporation: true, lastUpdated: 1000, cacheExpiresAt: null,
      jobs: [job({ job_id: 200 })],
    });

    expect(rowCount()).toBe(2);
    expect(getRow(100).is_corporation).toBe(0);
    expect(getRow(200).is_corporation).toBe(1);
    expect(getRow(200).corporation_id).toBe(555);
  });

  test('persists ESI cost and product_type_id', () => {
    saveIndustryJobs({
      characterId: 1, isCorporation: false, lastUpdated: 1000, cacheExpiresAt: null,
      jobs: [job({ job_id: 300, cost: 123456.78, product_type_id: 9999 })],
    });
    const row = getRow(300);
    expect(row.cost).toBeCloseTo(123456.78);
    expect(row.product_type_id).toBe(9999);
  });

  test('cost/product refresh in place on re-save (upsert updates them)', () => {
    saveIndustryJobs({
      characterId: 1, isCorporation: false, lastUpdated: 1000, cacheExpiresAt: null,
      jobs: [job({ job_id: 301, status: 'active', cost: null, product_type_id: null })],
    });
    saveIndustryJobs({
      characterId: 1, isCorporation: false, lastUpdated: 2000, cacheExpiresAt: null,
      jobs: [job({ job_id: 301, status: 'delivered', cost: 500, product_type_id: 42 })],
    });
    expect(rowCount()).toBe(1);
    expect(getRow(301).cost).toBe(500);
    expect(getRow(301).product_type_id).toBe(42);
  });
});
