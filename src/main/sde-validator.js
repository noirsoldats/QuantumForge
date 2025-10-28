/**
 * SDE Validator
 *
 * Lightweight validation module for SDE database integrity.
 * Runs critical checks to ensure SDE is compatible with Quantum Forge.
 * Does NOT require Jest - runs directly in Electron with better-sqlite3.
 */

const Database = require('better-sqlite3');
const fs = require('fs');

/**
 * Known items for validation (must never change in Eve Online)
 */
const KNOWN_ITEMS = {
  tritanium: { typeID: 34, typeName: 'Tritanium' },
  scourgeHeavyMissileBlueprint: { typeID: 810, productTypeID: 209 },
  raven: { typeID: 638, typeName: 'Raven' },
  jita: { systemID: 30000142, systemName: 'Jita' },
};

/**
 * Critical tables required by Quantum Forge
 */
const REQUIRED_TABLES = [
  'invTypes',
  'invGroups',
  'invCategories',
  'invMetaTypes',
  'industryActivityMaterials',
  'industryActivityProducts',
  'dgmTypeAttributes',
  'dgmAttributeTypes',
  'mapSolarSystems',
];

/**
 * Critical columns in invTypes table
 */
const REQUIRED_INVTYPES_COLUMNS = [
  'typeID',
  'typeName',
  'groupID',
  'published',
];

/**
 * Validate SDE database
 * @param {string} sdePath - Path to SDE database file
 * @returns {Promise<Object>} Validation results
 */
