/**
 * SDE Known Items Data Tests
 *
 * These tests verify that well-known Eve Online items have expected data.
 * If these tests fail, it indicates the SDE schema or data has changed.
 */

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const { materials, ores, ammunition, ships, locations } = require('./fixtures/known-items');

describe('SDE Known Items Data', () => {
  let db;

  beforeAll(() => {
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'sde', 'sqlite-latest.sqlite');
    db = new Database(dbPath, { readonly: true });
  });

  afterAll(() => {
    if (db) {
      db.close();
    }
  });

  describe('Basic Materials', () => {
    test('Tritanium should exist with correct name', () => {
      const result = db.prepare('SELECT typeID, typeName, groupID FROM invTypes WHERE typeID = ?')
        .get(materials.tritanium.typeID);

      expect(result).toBeDefined();
      expect(result.typeName).toBe(materials.tritanium.typeName);
      expect(result.groupID).toBe(materials.tritanium.groupID);
    });

    test('Isogen should exist with correct name', () => {
      const result = db.prepare('SELECT typeID, typeName FROM invTypes WHERE typeID = ?')
        .get(materials.isogen.typeID);

      expect(result).toBeDefined();
      expect(result.typeName).toBe(materials.isogen.typeName);
    });

    test('All mineral materials should be published', () => {
      const mineralTypeIDs = Object.values(materials).map(m => m.typeID);
      const placeholders = mineralTypeIDs.map(() => '?').join(',');

      const results = db.prepare(`
        SELECT typeID, published
        FROM invTypes
        WHERE typeID IN (${placeholders})
      `).all(...mineralTypeIDs);

      results.forEach(result => {
        expect(result.published).toBe(1);
      });
    });
  });

  describe('Ores', () => {
    test('Veldspar should exist with correct data', () => {
      const result = db.prepare('SELECT typeID, typeName, groupID FROM invTypes WHERE typeID = ?')
        .get(ores.veldspar.typeID);

      expect(result).toBeDefined();
      expect(result.typeName).toBe(ores.veldspar.typeName);
    });
  });

  describe('Ammunition and Meta Groups', () => {
    test('Scourge Heavy Missile should be Tech I (metaGroupID = 1)', () => {
      const result = db.prepare(`
        SELECT it.typeID, it.typeName, COALESCE(imt.metaGroupID, 1) as metaGroupID
        FROM invTypes it
        LEFT JOIN invMetaTypes imt ON it.typeID = imt.typeID
        WHERE it.typeID = ?
      `).get(ammunition.scourgeHeavyMissile.typeID);

      expect(result).toBeDefined();
      expect(result.typeName).toBe(ammunition.scourgeHeavyMissile.typeName);
      expect(result.metaGroupID).toBe(1); // Tech I
    });

    test('Scourge Fury Heavy Missile should be Tech II (metaGroupID = 2)', () => {
      const result = db.prepare(`
        SELECT it.typeID, it.typeName, imt.metaGroupID
        FROM invTypes it
        LEFT JOIN invMetaTypes imt ON it.typeID = imt.typeID
        WHERE it.typeID = ?
      `).get(ammunition.scourgeFuryHeavyMissile.typeID);

      expect(result).toBeDefined();
      expect(result.typeName).toBe(ammunition.scourgeFuryHeavyMissile.typeName);
      expect(result.metaGroupID).toBe(2); // Tech II
    });

    test('Ammunition should be in Charge category', () => {
      const result = db.prepare(`
        SELECT it.typeID, ic.categoryName
        FROM invTypes it
        JOIN invGroups ig ON it.groupID = ig.groupID
        JOIN invCategories ic ON ig.categoryID = ic.categoryID
        WHERE it.typeID = ?
      `).get(ammunition.scourgeHeavyMissile.typeID);

      expect(result).toBeDefined();
      expect(result.categoryName).toBe('Charge');
    });
  });

  describe('Ships', () => {
    test('Raven should exist with correct data', () => {
      const result = db.prepare(`
        SELECT it.typeID, it.typeName, ig.groupID, ic.categoryName, COALESCE(imt.metaGroupID, 1) as metaGroupID
        FROM invTypes it
        JOIN invGroups ig ON it.groupID = ig.groupID
        JOIN invCategories ic ON ig.categoryID = ic.categoryID
        LEFT JOIN invMetaTypes imt ON it.typeID = imt.typeID
        WHERE it.typeID = ?
      `).get(ships.raven.typeID);

      expect(result).toBeDefined();
      expect(result.typeName).toBe(ships.raven.typeName);
      expect(result.categoryName).toBe('Ship');
      expect(result.metaGroupID).toBe(1); // Tech I
    });

    test('Rifter should exist with correct data', () => {
      const result = db.prepare(`
        SELECT it.typeID, it.typeName, ic.categoryName
        FROM invTypes it
        JOIN invGroups ig ON it.groupID = ig.groupID
        JOIN invCategories ic ON ig.categoryID = ic.categoryID
        WHERE it.typeID = ?
      `).get(ships.rifter.typeID);

      expect(result).toBeDefined();
      expect(result.typeName).toBe(ships.rifter.typeName);
      expect(result.categoryName).toBe('Ship');
    });

    test('Ships should have packaged volumes in invVolumes', () => {
      const result = db.prepare(`
        SELECT iv.typeID, iv.volume
        FROM invVolumes iv
        WHERE iv.typeID = ?
      `).get(ships.raven.typeID);

      expect(result).toBeDefined();
      expect(result.volume).toBeGreaterThan(0);
    });
  });

  describe('Locations', () => {
    test('Jita should exist with correct data', () => {
      const result = db.prepare(`
        SELECT solarSystemID, solarSystemName, regionID, security
        FROM mapSolarSystems
        WHERE solarSystemID = ?
      `).get(locations.jita.systemID);

      expect(result).toBeDefined();
      expect(result.solarSystemName).toBe(locations.jita.systemName);
      expect(result.regionID).toBe(locations.jita.regionID);
      // Security status might be slightly different due to rounding
      expect(result.security).toBeCloseTo(locations.jita.securityStatus, 1);
    });

    test('The Forge region should exist', () => {
      const result = db.prepare(`
        SELECT regionID, regionName
        FROM mapRegions
        WHERE regionID = ?
      `).get(locations.jita.regionID);

      expect(result).toBeDefined();
      expect(result.regionName).toBe(locations.jita.regionName);
    });

    test('Amarr should exist with correct data', () => {
      const result = db.prepare(`
        SELECT solarSystemID, solarSystemName, regionID
        FROM mapSolarSystems
        WHERE solarSystemID = ?
      `).get(locations.amarr.systemID);

      expect(result).toBeDefined();
      expect(result.solarSystemName).toBe(locations.amarr.systemName);
      expect(result.regionID).toBe(locations.amarr.regionID);
    });
  });

  describe('Volume Data', () => {
    test('Items should have volumes', () => {
      const result = db.prepare(`
        SELECT COALESCE(iv.volume, it.volume, 0) as volume
        FROM invTypes it
        LEFT JOIN invVolumes iv ON it.typeID = iv.typeID
        WHERE it.typeID = ?
      `).get(materials.tritanium.typeID);

      expect(result).toBeDefined();
      expect(result.volume).toBeGreaterThan(0);
    });

    test('Volume query fallback should work (invVolumes → invTypes)', () => {
      // This tests the pattern used in getItemVolume()
      const result = db.prepare(`
        SELECT it.typeID, COALESCE(iv.volume, it.volume, 0) as volume
        FROM invTypes it
        LEFT JOIN invVolumes iv ON it.typeID = iv.typeID
        WHERE it.typeID = ?
      `).get(ores.veldspar.typeID);

      expect(result).toBeDefined();
      expect(result.volume).toBeGreaterThan(0);
    });
  });
});
