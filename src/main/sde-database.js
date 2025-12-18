const sqlite3 = require('sqlite3').verbose();
const { getSdePath, sdeExists } = require('./sde-manager');

let db = null;
let dbConnectionPromise = null;

/**
 * Get or create database connection
 * @returns {Promise<sqlite3.Database>} Database connection
 */
function getDatabase() {
  // If we have a valid connection, return it
  if (db) {
    return Promise.resolve(db);
  }

  // If a connection is already being established, wait for it
  if (dbConnectionPromise) {
    return dbConnectionPromise;
  }

  // Create a new connection
  dbConnectionPromise = new Promise((resolve, reject) => {
    if (!sdeExists()) {
      dbConnectionPromise = null;
      reject(new Error('SDE database not found. Please download it first.'));
      return;
    }

    const dbPath = getSdePath();
    console.log('Opening SDE database:', dbPath);

    const newDb = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        console.error('Error opening SDE database:', err);
        db = null;
        dbConnectionPromise = null;
        reject(err);
      } else {
        console.log('SDE database opened successfully');
        db = newDb;
        dbConnectionPromise = null;
        resolve(newDb);
      }
    });
  });

  return dbConnectionPromise;
}

/**
 * Close database connection
 */
function closeDatabase() {
  if (db) {
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err);
      } else {
        console.log('Database closed');
      }
    });
    db = null;
  }
}

/**
 * Get skill name by skill ID
 * @param {number} skillId - Skill type ID
 * @returns {Promise<string>} Skill name
 */
async function getSkillName(skillId) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.get(
        'SELECT typeName FROM invTypes WHERE typeID = ?',
        [skillId],
        (err, row) => {
          if (err) {
            console.error('Error querying skill name:', err);
            reject(err);
          } else {
            resolve(row ? row.typeName : `Unknown Skill (${skillId})`);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting skill name:', error);
    return `Skill ${skillId}`;
  }
}

/**
 * Get multiple skill names by IDs
 * @param {number[]} skillIds - Array of skill type IDs
 * @returns {Promise<Object>} Map of skillId -> skillName
 */
async function getSkillNames(skillIds) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      const placeholders = skillIds.map(() => '?').join(',');
      const query = `SELECT typeID, typeName FROM invTypes WHERE typeID IN (${placeholders})`;

      database.all(query, skillIds, (err, rows) => {
        if (err) {
          console.error('Error querying skill names:', err);
          reject(err);
        } else {
          const nameMap = {};
          rows.forEach(row => {
            nameMap[row.typeID] = row.typeName;
          });

          // Fill in missing skills
          skillIds.forEach(id => {
            if (!nameMap[id]) {
              nameMap[id] = `Unknown Skill (${id})`;
            }
          });

          resolve(nameMap);
        }
      });
    });
  } catch (error) {
    console.error('Error getting skill names:', error);
    // Return fallback map
    const fallbackMap = {};
    skillIds.forEach(id => {
      fallbackMap[id] = `Skill ${id}`;
    });
    return fallbackMap;
  }
}

/**
 * Get all skills from SDE
 * @returns {Promise<Array>} Array of all skills
 */
