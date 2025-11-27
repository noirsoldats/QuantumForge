/**
 * Database Mock Utilities for Testing
 *
 * Provides mock database objects and helper functions for testing
 * database-dependent code without requiring actual SQLite connections
 */

const blueprintFixtures = require('../fixtures/blueprints');

/**
 * Create a mock better-sqlite3 database
 * @param {Object} fixtures - Fixture data for query responses
 * @returns {Object} Mock database object
 */
function createMockDatabase(fixtures = {}) {
  const queries = new Map();

  // Mock prepare method
  const prepare = jest.fn((sql) => {
    const queryKey = sql.trim().toLowerCase();

    return {
      get: jest.fn((...params) => {
        // Check if fixture provides a response for this query
        if (fixtures.get) {
          // First try exact match
          if (fixtures.get[queryKey]) {
            const fixtureData = fixtures.get[queryKey];
            if (typeof fixtureData === 'function') {
              return fixtureData(...params);
            }
            return fixtureData;
          }
          // Then try partial match (for convenience keys like 'select')
          for (const key in fixtures.get) {
            if (queryKey.includes(key.toLowerCase())) {
              const fixtureData = fixtures.get[key];
              if (typeof fixtureData === 'function') {
                return fixtureData(...params);
              }
              return fixtureData;
            }
          }
        }

        // Default responses for common queries
        return getDefaultResponse(sql, params, 'get');
      }),

      all: jest.fn((...params) => {
        // Check if fixture provides a response for this query
        if (fixtures.all) {
          // First try exact match
          if (fixtures.all[queryKey]) {
            const fixtureData = fixtures.all[queryKey];
            if (typeof fixtureData === 'function') {
              return fixtureData(...params);
            }
            return fixtureData;
          }
          // Then try partial match (for convenience keys like 'select')
          for (const key in fixtures.all) {
            if (queryKey.includes(key.toLowerCase())) {
              const fixtureData = fixtures.all[key];
              if (typeof fixtureData === 'function') {
                return fixtureData(...params);
              }
              return fixtureData;
            }
          }
        }

        // Default responses for common queries
        return getDefaultResponse(sql, params, 'all');
      }),

      run: jest.fn((...params) => {
        if (fixtures.run && fixtures.run[queryKey]) {
          const fixtureData = fixtures.run[queryKey];
          if (typeof fixtureData === 'function') {
            return fixtureData(...params);
          }
          return fixtureData;
        }
        return { changes: 1, lastInsertRowid: 1 };
      }),

      pluck: jest.fn(() => ({
        all: jest.fn((...params) => {
          if (fixtures.pluck && fixtures.pluck[queryKey]) {
            const fixtureData = fixtures.pluck[queryKey];
            if (typeof fixtureData === 'function') {
              return fixtureData(...params);
            }
            return fixtureData;
          }
          return [];
        })
      }))
    };
  });

  return {
    prepare,
    close: jest.fn(),
    pragma: jest.fn((pragma) => {
      if (pragma === 'foreign_keys = ON') return null;
      return [];
    })
  };
}

/**
 * Get default response for common SDE queries
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @param {string} method - Method type (get/all)
 * @returns {*} Default response
 */
