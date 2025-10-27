/**
 * SDE Structure and Rig Query Tests
 *
 * These tests verify that structure and rig-related queries work correctly.
 * This is critical for facility management and bonus calculations.
 */

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const { structures, rigs } = require('./fixtures/known-items');

describe('SDE Structure and Rig Queries', () => {
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

  describe('Structure Types', () => {
    test('Raitaru (Engineering Complex) should exist', () => {
      const result = db.prepare(`
        SELECT typeID, typeName, groupID
        FROM invTypes
        WHERE typeID = ?
      `).get(structures.raitaru.typeID);

      expect(result).toBeDefined();
      expect(result.typeName).toBe(structures.raitaru.typeName);
    });

    test('Athanor (Refinery) should exist', () => {
      const result = db.prepare(`
        SELECT typeID, typeName, groupID
        FROM invTypes
        WHERE typeID = ?
      `).get(structures.athanor.typeID);

      expect(result).toBeDefined();
      expect(result.typeName).toBe(structures.athanor.typeName);
    });

    test('Structure types should have group information', () => {
      const result = db.prepare(`
        SELECT it.typeID, it.typeName, ig.groupName
        FROM invTypes it
        JOIN invGroups ig ON it.groupID = ig.groupID
        WHERE it.typeID = ?
      `).get(structures.raitaru.typeID);

      expect(result).toBeDefined();
      expect(result.groupName).toBeTruthy();
    });
  });

  describe('Structure Rigs', () => {
    test('M-Set Material Efficiency Rig T1 should exist', () => {
      const result = db.prepare(`
        SELECT typeID, typeName, groupID
        FROM invTypes
        WHERE typeID = ?
      `).get(rigs.meRigT1.typeID);

      expect(result).toBeDefined();
      expect(result.typeName).toContain('Material Efficiency');
    });

    test('M-Set Material Efficiency Rig T2 should exist', () => {
      const result = db.prepare(`
        SELECT typeID, typeName, groupID
        FROM invTypes
        WHERE typeID = ?
      `).get(rigs.meRigT2.typeID);

      expect(result).toBeDefined();
      expect(result.typeName).toContain('Material Efficiency');
    });
  });

  describe('Structure Bonuses via dgmTypeAttributes', () => {
    test('Structure types should have attributes', () => {
      const results = db.prepare(`
        SELECT dta.typeID, dta.attributeID, dat.attributeName, dta.valueFloat
        FROM dgmTypeAttributes dta
        JOIN dgmAttributeTypes dat ON dta.attributeID = dat.attributeID
        WHERE dta.typeID = ?
        LIMIT 5
      `).all(structures.raitaru.typeID);

      expect(results.length).toBeGreaterThan(0);
      results.forEach(attr => {
        expect(attr.attributeName).toBeTruthy();
      });
    });

    test('Attribute query JOIN should work (dgmTypeAttributes → dgmAttributeTypes)', () => {
      const result = db.prepare(`
        SELECT COUNT(*) as count
        FROM dgmTypeAttributes dta
        JOIN dgmAttributeTypes dat ON dta.attributeID = dat.attributeID
        WHERE dta.typeID = ?
      `).get(structures.raitaru.typeID);

      expect(result.count).toBeGreaterThan(0);
    });
  });

  describe('Rig Effects via dgmTypeAttributes', () => {
    test('Rigs should have attributes defining their bonuses', () => {
      const results = db.prepare(`
        SELECT dta.attributeID, dat.attributeName, dta.valueFloat
        FROM dgmTypeAttributes dta
        JOIN dgmAttributeTypes dat ON dta.attributeID = dat.attributeID
        WHERE dta.typeID = ?
      `).all(rigs.meRigT1.typeID);

      expect(results.length).toBeGreaterThan(0);
    });

    test('Rig attributes should have numeric values', () => {
      const results = db.prepare(`
        SELECT valueFloat
        FROM dgmTypeAttributes
        WHERE typeID = ?
      `).all(rigs.meRigT1.typeID);

      results.forEach(attr => {
        expect(typeof attr.valueFloat).toBe('number');
      });
    });
  });

  describe('Structure Listing', () => {
    test('Should be able to list all structure types', () => {
      // This query pattern is used in getStructureTypes()
      const results = db.prepare(`
        SELECT t.typeID, t.typeName, g.groupName
        FROM invTypes t
        JOIN invGroups g ON t.groupID = g.groupID
        WHERE g.categoryID = 65
          AND t.published = 1
          AND g.groupName IN (
            'Engineering Complex',
            'Refinery',
            'Citadel',
            'NPC Stations'
          )
        ORDER BY g.groupName, t.typeName
        LIMIT 20
      `).all();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(structure => {
        expect(structure.typeID).toBeGreaterThan(0);
        expect(structure.typeName).toBeTruthy();
        expect(structure.groupName).toBeTruthy();
      });
    });
  });

  describe('Rig Listing', () => {
    test('Should be able to list all structure rigs', () => {
      // This query pattern is used in getStructureRigs()
      const results = db.prepare(`
        SELECT t.typeID, t.typeName, g.groupName
        FROM invTypes t
        JOIN invGroups g ON t.groupID = g.groupID
        WHERE g.categoryID = 66
          AND t.published = 1
        ORDER BY g.groupName, t.typeName
        LIMIT 20
      `).all();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(rig => {
        expect(rig.typeID).toBeGreaterThan(0);
        expect(rig.typeName).toBeTruthy();
      });
    });
  });

  describe('Structure Category and Group', () => {
    test('Structures should be in Structure category (categoryID = 65)', () => {
      const result = db.prepare(`
        SELECT ig.categoryID
        FROM invTypes it
        JOIN invGroups ig ON it.groupID = ig.groupID
        WHERE it.typeID = ?
      `).get(structures.raitaru.typeID);

      expect(result).toBeDefined();
      expect(result.categoryID).toBe(65); // Structure category
    });

    test('Structure Rigs should be in Structure Rigs category (categoryID = 66)', () => {
      const result = db.prepare(`
        SELECT ig.categoryID
        FROM invTypes it
        JOIN invGroups ig ON it.groupID = ig.groupID
        WHERE it.typeID = ?
      `).get(rigs.meRigT1.typeID);

      expect(result).toBeDefined();
      expect(result.categoryID).toBe(66); // Structure Rigs category
    });
  });
});