async function getAllSkills() {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.all(
        `SELECT t.typeID, t.typeName, t.description, g.groupName
         FROM invTypes t
         JOIN invGroups g ON t.groupID = g.groupID
         WHERE g.categoryID = 16
         ORDER BY t.typeName`,
        [],
        (err, rows) => {
          if (err) {
            console.error('Error querying all skills:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting all skills:', error);
    return [];
  }
}

/**
 * Get skill group information
 * @param {number} skillId - Skill type ID
 * @returns {Promise<Object>} Skill group info
 */
async function getSkillGroup(skillId) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.get(
        `SELECT g.groupID, g.groupName, g.categoryID
         FROM invTypes t
         JOIN invGroups g ON t.groupID = g.groupID
         WHERE t.typeID = ?`,
        [skillId],
        (err, row) => {
          if (err) {
            console.error('Error querying skill group:', err);
            reject(err);
          } else {
            resolve(row || null);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting skill group:', error);
    return null;
  }
}

/**
 * Search skills by name
 * @param {string} searchTerm - Search term
 * @returns {Promise<Array>} Array of matching skills
 */
async function searchSkills(searchTerm) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.all(
        `SELECT t.typeID, t.typeName, t.description, g.groupName
         FROM invTypes t
         JOIN invGroups g ON t.groupID = g.groupID
         WHERE g.categoryID = 16 AND t.typeName LIKE ?
         ORDER BY t.typeName
         LIMIT 100`,
        [`%${searchTerm}%`],
        (err, rows) => {
          if (err) {
            console.error('Error searching skills:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error searching skills:', error);
    return [];
  }
}

/**
 * Get blueprint name by type ID
 * @param {number} typeId - Blueprint type ID
 * @returns {Promise<string>} Blueprint name
 */
async function getBlueprintName(typeId) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.get(
        'SELECT typeName FROM invTypes WHERE typeID = ?',
        [typeId],
        (err, row) => {
          if (err) {
            console.error('Error querying blueprint name:', err);
            reject(err);
          } else {
            resolve(row ? row.typeName : `Unknown Blueprint (${typeId})`);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting blueprint name:', error);
    return `Blueprint ${typeId}`;
  }
}

/**
 * Get multiple blueprint names by IDs
 * @param {number[]} typeIds - Array of blueprint type IDs
 * @returns {Promise<Object>} Map of typeId -> blueprintName
 */
async function getBlueprintNames(typeIds) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      const placeholders = typeIds.map(() => '?').join(',');
      const query = `SELECT typeID, typeName FROM invTypes WHERE typeID IN (${placeholders})`;

      database.all(query, typeIds, (err, rows) => {
        if (err) {
          console.error('Error querying blueprint names:', err);
          reject(err);
        } else {
          const nameMap = {};
          rows.forEach(row => {
            nameMap[row.typeID] = row.typeName;
          });

          // Fill in missing blueprints
          typeIds.forEach(id => {
            if (!nameMap[id]) {
              nameMap[id] = `Unknown Blueprint (${id})`;
            }
          });

          resolve(nameMap);
        }
      });
    });
  } catch (error) {
    console.error('Error getting blueprint names:', error);
    // Return fallback map
    const fallbackMap = {};
    typeIds.forEach(id => {
      fallbackMap[id] = `Blueprint ${id}`;
    });
    return fallbackMap;
  }
}

/**
 * Get a type name from the SDE
 * @param {number} typeId - Type ID
 * @returns {Promise<string>} Type name
 */
async function getTypeName(typeId) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.get(
        'SELECT typeName FROM invTypes WHERE typeID = ?',
        [typeId],
        (err, row) => {
          if (err) {
            console.error('Error querying type name:', err);
            reject(err);
          } else {
            resolve(row ? row.typeName : `Unknown Type (${typeId})`);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting type name:', error);
    return `Type ${typeId}`;
  }
}

/**
 * Get multiple type names from the SDE
 * @param {number[]} typeIds - Array of type IDs
 * @returns {Promise<Object>} Map of type ID to type name
 */
async function getTypeNames(typeIds) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      const placeholders = typeIds.map(() => '?').join(',');
      const query = `SELECT typeID, typeName FROM invTypes WHERE typeID IN (${placeholders})`;

      database.all(query, typeIds, (err, rows) => {
        if (err) {
          console.error('Error querying type names:', err);
          reject(err);
        } else {
          const nameMap = {};
          rows.forEach(row => {
            nameMap[row.typeID] = row.typeName;
          });

          // Fill in missing types
          typeIds.forEach(id => {
            if (!nameMap[id]) {
              nameMap[id] = `Unknown Type (${id})`;
            }
          });

          resolve(nameMap);
        }
      });
    });
  } catch (error) {
    console.error('Error getting type names:', error);
    // Return fallback map
    const fallbackMap = {};
    typeIds.forEach(id => {
      fallbackMap[id] = `Type ${id}`;
    });
    return fallbackMap;
  }
}