function getDefaultResponse(sql, params, method) {
  const sqlLower = sql.toLowerCase();

  // Blueprint materials query
  if (sqlLower.includes('industryactivitymaterials') ||
      (sqlLower.includes('industryblueprinttypes') && sqlLower.includes('industrymaterials'))) {
    if (method === 'all') {
      const typeId = params[0];
      // Return fixture data if available
      if (typeId === blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT) {
        return blueprintFixtures.scourgeBlueprint.materials.map(m => ({
          typeID: m.typeID,
          quantity: m.quantity,
          typeName: m.typeName
        }));
      }
      return [];
    }
  }

  // Blueprint product query (industryActivityProducts table)
  if (sqlLower.includes('industryactivityproducts') && sqlLower.includes('producttypeid')) {
    if (method === 'get') {
      const typeId = params[0];
      if (typeId === blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT) {
        return {
          typeID: blueprintFixtures.scourgeBlueprint.productTypeID,
          quantity: blueprintFixtures.scourgeBlueprint.productQuantity
        };
      }
      return null;
    }
  }

  // Type name query
  if (sqlLower.includes('invtypes') && sqlLower.includes('typename')) {
    if (method === 'get') {
      const typeId = params[0];
      const typeNames = {
        34: 'Tritanium',
        35: 'Pyerite',
        36: 'Mexallon',
        37: 'Isogen',
        38: 'Nocxium',
        39: 'Zydrine',
        40: 'Megacyte',
        11399: 'Morphite',
        209: 'Scourge Light Missile',
        810: 'Scourge Light Missile Blueprint',
        637: 'Raven',
        638: 'Raven Blueprint'
      };
      return typeNames[typeId] ? { typeName: typeNames[typeId] } : null;
    }
  }

  // Blueprint for product query (reverse lookup)
  // Match: SELECT typeID as blueprintTypeID FROM industryActivityProducts WHERE productTypeID = ?
  if (sqlLower.includes('industryactivityproducts') && sqlLower.includes('producttypeid')) {
    if (method === 'get') {
      const productTypeId = params[0];
      // console.log('[DBMock] Blueprint lookup for productTypeId:', productTypeId);
      if (productTypeId === blueprintFixtures.TYPE_IDS.SCOURGE_MISSILE || productTypeId === 209) {
        return { blueprintTypeID: blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT };
      }
      if (productTypeId === blueprintFixtures.TYPE_IDS.RAVEN || productTypeId === 637) {
        return { blueprintTypeID: blueprintFixtures.TYPE_IDS.RAVEN_BLUEPRINT };
      }
      return null;  // Raw materials have no blueprints
    }
  }

  // Also handle old industryblueprinttypes table name (legacy queries)
  if (sqlLower.includes('industryblueprinttypes') && sqlLower.includes('producttypeid')) {
    if (method === 'get') {
      const productTypeId = params[0];
      if (productTypeId === blueprintFixtures.TYPE_IDS.SCOURGE_MISSILE) {
        return { blueprintTypeID: blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT };
      }
      if (productTypeId === blueprintFixtures.TYPE_IDS.RAVEN) {
        return { blueprintTypeID: blueprintFixtures.TYPE_IDS.RAVEN_BLUEPRINT };
      }
      return null;  // Raw materials have no blueprints
    }
  }

  // Product group ID query
  if (sqlLower.includes('invtypes') && sqlLower.includes('groupid')) {
    if (method === 'get') {
      const typeId = params[0];
      const groupIds = {
        209: 88,   // Scourge - Light Missile group
        637: 27,   // Raven - Battleship group
        507: 507   // Light Missile Launcher - Module group
      };
      return groupIds[typeId] ? { groupID: groupIds[typeId] } : null;
    }
  }

  // Decryptor query
  // NOTE: Only return default decryptors if this is intentionally a test database
  // For empty mocks (no fixtures), return empty array
  if (sqlLower.includes('decryptor') || sqlLower.includes('attributeid in (1112')) {
    if (method === 'all') {
      // Return empty array by default - tests should provide fixtures if they want decryptors
      return [];
    }
  }

  // Invention data query
  if (sqlLower.includes('invention')) {
    // Return empty for now - can be extended
    return method === 'all' ? [] : null;
  }

  // Default: return null for get, empty array for all
  return method === 'all' ? [] : null;
}

/**
 * Create mock database with blueprint fixtures pre-loaded
 * @returns {Object} Mock database
 */
