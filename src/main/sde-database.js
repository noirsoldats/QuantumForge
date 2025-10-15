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
  getAllBlueprints,
  searchBlueprints,
  getAllRegions,
  getAllSystems,
  searchSystems,
  getStationsInSystem,
  getTradeHubs,
  searchMarketItems,
  getItemDetails,
};