/**
 * Get all blueprints from SDE
 * @returns {Promise<Array>} Array of all blueprints
 */
async function getAllBlueprints() {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.all(
        `SELECT t.typeID, t.typeName, t.description, g.groupName
         FROM invTypes t
         JOIN invGroups g ON t.groupID = g.groupID
         WHERE g.categoryID = 9
         ORDER BY t.typeName`,
        [],
        (err, rows) => {
          if (err) {
            console.error('Error querying all blueprints:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting all blueprints:', error);
    return [];
  }
}

/**
 * Search blueprints by name
 * @param {string} searchTerm - Search term
 * @returns {Promise<Array>} Array of matching blueprints
 */
async function searchBlueprints(searchTerm) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.all(
        `SELECT t.typeID, t.typeName, t.description, g.groupName
         FROM invTypes t
         JOIN invGroups g ON t.groupID = g.groupID
         WHERE g.categoryID = 9 AND t.typeName LIKE ?
         ORDER BY t.typeName
         LIMIT 100`,
        [`%${searchTerm}%`],
        (err, rows) => {
          if (err) {
            console.error('Error searching blueprints:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error searching blueprints:', error);
    return [];
  }
}

/**
 * Get all regions from SDE
 * @returns {Promise<Array>} Array of regions
 */
async function getAllRegions() {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.all(
        `SELECT regionID, regionName FROM mapRegions ORDER BY regionName`,
        [],
        (err, rows) => {
          if (err) {
            console.error('Error querying regions:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting regions:', error);
    return [];
  }
}

/**
 * Get all solar systems from SDE
 * @returns {Promise<Array>} Array of systems
 */
async function getAllSystems() {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.all(
        `SELECT solarSystemID, solarSystemName, security, regionID
         FROM mapSolarSystems
         ORDER BY solarSystemName`,
        [],
        (err, rows) => {
          if (err) {
            console.error('Error querying systems:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting systems:', error);
    return [];
  }
}

/**
 * Search systems by name
 * @param {string} searchTerm - Search term
 * @returns {Promise<Array>} Array of matching systems
 */
async function searchSystems(searchTerm) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.all(
        `SELECT solarSystemID, solarSystemName, security, regionID
         FROM mapSolarSystems
         WHERE solarSystemName LIKE ?
         ORDER BY solarSystemName
         LIMIT 100`,
        [`%${searchTerm}%`],
        (err, rows) => {
          if (err) {
            console.error('Error searching systems:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error searching systems:', error);
    return [];
  }
}

/**
 * Get stations in a solar system
 * @param {number} systemId - Solar system ID
 * @returns {Promise<Array>} Array of stations
 */
async function getStationsInSystem(systemId) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.all(
        `SELECT stationID, stationName, stationTypeID
         FROM staStations
         WHERE solarSystemID = ?
         ORDER BY stationName`,
        [systemId],
        (err, rows) => {
          if (err) {
            console.error('Error querying stations:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting stations:', error);
    return [];
  }
}

/**
 * Get major trade hub stations
 * @returns {Promise<Array>} Array of trade hub stations
 */
async function getTradeHubs() {
  const tradeHubs = [
    { stationID: 60003760, stationName: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', systemID: 30000142, regionID: 10000002 },
    { stationID: 60008494, stationName: 'Amarr VIII (Oris) - Emperor Family Academy', systemID: 30002187, regionID: 10000043 },
    { stationID: 60011866, stationName: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant', systemID: 30002659, regionID: 10000032 },
    { stationID: 60004588, stationName: 'Rens VI - Moon 8 - Brutor Tribe Treasury', systemID: 30002510, regionID: 10000030 },
    { stationID: 60005686, stationName: 'Hek VIII - Moon 12 - Boundless Creation Factory', systemID: 30002053, regionID: 10000042 },
  ];

  return tradeHubs;
}

/**
 * Search market items by name
 * @param {string} searchTerm - Search term
 * @returns {Promise<Array>} Array of matching items
 */
async function searchMarketItems(searchTerm) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.all(
        `SELECT typeID, typeName, volume, basePrice
         FROM invTypes
         WHERE marketGroupID IS NOT NULL
         AND published = 1
         AND typeName LIKE ?
         ORDER BY typeName
         LIMIT 100`,
        [`%${searchTerm}%`],
        (err, rows) => {
          if (err) {
            console.error('Error searching market items:', err);
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error searching market items:', error);
    return [];
  }
}

/**
 * Get item details by typeID
 * @param {number} typeID - Item type ID
 * @returns {Promise<Object>} Item details
 */
async function getItemDetails(typeID) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.get(
        `SELECT t.typeID, t.typeName, t.description, t.volume, t.basePrice,
                t.marketGroupID, g.groupName, g.categoryID
         FROM invTypes t
         LEFT JOIN invGroups g ON t.groupID = g.groupID
         WHERE t.typeID = ?`,
        [typeID],
        (err, row) => {
          if (err) {
            console.error('Error querying item details:', err);
            reject(err);
          } else {
            resolve(row || null);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting item details:', error);
    return null;
  }
}

/**
 * Get all structure types (Upwell Structures)
 * @returns {Promise<Array>} Array of structure types
 */
async function getStructureTypes() {
  try {
    const db = await getDatabase();

    return new Promise((resolve, reject) => {
      // Query for only Engineering Complexes (used for manufacturing)
      // Citadels and Refineries cannot be used for manufacturing
      const query = `
        SELECT DISTINCT t.typeID, t.typeName
        FROM invTypes t
        WHERE t.typeName IN (
          'Raitaru',
          'Azbel',
          'Sotiyo'
        )
        AND t.published = 1
        ORDER BY
          CASE t.typeName
            WHEN 'Raitaru' THEN 1
            WHEN 'Azbel' THEN 2
            WHEN 'Sotiyo' THEN 3
          END
      `;

      db.all(query, [], (err, rows) => {
        if (err) {
          console.error('Error querying structure types:', err);
          reject(err);
        } else {
          console.log(`Found ${rows.length} Engineering Complex structure types`);
          resolve(rows.map(row => {
            // All returned structures are Engineering Complexes
            // Only categorize by size
            let size = '';

            if (row.typeName === 'Raitaru') {
              size = 'Medium';
            } else if (row.typeName === 'Azbel') {
              size = 'Large';
            } else if (row.typeName === 'Sotiyo') {
              size = 'X-Large';
            }

            return {
              typeId: row.typeID,
              typeName: row.typeName,
              category: 'Engineering Complex',
              size: size
            };
          }));
        }
      });
    });
  } catch (error) {
    console.error('Error getting structure types:', error);
    return [];
  }
}

/**
 * Get structure rigs (Engineering Rigs)
 * @returns {Promise<Array>} Array of structure rigs
 */
async function getStructureRigs() {
  try {
    const db = await getDatabase();

    return new Promise((resolve, reject) => {
      // Query for structure rigs - specifically Engineering Rigs for manufacturing
      const query = `
        SELECT DISTINCT t.typeID, t.typeName, g.groupName
        FROM invTypes t
        JOIN invGroups g ON t.groupID = g.groupID
        WHERE (
          g.groupName LIKE '%Structure%Rig%'
          OR g.groupName LIKE '%Engineering Rig%'
          OR (g.categoryID = 66 AND g.groupName LIKE '%Rig%')
        )
        AND t.published = 1
        AND t.typeName NOT LIKE '%Blueprint%'
        ORDER BY t.typeName
      `;

      db.all(query, [], (err, rows) => {
        if (err) {
          console.error('Error querying structure rigs:', err);
          reject(err);
        } else {
          console.log(`Found ${rows.length} structure rigs`);
          resolve(rows.map(row => {
            // Determine rig size from group name
            // Structure rig sizes in SDE: Medium=2, Large=3, X-Large=4
            // Structure Engineering Rig M = size 2 (for Medium structures)
            // Structure Engineering Rig L = size 3 (for Large structures)
            // Structure Engineering Rig XL = size 4 (for X-Large structures)
            let rigSize = 0;
            if (row.groupName.includes(' M ') || row.groupName.includes('Rig M -')) {
              rigSize = 2;
            } else if (row.groupName.includes(' L ') || row.groupName.includes('Rig L -')) {
              rigSize = 3;
            } else if (row.groupName.includes(' XL ') || row.groupName.includes('Rig XL -')) {
              rigSize = 4;
            }

            return {
              typeId: row.typeID,
              typeName: row.typeName,
              groupName: row.groupName,
              rigSize: rigSize
            };
          }));
        }
      });
    });
  } catch (error) {
    console.error('Error getting structure rigs:', error);
    return [];
  }
}

/**
 * Get structure bonuses - hardcoded for Upwell structures
 * @param {number} typeId - Structure type ID
 * @returns {Promise<Object>} Structure bonuses
 */
async function getStructureBonuses(typeId) {
  try {
    const db = await getDatabase();

    // First get the structure name and rig size
    const structure = await new Promise((resolve, reject) => {
      db.get(
        'SELECT typeName FROM invTypes WHERE typeID = ?',
        [typeId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });

    if (!structure) {
      return {};
    }

    // Get rig size from dgmTypeAttributes
    const rigSize = await new Promise((resolve, reject) => {
      db.get(
        `SELECT valueInt, valueFloat
         FROM dgmTypeAttributes
         WHERE typeID = ? AND attributeID = 1547`,
        [typeId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row ? (row.valueInt || row.valueFloat) : null);
          }
        }
      );
    });

    // Hardcoded bonuses for Upwell Engineering Complexes
    // Different cost reduction and time efficiency based on structure size
    const structureName = structure.typeName;
    let costReduction = 0.0;
    let timeEfficiency = 15.0;

    // Engineering Complex bonuses by size
    if (structureName === 'Raitaru') {
      costReduction = 3.0;   // Medium: 3% job cost reduction
      timeEfficiency = 15.0; // Medium: 15% time reduction
    } else if (structureName === 'Azbel') {
      costReduction = 4.0;   // Large: 4% job cost reduction
      timeEfficiency = 20.0; // Large: 20% time reduction
    } else if (structureName === 'Sotiyo') {
      costReduction = 5.0;   // X-Large: 5% job cost reduction
      timeEfficiency = 30.0; // X-Large: 30% time reduction
    }

    const bonuses = {
      materialEfficiency: 1.0,  // 1% material reduction (all structures)
      timeEfficiency: timeEfficiency,
      costReduction: costReduction,
      rigSize: rigSize || 0,
      structureName: structureName
    };

    return bonuses;
  } catch (error) {
    console.error('Error getting structure bonuses:', error);
    return {};
  }
}

/**
 * Get rig effects from dgm attributes
 * @param {number} typeId - Rig type ID
 * @returns {Promise<Array>} Rig effects
 */
async function getRigEffects(typeId) {
  try {
    const db = await getDatabase();

    return new Promise((resolve, reject) => {
      const query = `
        SELECT
          dat.attributeID,
          dat.attributeName,
          dat.displayName,
          dta.valueInt,
          dta.valueFloat
        FROM dgmTypeAttributes dta
        JOIN dgmAttributeTypes dat ON dta.attributeID = dat.attributeID
        WHERE dta.typeID = ?
        AND (
          dat.displayName LIKE '%Bonus%'
          OR dat.displayName LIKE '%bonus%'
          OR dat.displayName LIKE 'Bonus to%'
        )
        ORDER BY dat.displayName
      `;

      db.all(query, [typeId], (err, rows) => {
        if (err) {
          console.error('Error querying rig effects:', err);
          reject(err);
        } else {
          const effects = rows.map(row => ({
            attributeName: row.attributeName,
            displayName: row.displayName || row.attributeName,
            value: row.valueInt || row.valueFloat
          })).filter(effect => effect.value !== null && effect.value !== undefined);

          resolve(effects);
        }
      });
    });
  } catch (error) {
    console.error('Error getting rig effects:', error);
    return [];
  }
}

/**
 * Get system security status
 * @param {number} systemId - Solar system ID
 * @returns {Promise<number>} Security status (0.0 to 1.0, or negative for null/wormhole)
 */
async function getSystemSecurityStatus(systemId) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.get(
        'SELECT security FROM mapSolarSystems WHERE solarSystemID = ?',
        [systemId],
        (err, row) => {
          if (err) {
            console.error('Error querying system security:', err);
            reject(err);
          } else {
            resolve(row ? row.security : 0.5); // Default to high-sec if not found
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting system security:', error);
    return 0.5; // Default to high-sec on error
  }
}

/**
 * Get volume for a single item type (packaged volume if available, otherwise regular volume)
 * @param {number} typeId - Type ID
 * @returns {Promise<number>} Volume in m³
 */
async function getItemVolume(typeId) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.get(
        `SELECT
          COALESCE(iv.volume, it.volume, 0) as volume
         FROM invTypes it
         LEFT JOIN invVolumes iv ON it.typeID = iv.typeID
         WHERE it.typeID = ?`,
        [typeId],
        (err, row) => {
          if (err) {
            console.error('Error querying item volume:', err);
            reject(err);
          } else {
            resolve(row ? (row.volume || 0) : 0);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting item volume:', error);
    return 0;
  }
}

/**
 * Get volumes for multiple item types (packaged volume if available, otherwise regular volume)
 * @param {number[]} typeIds - Array of type IDs
 * @returns {Promise<Object>} Map of typeId -> volume
 */
async function getItemVolumes(typeIds) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      const placeholders = typeIds.map(() => '?').join(',');
      database.all(
        `SELECT
          it.typeID,
          COALESCE(iv.volume, it.volume, 0) as volume
         FROM invTypes it
         LEFT JOIN invVolumes iv ON it.typeID = iv.typeID
         WHERE it.typeID IN (${placeholders})`,
        typeIds,
        (err, rows) => {
          if (err) {
            console.error('Error querying item volumes:', err);
            reject(err);
          } else {
            const volumeMap = {};
            rows.forEach(row => {
              volumeMap[row.typeID] = row.volume || 0;
            });
            resolve(volumeMap);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting item volumes:', error);
    return {};
  }
}

/**
 * Get category and group information for multiple item types
 * @param {number[]} typeIds - Array of type IDs
 * @returns {Promise<Object>} Map of typeId -> { categoryID, groupID, categoryName, groupName }
 */
async function getTypeCategoryInfo(typeIds) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      if (!typeIds || typeIds.length === 0) {
        resolve({});
        return;
      }

      const placeholders = typeIds.map(() => '?').join(',');
      database.all(
        `SELECT
          t.typeID,
          g.groupID,
          g.categoryID,
          g.groupName,
          c.categoryName
         FROM invTypes t
         LEFT JOIN invGroups g ON t.groupID = g.groupID
         LEFT JOIN invCategories c ON g.categoryID = c.categoryID
         WHERE t.typeID IN (${placeholders})`,
        typeIds,
        (err, rows) => {
          if (err) {
            console.error('Error querying type category info:', err);
            reject(err);
          } else {
            const categoryMap = {};
            rows.forEach(row => {
              categoryMap[row.typeID] = {
                categoryID: row.categoryID || null,
                groupID: row.groupID || null,
                categoryName: row.categoryName || 'Unknown',
                groupName: row.groupName || 'Unknown'
              };
            });

            // Fill in missing types with defaults
            typeIds.forEach(id => {
              if (!categoryMap[id]) {
                categoryMap[id] = {
                  categoryID: null,
                  groupID: null,
                  categoryName: 'Unknown',
                  groupName: 'Unknown'
                };
              }
            });

            resolve(categoryMap);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting type category info:', error);
    return {};
  }
}

/**
 * Get location name by location ID
 * @param {number} locationId - Location ID (station or structure)
 * @returns {Promise<string|null>} Location name or null if not found
 */
async function getLocationName(locationId) {
  try {
    const database = await getDatabase();

    console.log(`Getting location name for location ID ${locationId}`);
    return new Promise((resolve, reject) => {
      database.get(
        `SELECT stationName
         FROM staStations
         WHERE stationID = ?`,
        [locationId],
        (err, row) => {
          if (err) {
            console.error('Error querying location name:', err);
            reject(err);
          } else {
            resolve(row ? row.stationName : null);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting location name:', error);
    return null;
  }
}

/**
 * Detect location type based on ID range
 * @param {number} locationId - Location ID
 * @returns {string} Location type: 'asset', 'npc-station', 'structure', 'system', 'unknown'
 */
function detectLocationType(locationId) {
  if (locationId >= 1000000000000) {
    return 'asset'; // Could be container or structure
  } else if (locationId >= 60000000 && locationId <= 69999999) {
    return 'npc-station';
  } else if (locationId >= 30000000 && locationId <= 39999999) {
    return 'system';
  }
  return 'unknown';
}

/**
 * Get system name from station ID
 * @param {number} stationId - Station ID
 * @returns {Promise<string|null>} System name or null if not found
 */
async function getSystemNameFromStation(stationId) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.get(
        `SELECT s.solarSystemName
         FROM staStations st
         JOIN mapSolarSystems s ON st.solarSystemID = s.solarSystemID
         WHERE st.stationID = ?`,
        [stationId],
        (err, row) => {
          if (err) {
            console.error('Error querying system name from station:', err);
            reject(err);
          } else {
            resolve(row ? row.solarSystemName : null);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting system name from station:', error);
    return null;
  }
}

/**
 * Get system name by system ID
 * @param {number} systemId - Solar system ID
 * @returns {Promise<string|null>} System name or null if not found
 */
async function getSystemName(systemId) {
  try {
    const database = await getDatabase();

    return new Promise((resolve, reject) => {
      database.get(
        'SELECT solarSystemName FROM mapSolarSystems WHERE solarSystemID = ?',
        [systemId],
        (err, row) => {
          if (err) {
            console.error('Error querying system name:', err);
            reject(err);
          } else {
            resolve(row ? row.solarSystemName : null);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error getting system name:', error);
    return null;
  }
}

module.exports = {
  getDatabase,
  closeDatabase,
  getSkillName,
  getSkillNames,
  getAllSkills,
  getSkillGroup,
  searchSkills,
  getBlueprintName,
  getBlueprintNames,
  getTypeName,
  getTypeNames,
  getAllBlueprints,
  searchBlueprints,
  getAllRegions,
  getAllSystems,
  searchSystems,
  getStationsInSystem,
  getTradeHubs,
  searchMarketItems,
  getItemDetails,
  getStructureTypes,
  getStructureRigs,
  getStructureBonuses,
  getRigEffects,
  getSystemSecurityStatus,
  getItemVolume,
  getItemVolumes,
  getTypeCategoryInfo,
  getLocationName,
  detectLocationType,
  getSystemNameFromStation,
  getSystemName,
};