function createBlueprintDatabase() {
  const fixtures = {
    get: {
      // Type names
      'select typename from invtypes where typeid = ?': (typeId) => {
        const names = {
          [blueprintFixtures.TYPE_IDS.TRITANIUM]: { typeName: 'Tritanium' },
          [blueprintFixtures.TYPE_IDS.PYERITE]: { typeName: 'Pyerite' },
          [blueprintFixtures.TYPE_IDS.MEXALLON]: { typeName: 'Mexallon' },
          [blueprintFixtures.TYPE_IDS.SCOURGE_MISSILE]: { typeName: 'Scourge Light Missile' },
          [blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT]: { typeName: 'Scourge Light Missile Blueprint' },
          [blueprintFixtures.TYPE_IDS.RAVEN]: { typeName: 'Raven' },
          [blueprintFixtures.TYPE_IDS.RAVEN_BLUEPRINT]: { typeName: 'Raven Blueprint' }
        };
        return names[typeId] || null;
      }
    },
    all: {
      // Blueprint materials
      'select': (typeId) => {
        if (typeId === blueprintFixtures.TYPE_IDS.SCOURGE_BLUEPRINT) {
          return blueprintFixtures.scourgeBlueprint.materials;
        }
        return [];
      }
    }
  };

  return createMockDatabase(fixtures);
}

/**
 * Create mock market database
 * @param {Object} priceOverrides - Price override data
 * @returns {Object} Mock database
 */
function createMarketDatabase(priceOverrides = {}) {
  const overrideMap = new Map(Object.entries(priceOverrides));

  const fixtures = {
    get: {
      'select * from price_overrides where type_id = ?': (typeId) => {
        if (overrideMap.has(typeId.toString())) {
          const override = overrideMap.get(typeId.toString());
          return {
            type_id: typeId,
            price: override.price,
            notes: override.notes || null,
            created_at: override.created_at || Date.now(),
            updated_at: override.updated_at || Date.now()
          };
        }
        return null;
      }
    },
    all: {
      'price_overrides': () => {
        return Array.from(overrideMap.entries()).map(([typeId, data]) => ({
          type_id: parseInt(typeId),
          price: data.price,
          notes: data.notes || null,
          created_at: data.created_at || Date.now(),
          updated_at: data.updated_at || Date.now()
        }));
      }
    },
    run: {
      'price_overrides': () => {
        return { changes: 1 };
      }
    }
  };

  return createMockDatabase(fixtures);
}

/**
 * Create an in-memory SQLite database for integration testing
 * Requires actual better-sqlite3 module
 * @returns {Object} Real SQLite database in memory
 */
