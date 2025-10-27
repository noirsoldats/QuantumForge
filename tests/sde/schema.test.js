/**
 * SDE Schema Validation Tests
 *
 * These tests verify that the Eve SDE database schema from Fuzzwork
 * contains all required tables and columns that Quantum Forge depends on.
 */

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const { requiredTables, invTypesColumns, industryActivityMaterialsColumns, industryActivityProductsColumns } = require('./fixtures/known-items');

describe('SDE Schema Validation', () => {
  let db;

  beforeAll(() => {
    // Get SDE database path
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'sde', 'sqlite-latest.sqlite');

    // Open database connection
    db = new Database(dbPath, { readonly: true });
  });

  afterAll(() => {
    if (db) {
      db.close();
    }
  });

  describe('Required Tables Exist', () => {
    test.each(requiredTables)('Table %s should exist', (tableName) => {
      const result = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name=?
      `).get(tableName);

      expect(result).toBeDefined();
      expect(result.name).toBe(tableName);
    });
  });

  describe('invTypes Table Structure', () => {
    test('invTypes table should have all required columns', () => {
      const tableInfo = db.prepare('PRAGMA table_info(invTypes)').all();
      const columnNames = tableInfo.map(col => col.name);

      invTypesColumns.forEach(requiredColumn => {
        expect(columnNames).toContain(requiredColumn);
      });
    });

    test('invTypes should have typeID as primary key', () => {
      const tableInfo = db.prepare('PRAGMA table_info(invTypes)').all();
      const typeIDColumn = tableInfo.find(col => col.name === 'typeID');

      expect(typeIDColumn).toBeDefined();
      expect(typeIDColumn.pk).toBe(1); // Primary key
    });
  });

  describe('industryActivityMaterials Table Structure', () => {
    test('industryActivityMaterials should have all required columns', () => {
      const tableInfo = db.prepare('PRAGMA table_info(industryActivityMaterials)').all();
      const columnNames = tableInfo.map(col => col.name);

      industryActivityMaterialsColumns.forEach(requiredColumn => {
        expect(columnNames).toContain(requiredColumn);
      });
    });

    test('industryActivityMaterials should support activityID=1 (manufacturing)', () => {
      const result = db.prepare(`
        SELECT COUNT(*) as count
        FROM industryActivityMaterials
        WHERE activityID = 1
      `).get();

      expect(result.count).toBeGreaterThan(0);
    });
  });

  describe('industryActivityProducts Table Structure', () => {
    test('industryActivityProducts should have all required columns', () => {
      const tableInfo = db.prepare('PRAGMA table_info(industryActivityProducts)').all();
      const columnNames = tableInfo.map(col => col.name);

      industryActivityProductsColumns.forEach(requiredColumn => {
        expect(columnNames).toContain(requiredColumn);
      });
    });

    test('industryActivityProducts should support activityID=1 (manufacturing)', () => {
      const result = db.prepare(`
        SELECT COUNT(*) as count
        FROM industryActivityProducts
        WHERE activityID = 1
      `).get();

      expect(result.count).toBeGreaterThan(0);
    });
  });

  describe('invGroups and invCategories Relationship', () => {
    test('invGroups should have categoryID column for joining with invCategories', () => {
      const tableInfo = db.prepare('PRAGMA table_info(invGroups)').all();
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('groupID');
      expect(columnNames).toContain('categoryID');
      expect(columnNames).toContain('groupName');
    });

    test('invCategories should have categoryID and categoryName', () => {
      const tableInfo = db.prepare('PRAGMA table_info(invCategories)').all();
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('categoryID');
      expect(columnNames).toContain('categoryName');
    });
  });

  describe('invMetaTypes Table for Tech Level Detection', () => {
    test('invMetaTypes should exist and have metaGroupID column', () => {
      const tableInfo = db.prepare('PRAGMA table_info(invMetaTypes)').all();
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('typeID');
      expect(columnNames).toContain('metaGroupID');
    });

    test('invMetaTypes should have entries for T1, T2, T3 items', () => {
      // Check for existence of meta group IDs 1 (T1), 2 (T2), 14 (T3)
      const metaGroups = db.prepare(`
        SELECT DISTINCT metaGroupID
        FROM invMetaTypes
        WHERE metaGroupID IN (1, 2, 14)
        ORDER BY metaGroupID
      `).all();

      expect(metaGroups.length).toBeGreaterThan(0);
    });
  });

  describe('invVolumes Table for Packaged Volumes', () => {
    test('invVolumes should exist with typeID and volume columns', () => {
      const tableInfo = db.prepare('PRAGMA table_info(invVolumes)').all();
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('typeID');
      expect(columnNames).toContain('volume');
    });

    test('invVolumes should have packaged volumes for ships', () => {
      const result = db.prepare(`
        SELECT COUNT(*) as count
        FROM invVolumes
        WHERE volume > 0
      `).get();

      expect(result.count).toBeGreaterThan(0);
    });
  });

  describe('dgmTypeAttributes and dgmAttributeTypes for Bonuses', () => {
    test('dgmTypeAttributes should have required columns', () => {
      const tableInfo = db.prepare('PRAGMA table_info(dgmTypeAttributes)').all();
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('typeID');
      expect(columnNames).toContain('attributeID');
      expect(columnNames).toContain('valueFloat');
    });

    test('dgmAttributeTypes should have attributeName for lookups', () => {
      const tableInfo = db.prepare('PRAGMA table_info(dgmAttributeTypes)').all();
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('attributeID');
      expect(columnNames).toContain('attributeName');
    });
  });

  describe('Location Tables', () => {
    test('mapRegions should have regionID and regionName', () => {
      const tableInfo = db.prepare('PRAGMA table_info(mapRegions)').all();
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('regionID');
      expect(columnNames).toContain('regionName');
    });

    test('mapSolarSystems should have systemID, systemName, and security', () => {
      const tableInfo = db.prepare('PRAGMA table_info(mapSolarSystems)').all();
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('solarSystemID');
      expect(columnNames).toContain('solarSystemName');
      expect(columnNames).toContain('security');
    });

    test('staStations should have stationID and stationName', () => {
      const tableInfo = db.prepare('PRAGMA table_info(staStations)').all();
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('stationID');
      expect(columnNames).toContain('stationName');
    });
  });
});