async function validateSDE(sdePath) {
  const startTime = Date.now();
  const results = {
    passed: false,
    totalChecks: 0,
    passedChecks: 0,
    failedChecks: [],
    executionTime: 0,
    summary: '',
    details: [],
  };

  let db = null;

  try {
    // Check 1: Database file exists
    results.totalChecks++;
    if (!fs.existsSync(sdePath)) {
      results.failedChecks.push({
        check: 'Database file exists',
        error: `File not found: ${sdePath}`,
      });
      results.details.push({ check: 'Database file exists', passed: false });
    } else {
      results.passedChecks++;
      results.details.push({ check: 'Database file exists', passed: true });
    }

    // If file doesn't exist, stop here
    if (results.failedChecks.length > 0) {
      results.summary = 'SDE validation failed - database file not found';
      results.executionTime = Date.now() - startTime;
      return results;
    }

    // Check 2: Database can be opened
    results.totalChecks++;
    try {
      db = new Database(sdePath, { readonly: true });
      results.passedChecks++;
      results.details.push({ check: 'Database can be opened', passed: true });
    } catch (error) {
      results.failedChecks.push({
        check: 'Database can be opened',
        error: error.message,
      });
      results.details.push({ check: 'Database can be opened', passed: false });
      results.summary = 'SDE validation failed - cannot open database';
      results.executionTime = Date.now() - startTime;
      return results;
    }

    // Check 3: Required tables exist
    for (const tableName of REQUIRED_TABLES) {
      results.totalChecks++;
      try {
        const result = db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type='table' AND name=?
        `).get(tableName);

        if (result) {
          results.passedChecks++;
          results.details.push({ check: `Table '${tableName}' exists`, passed: true });
        } else {
          results.failedChecks.push({
            check: `Table '${tableName}' exists`,
            error: `Table '${tableName}' not found in database`,
          });
          results.details.push({ check: `Table '${tableName}' exists`, passed: false });
        }
      } catch (error) {
        results.failedChecks.push({
          check: `Table '${tableName}' exists`,
          error: error.message,
        });
        results.details.push({ check: `Table '${tableName}' exists`, passed: false });
      }
    }

    // Check 4: invTypes has required columns
    results.totalChecks++;
    try {
      const tableInfo = db.prepare('PRAGMA table_info(invTypes)').all();
      const columnNames = tableInfo.map((col) => col.name);

      const missingColumns = REQUIRED_INVTYPES_COLUMNS.filter(
        (col) => !columnNames.includes(col)
      );

      if (missingColumns.length === 0) {
        results.passedChecks++;
        results.details.push({ check: 'invTypes has required columns', passed: true });
      } else {
        results.failedChecks.push({
          check: 'invTypes has required columns',
          error: `Missing columns: ${missingColumns.join(', ')}`,
        });
        results.details.push({ check: 'invTypes has required columns', passed: false });
      }
    } catch (error) {
      results.failedChecks.push({
        check: 'invTypes has required columns',
        error: error.message,
      });
      results.details.push({ check: 'invTypes has required columns', passed: false });
    }

    // Check 5: Tritanium exists (fundamental item)
    results.totalChecks++;
    try {
      const result = db.prepare('SELECT typeID, typeName FROM invTypes WHERE typeID = ?')
        .get(KNOWN_ITEMS.tritanium.typeID);

      if (result && result.typeName === KNOWN_ITEMS.tritanium.typeName) {
        results.passedChecks++;
        results.details.push({ check: 'Tritanium item exists', passed: true });
      } else {
        results.failedChecks.push({
          check: 'Tritanium item exists',
          error: result
            ? `Name mismatch: expected '${KNOWN_ITEMS.tritanium.typeName}', got '${result.typeName}'`
            : 'Item not found',
        });
        results.details.push({ check: 'Tritanium item exists', passed: false });
      }
    } catch (error) {
      results.failedChecks.push({
        check: 'Tritanium item exists',
        error: error.message,
      });
      results.details.push({ check: 'Tritanium item exists', passed: false });
    }

    // Check 6: Raven ship exists
    results.totalChecks++;
    try {
      const result = db.prepare('SELECT typeID, typeName FROM invTypes WHERE typeID = ?')
        .get(KNOWN_ITEMS.raven.typeID);

      if (result && result.typeName === KNOWN_ITEMS.raven.typeName) {
        results.passedChecks++;
        results.details.push({ check: 'Raven ship exists', passed: true });
      } else {
        results.failedChecks.push({
          check: 'Raven ship exists',
          error: result
            ? `Name mismatch: expected '${KNOWN_ITEMS.raven.typeName}', got '${result.typeName}'`
            : 'Item not found',
        });
        results.details.push({ check: 'Raven ship exists', passed: false });
      }
    } catch (error) {
      results.failedChecks.push({
        check: 'Raven ship exists',
        error: error.message,
      });
      results.details.push({ check: 'Raven ship exists', passed: false });
    }

    // Check 7: Jita system exists
    results.totalChecks++;
    try {
      const result = db.prepare('SELECT solarSystemID, solarSystemName FROM mapSolarSystems WHERE solarSystemID = ?')
        .get(KNOWN_ITEMS.jita.systemID);

      if (result && result.solarSystemName === KNOWN_ITEMS.jita.systemName) {
        results.passedChecks++;
        results.details.push({ check: 'Jita system exists', passed: true });
      } else {
        results.failedChecks.push({
          check: 'Jita system exists',
          error: result
            ? `Name mismatch: expected '${KNOWN_ITEMS.jita.systemName}', got '${result.solarSystemName}'`
            : 'System not found',
        });
        results.details.push({ check: 'Jita system exists', passed: false });
      }
    } catch (error) {
      results.failedChecks.push({
        check: 'Jita system exists',
        error: error.message,
      });
      results.details.push({ check: 'Jita system exists', passed: false });
    }

    // Check 8: Blueprint product query works
    results.totalChecks++;
    try {
      const result = db.prepare(`
        SELECT productTypeID, quantity
        FROM industryActivityProducts
        WHERE typeID = ? AND activityID = 1
      `).get(KNOWN_ITEMS.scourgeHeavyMissileBlueprint.typeID);

      if (result && result.productTypeID === KNOWN_ITEMS.scourgeHeavyMissileBlueprint.productTypeID) {
        results.passedChecks++;
        results.details.push({ check: 'Blueprint product query works', passed: true });
      } else {
        results.failedChecks.push({
          check: 'Blueprint product query works',
          error: result
            ? `Product mismatch: expected ${KNOWN_ITEMS.scourgeHeavyMissileBlueprint.productTypeID}, got ${result.productTypeID}`
            : 'Blueprint product not found',
        });
        results.details.push({ check: 'Blueprint product query works', passed: false });
      }
    } catch (error) {
      results.failedChecks.push({
        check: 'Blueprint product query works',
        error: error.message,
      });
      results.details.push({ check: 'Blueprint product query works', passed: false });
    }

    // Check 9: Blueprint materials query works
    results.totalChecks++;
    try {
      const results_materials = db.prepare(`
        SELECT materialTypeID, quantity
        FROM industryActivityMaterials
        WHERE typeID = ? AND activityID = 1
      `).all(KNOWN_ITEMS.scourgeHeavyMissileBlueprint.typeID);

      if (results_materials && results_materials.length > 0) {
        results.passedChecks++;
        results.details.push({ check: 'Blueprint materials query works', passed: true });
      } else {
        results.failedChecks.push({
          check: 'Blueprint materials query works',
          error: 'No materials found for blueprint',
        });
        results.details.push({ check: 'Blueprint materials query works', passed: false });
      }
    } catch (error) {
      results.failedChecks.push({
        check: 'Blueprint materials query works',
        error: error.message,
      });
      results.details.push({ check: 'Blueprint materials query works', passed: false });
    }

    // Check 10: Meta group JOIN query works (for T1/T2 detection)
    results.totalChecks++;
    try {
      const result = db.prepare(`
        SELECT it.typeID, it.typeName, COALESCE(mt.metaGroupID, 1) as metaGroupID
        FROM invTypes it
        LEFT JOIN invMetaTypes mt ON it.typeID = mt.typeID
        WHERE it.typeID = ?
      `).get(KNOWN_ITEMS.raven.typeID);

      if (result && result.metaGroupID) {
        results.passedChecks++;
        results.details.push({ check: 'Meta group query works', passed: true });
      } else {
        results.failedChecks.push({
          check: 'Meta group query works',
          error: 'Meta group query returned invalid data',
        });
        results.details.push({ check: 'Meta group query works', passed: false });
      }
    } catch (error) {
      results.failedChecks.push({
        check: 'Meta group query works',
        error: error.message,
      });
      results.details.push({ check: 'Meta group query works', passed: false });
    }

    // Close database
    if (db) {
      db.close();
    }

    // Calculate final results
    results.passed = results.failedChecks.length === 0;
    results.executionTime = Date.now() - startTime;

    if (results.passed) {
      results.summary = `SDE validation passed - all ${results.totalChecks} critical checks successful`;
    } else {
      results.summary = `SDE validation failed - ${results.failedChecks.length} of ${results.totalChecks} checks failed`;
    }

    return results;
  } catch (error) {
    // Unexpected error during validation
    if (db) {
      try {
        db.close();
      } catch (e) {
        // Ignore close errors
      }
    }

    results.passed = false;
    results.summary = `SDE validation error: ${error.message}`;
    results.executionTime = Date.now() - startTime;
    results.failedChecks.push({
      check: 'Validation process',
      error: error.message,
    });

    return results;
  }
}

/**
 * Quick smoke test - verifies database is accessible
 * Faster than full validation, useful for startup checks
 * @param {string} sdePath - Path to SDE database
 * @returns {Promise<Object>} Quick test results
 */
async function quickValidate(sdePath) {
  try {
    if (!fs.existsSync(sdePath)) {
      return {
        passed: false,
        error: 'Database file not found',
      };
    }

    const db = new Database(sdePath, { readonly: true });

    // Just check if we can query invTypes
    const result = db.prepare('SELECT COUNT(*) as count FROM invTypes WHERE published = 1').get();

    db.close();

    if (result && result.count > 0) {
      return {
        passed: true,
        message: `Quick validation passed - ${result.count} published items found`,
      };
    } else {
      return {
        passed: false,
        error: 'No published items found in database',
      };
    }
  } catch (error) {
    return {
      passed: false,
      error: error.message,
    };
  }
}

module.exports = {
  validateSDE,
  quickValidate,
};