function createInMemoryDatabase() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');

  // Create basic SDE schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS invTypes (
      typeID INTEGER PRIMARY KEY,
      groupID INTEGER,
      typeName TEXT,
      volume REAL,
      categoryID INTEGER
    );

    CREATE TABLE IF NOT EXISTS invGroups (
      groupID INTEGER PRIMARY KEY,
      categoryID INTEGER,
      groupName TEXT
    );

    CREATE TABLE IF NOT EXISTS industryBlueprints (
      typeID INTEGER PRIMARY KEY,
      productTypeID INTEGER,
      maxProductionLimit INTEGER
    );

    CREATE TABLE IF NOT EXISTS industryActivityMaterials (
      typeID INTEGER,
      activityID INTEGER,
      materialTypeID INTEGER,
      quantity INTEGER,
      PRIMARY KEY (typeID, activityID, materialTypeID)
    );

    CREATE TABLE IF NOT EXISTS industryActivityProducts (
      typeID INTEGER,
      activityID INTEGER,
      productTypeID INTEGER,
      quantity INTEGER,
      PRIMARY KEY (typeID, activityID)
    );

    CREATE TABLE IF NOT EXISTS industryActivity (
      typeID INTEGER,
      activityID INTEGER,
      time INTEGER,
      PRIMARY KEY (typeID, activityID)
    );

    CREATE TABLE IF NOT EXISTS industryActivityProbabilities (
      typeID INTEGER,
      activityID INTEGER,
      productTypeID INTEGER,
      probability REAL,
      PRIMARY KEY (typeID, activityID, productTypeID)
    );

    CREATE TABLE IF NOT EXISTS industryActivitySkills (
      typeID INTEGER,
      activityID INTEGER,
      skillID INTEGER,
      level INTEGER,
      PRIMARY KEY (typeID, activityID, skillID)
    );

    -- Dogma Type Attributes (for decryptor bonuses, rig bonuses, structure bonuses, etc.)
    CREATE TABLE IF NOT EXISTS dgmTypeAttributes (
      typeID INTEGER NOT NULL,
      attributeID INTEGER NOT NULL,
      valueInt INTEGER,
      valueFloat REAL,
      PRIMARY KEY (typeID, attributeID)
    );

    -- Dogma Attribute Definitions (for attribute names and descriptions)
    CREATE TABLE IF NOT EXISTS dgmAttributeTypes (
      attributeID INTEGER PRIMARY KEY,
      attributeName TEXT,
      displayName TEXT,
      description TEXT
    );
  `);

  return db;
}

/**
 * Populate in-memory database with fixture data
 * @param {Object} db - Database instance
 * @param {Object} fixtures - Fixture data to populate
 */
function populateDatabase(db, fixtures) {
  // Insert blueprint data
  if (fixtures.blueprint) {
    const bp = fixtures.blueprint;

    // Insert product type
    db.prepare(`
      INSERT OR REPLACE INTO invTypes (typeID, typeName, groupID, categoryID)
      VALUES (?, ?, ?, ?)
    `).run(bp.productTypeID, bp.productName, bp.groupID, bp.categoryID);

    // Insert blueprint type
    db.prepare(`
      INSERT OR REPLACE INTO invTypes (typeID, typeName, groupID, categoryID)
      VALUES (?, ?, ?, ?)
    `).run(bp.typeID, bp.typeName, bp.groupID, bp.categoryID);

    // Insert blueprint
    db.prepare(`
      INSERT OR REPLACE INTO industryBlueprints (typeID, productTypeID, maxProductionLimit)
      VALUES (?, ?, ?)
    `).run(bp.typeID, bp.productTypeID, 100);

    // Insert blueprint product into industryActivityProducts
    db.prepare(`
      INSERT OR REPLACE INTO industryActivityProducts (typeID, activityID, productTypeID, quantity)
      VALUES (?, 1, ?, ?)
    `).run(bp.typeID, bp.productTypeID, bp.productQuantity);

    // Insert materials into industryActivityMaterials
    if (bp.materials) {
      const insertMaterial = db.prepare(`
        INSERT OR REPLACE INTO industryActivityMaterials (typeID, activityID, materialTypeID, quantity)
        VALUES (?, 1, ?, ?)
      `);

      for (const material of bp.materials) {
        // Insert material type
        db.prepare(`
          INSERT OR REPLACE INTO invTypes (typeID, typeName)
          VALUES (?, ?)
        `).run(material.typeID, material.typeName);

        // Insert material requirement
        insertMaterial.run(bp.typeID, material.typeID, material.quantity);
      }
    }
  }

  // Insert invention data
  if (fixtures.inventionData) {
    const inv = fixtures.inventionData;

    // Insert T2 blueprint type
    db.prepare(`
      INSERT OR REPLACE INTO invTypes (typeID, typeName)
      VALUES (?, ?)
    `).run(inv.t2BlueprintTypeID, inv.t2ProductName + ' Blueprint');

    // Insert T2 product type
    db.prepare(`
      INSERT OR REPLACE INTO invTypes (typeID, typeName)
      VALUES (?, ?)
    `).run(inv.t2ProductTypeID, inv.t2ProductName);

    // Insert invention activity (activityID = 8)
    db.prepare(`
      INSERT OR REPLACE INTO industryActivity (typeID, activityID, time)
      VALUES (?, 8, ?)
    `).run(inv.t1BlueprintTypeID, 1800);

    // Insert invention product (T2 blueprint)
    db.prepare(`
      INSERT OR REPLACE INTO industryActivityProducts (typeID, activityID, productTypeID, quantity)
      VALUES (?, 8, ?, ?)
    `).run(inv.t1BlueprintTypeID, inv.t2BlueprintTypeID, 1);

    // Insert T2 blueprint manufacturing product (T2 item)
    db.prepare(`
      INSERT OR REPLACE INTO industryActivityProducts (typeID, activityID, productTypeID, quantity)
      VALUES (?, 1, ?, ?)
    `).run(inv.t2BlueprintTypeID, inv.t2ProductTypeID, 1);

    // Insert invention probability
    db.prepare(`
      INSERT OR REPLACE INTO industryActivityProbabilities (typeID, activityID, productTypeID, probability)
      VALUES (?, 8, ?, ?)
    `).run(inv.t1BlueprintTypeID, inv.t2BlueprintTypeID, inv.baseProbability);

    // Insert invention materials
    if (inv.inventionMaterials) {
      const insertMaterial = db.prepare(`
        INSERT OR REPLACE INTO industryActivityMaterials (typeID, activityID, materialTypeID, quantity)
        VALUES (?, 8, ?, ?)
      `);

      for (const material of inv.inventionMaterials) {
        // Insert material type
        db.prepare(`
          INSERT OR REPLACE INTO invTypes (typeID, typeName)
          VALUES (?, ?)
        `).run(material.typeID, material.typeName);

        // Insert material requirement
        insertMaterial.run(inv.t1BlueprintTypeID, material.typeID, material.quantity);
      }
    }

    // Insert required skills
    if (inv.requiredSkills) {
      const insertSkill = db.prepare(`
        INSERT OR REPLACE INTO industryActivitySkills (typeID, activityID, skillID, level)
        VALUES (?, 8, ?, ?)
      `);

      for (const skill of inv.requiredSkills) {
        // Insert skill type
        db.prepare(`
          INSERT OR REPLACE INTO invTypes (typeID, typeName)
          VALUES (?, ?)
        `).run(skill.skillID, skill.skillName);

        // Insert skill requirement (use level 1 if null)
        insertSkill.run(inv.t1BlueprintTypeID, skill.skillID, skill.level || 1);
      }
    }

    // Insert encryption skill if provided
    if (inv.encryptionSkill) {
      db.prepare(`
        INSERT OR REPLACE INTO invTypes (typeID, typeName)
        VALUES (?, ?)
      `).run(inv.encryptionSkill.skillID, inv.encryptionSkill.skillName);
    }
  }

  // Insert decryptor data
  if (fixtures.decryptors) {
    for (const decryptor of fixtures.decryptors) {
      // Insert decryptor type into invTypes (groupID 1304 = Decryptors)
      db.prepare(`
        INSERT OR REPLACE INTO invTypes (typeID, typeName, groupID, published)
        VALUES (?, ?, 1304, 1)
      `).run(decryptor.typeID, decryptor.typeName);

      // Insert decryptor attributes into dgmTypeAttributes
      // Attribute 1112: Probability Multiplier
      if (decryptor.probabilityModifier !== undefined) {
        db.prepare(`
          INSERT OR REPLACE INTO dgmTypeAttributes (typeID, attributeID, valueFloat)
          VALUES (?, 1112, ?)
        `).run(decryptor.typeID, decryptor.probabilityModifier);
      }

      // Attribute 1113: ME Modifier
      if (decryptor.meModifier !== undefined) {
        db.prepare(`
          INSERT OR REPLACE INTO dgmTypeAttributes (typeID, attributeID, valueInt)
          VALUES (?, 1113, ?)
        `).run(decryptor.typeID, decryptor.meModifier);
      }

      // Attribute 1114: TE Modifier
      if (decryptor.teModifier !== undefined) {
        db.prepare(`
          INSERT OR REPLACE INTO dgmTypeAttributes (typeID, attributeID, valueInt)
          VALUES (?, 1114, ?)
        `).run(decryptor.typeID, decryptor.teModifier);
      }

      // Attribute 1124: Runs Modifier
      if (decryptor.runsModifier !== undefined) {
        db.prepare(`
          INSERT OR REPLACE INTO dgmTypeAttributes (typeID, attributeID, valueInt)
          VALUES (?, 1124, ?)
        `).run(decryptor.typeID, decryptor.runsModifier);
      }
    }
  }
}

module.exports = {
  createMockDatabase,
  createBlueprintDatabase,
  createMarketDatabase,
  createInMemoryDatabase,
  populateDatabase,
  getDefaultResponse
};
