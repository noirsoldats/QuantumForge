/**
 * SDE Blueprint Query Tests
 *
 * These tests verify that blueprint-related queries work correctly
 * and return expected data from the SDE database.
 */

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const { blueprints, ammunition, ships } = require('./fixtures/known-items');

describe('SDE Blueprint Queries', () => {
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

  describe('Blueprint Products', () => {
    test('Scourge Heavy Missile Blueprint should produce correct product', () => {
      const result = db.prepare(`
        SELECT typeID, productTypeID, quantity
        FROM industryActivityProducts
        WHERE typeID = ? AND activityID = 1
      `).get(blueprints.scourgeHeavyMissileBlueprint.blueprintTypeID);

      expect(result).toBeDefined();
      expect(result.productTypeID).toBe(ammunition.scourgeHeavyMissile.typeID);
      expect(result.quantity).toBeGreaterThan(0);
    });

    test('Manufacturing activityID should be 1', () => {
      const results = db.prepare(`
        SELECT COUNT(*) as count
        FROM industryActivityProducts
        WHERE activityID = 1
      `).get();

      expect(results.count).toBeGreaterThan(0);
    });
  });

  describe('Blueprint Materials', () => {
    test('Blueprints should have material requirements', () => {
      const results = db.prepare(`
        SELECT materialTypeID, quantity
        FROM industryActivityMaterials
        WHERE typeID = ? AND activityID = 1
        ORDER BY quantity DESC
      `).all(blueprints.scourgeHeavyMissileBlueprint.blueprintTypeID);

      expect(results).toBeDefined();
      expect(results.length).toBeGreaterThan(0);
      results.forEach(material => {
        expect(material.quantity).toBeGreaterThan(0);
        expect(material.materialTypeID).toBeGreaterThan(0);
      });
    });

    test('Material typeIDs should be valid items in invTypes', () => {
      const materials = db.prepare(`
        SELECT materialTypeID
        FROM industryActivityMaterials
        WHERE typeID = ? AND activityID = 1
        LIMIT 5
      `).all(blueprints.scourgeHeavyMissileBlueprint.blueprintTypeID);

      materials.forEach(material => {
        const item = db.prepare(`
          SELECT typeID, typeName
          FROM invTypes
          WHERE typeID = ?
        `).get(material.materialTypeID);

        expect(item).toBeDefined();
        expect(item.typeName).toBeTruthy();
      });
    });
  });

  describe('Blueprint Listing Query', () => {
    test('getAllBlueprints query should return blueprints with complete data', () => {
      const results = db.prepare(`
        SELECT DISTINCT
          it.typeID,
          it.typeName,
          ig.groupName as category,
          iap.productTypeID,
          pt.typeName as productName,
          pt.groupID as productGroupID,
          iap.quantity as productQuantity,
          pg.groupName as productGroupName,
          pc.categoryName as productCategoryName,
          COALESCE(mt.metaGroupID, 1) as productMetaGroupID
        FROM invTypes it
        JOIN invGroups ig ON it.groupID = ig.groupID
        JOIN industryActivityProducts iap ON it.typeID = iap.typeID AND iap.activityID = 1
        JOIN invTypes pt ON iap.productTypeID = pt.typeID
        JOIN invGroups pg ON pt.groupID = pg.groupID
        JOIN invCategories pc ON pg.categoryID = pc.categoryID
        LEFT JOIN invMetaTypes mt ON pt.typeID = mt.typeID
        WHERE it.published = 1
        LIMIT 10
      `).all();

      expect(results.length).toBeGreaterThan(0);

      results.forEach(bp => {
        expect(bp.typeID).toBeGreaterThan(0);
        expect(bp.typeName).toBeTruthy();
        expect(bp.productTypeID).toBeGreaterThan(0);
        expect(bp.productName).toBeTruthy();
        expect(bp.productCategoryName).toBeTruthy();
        expect(bp.productMetaGroupID).toBeGreaterThanOrEqual(1);
      });
    });

    test('Tech level detection via metaGroupID should work', () => {
      // Get a T2 blueprint
      const t2Result = db.prepare(`
        SELECT it.typeID, it.typeName, COALESCE(mt.metaGroupID, 1) as metaGroupID
        FROM invTypes it
        JOIN industryActivityProducts iap ON it.typeID = iap.typeID AND iap.activityID = 1
        JOIN invTypes pt ON iap.productTypeID = pt.typeID
        LEFT JOIN invMetaTypes mt ON pt.typeID = mt.typeID
        WHERE mt.metaGroupID = 2
        LIMIT 1
      `).get();

      if (t2Result) {
        expect(t2Result.metaGroupID).toBe(2); // Tech II
      }

      // Get a T1 blueprint (or default to 1)
      const t1Result = db.prepare(`
        SELECT it.typeID, it.typeName, COALESCE(mt.metaGroupID, 1) as metaGroupID
        FROM invTypes it
        JOIN industryActivityProducts iap ON it.typeID = iap.typeID AND iap.activityID = 1
        JOIN invTypes pt ON iap.productTypeID = pt.typeID
        LEFT JOIN invMetaTypes mt ON pt.typeID = mt.typeID
        WHERE COALESCE(mt.metaGroupID, 1) = 1
        LIMIT 1
      `).get();

      expect(t1Result).toBeDefined();
      expect(t1Result.metaGroupID).toBe(1); // Tech I or default
    });
  });

  describe('Blueprint Category Classification', () => {
    test('Ship blueprints should be in Ship category', () => {
      const result = db.prepare(`
        SELECT pc.categoryName
        FROM invTypes it
        JOIN industryActivityProducts iap ON it.typeID = iap.typeID AND iap.activityID = 1
        JOIN invTypes pt ON iap.productTypeID = pt.typeID
        JOIN invGroups pg ON pt.groupID = pg.groupID
        JOIN invCategories pc ON pg.categoryID = pc.categoryID
        WHERE pt.typeID = ?
      `).get(ships.raven.typeID);

      expect(result).toBeDefined();
      expect(result.categoryName).toBe('Ship');
    });

    test('Ammunition blueprints should be in Charge category', () => {
      const result = db.prepare(`
        SELECT pc.categoryName
        FROM invTypes it
        JOIN industryActivityProducts iap ON it.typeID = iap.typeID AND iap.activityID = 1
        JOIN invTypes pt ON iap.productTypeID = pt.typeID
        JOIN invGroups pg ON pt.groupID = pg.groupID
        JOIN invCategories pc ON pg.categoryID = pc.categoryID
        WHERE pt.typeID = ?
      `).get(ammunition.scourgeHeavyMissile.typeID);

      expect(result).toBeDefined();
      expect(result.categoryName).toBe('Charge');
    });
  });

  describe('Blueprint Search', () => {
    test('Blueprint search by name should work', () => {
      const results = db.prepare(`
        SELECT DISTINCT it.typeID, it.typeName, iap.productTypeID, pt.typeName as productName
        FROM invTypes it
        JOIN industryActivityProducts iap ON it.typeID = iap.typeID AND iap.activityID = 1
        JOIN invTypes pt ON iap.productTypeID = pt.typeID
        WHERE it.typeName LIKE ? AND it.published = 1
        ORDER BY it.typeName
        LIMIT 20
      `).all('%Missile%Blueprint%');

      expect(results.length).toBeGreaterThan(0);
      results.forEach(bp => {
        expect(bp.typeName).toContain('Blueprint');
        expect(bp.productName).toBeTruthy();
      });
    });
  });

  describe('Reverse Blueprint Lookup', () => {
    test('Should find blueprint for a product (reverse lookup)', () => {
      // Given a product, find its blueprint
      const result = db.prepare(`
        SELECT typeID as blueprintTypeID
        FROM industryActivityProducts
        WHERE productTypeID = ? AND activityID = 1
        LIMIT 1
      `).get(ammunition.scourgeHeavyMissile.typeID);

      expect(result).toBeDefined();
      expect(result.blueprintTypeID).toBeGreaterThan(0);
    });
  });
});
