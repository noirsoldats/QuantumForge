const { refreshAccessToken, isTokenExpired } = require('./esi-auth');
const { getCharacter, updateCharacterTokens } = require('./settings-manager');
const { getUserAgent } = require('./user-agent');
const { recordESICallStart, recordESICallSuccess, recordESICallError } = require('./esi-status-tracker');

/**
 * Fetch character skills from ESI
 * @param {number} characterId - Character ID
 * @returns {Promise<Object>} Skills data
 */
async function fetchCharacterSkills(characterId) {
  const callKey = `character_${characterId}_skills`;

  // Record call start
  recordESICallStart(callKey, {
    category: 'character',
    characterId: characterId,
    endpointType: 'skills',
    endpointLabel: 'Skills'
  });

  const startTime = Date.now();

  try {
    let character = getCharacter(characterId);

    if (!character) {
      const errorMsg = 'Character not found';
      recordESICallError(callKey, errorMsg, 'NOT_FOUND', startTime);
      throw new Error(errorMsg);
    }

    // Check if token is expired and refresh if needed
    if (isTokenExpired(character.expiresAt)) {
      console.log('Token expired, refreshing...');
      const newTokens = await refreshAccessToken(character.refreshToken);
      updateCharacterTokens(characterId, newTokens);
      character = getCharacter(characterId);
    }

    // Fetch skills from ESI
    const response = await fetch(
      `https://esi.evetech.net/latest/characters/${characterId}/skills/?datasource=tranquility`,
      {
        headers: {
          'Authorization': `Bearer ${character.accessToken}`,
          'User-Agent': getUserAgent(),
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      const errorMsg = `Failed to fetch skills: ${response.status} ${errorText}`;
      recordESICallError(callKey, errorMsg, response.status.toString(), startTime);
      throw new Error(errorMsg);
    }

    const skillsData = await response.json();

    // Get cache expiry from response headers
    const expiresHeader = response.headers.get('expires');
    let cacheExpiresAt = null;

    if (expiresHeader) {
      const expiresDate = new Date(expiresHeader);
      cacheExpiresAt = expiresDate.getTime();
      console.log('ESI skills cache expires at:', expiresDate.toISOString());
    }

    // Transform skills array into a map for easier access
    const skillsMap = {};
    if (skillsData.skills) {
      skillsData.skills.forEach(skill => {
        skillsMap[skill.skill_id] = {
          skillId: skill.skill_id,
          activeSkillLevel: skill.active_skill_level,
          trainedSkillLevel: skill.trained_skill_level,
          skillpointsInSkill: skill.skillpoints_in_skill,
        };
      });
    }

    // Record success
    const responseSize = JSON.stringify(skillsData).length;
    recordESICallSuccess(callKey, cacheExpiresAt, null, responseSize, startTime);

    return {
      totalSp: skillsData.total_sp || 0,
      unallocatedSp: skillsData.unallocated_sp || 0,
      skills: skillsMap,
      lastUpdated: Date.now(),
      cacheExpiresAt: cacheExpiresAt,
    };
  } catch (error) {
    console.error('Error fetching character skills:', error);
    if (!error.message.includes('Character not found') && !error.message.includes('Failed to fetch skills')) {
      recordESICallError(callKey, error.message, 'NETWORK_ERROR', startTime);
    }
    throw error;
  }
}

/**
 * Get skill name from SDE database
 * @param {number} skillId - Skill type ID
 * @param {Object} db - SQLite database connection
 * @returns {Promise<string>} Skill name
 */
async function getSkillName(skillId, db) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT typeName FROM invTypes WHERE typeID = ?',
      [skillId],
      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? row.typeName : `Unknown Skill (${skillId})`);
        }
      }
    );
  });
}

/**
 * Get all skills with names from SDE
 * @param {Object} db - SQLite database connection
 * @returns {Promise<Array>} Array of skills with names
 */
async function getAllSkillsFromSDE(db) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT typeID, typeName, description
       FROM invTypes
       WHERE categoryID = 16
       ORDER BY typeName`,
      [],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      }
    );
  });
}

/**
 * Get skill group information
 * @param {number} skillId - Skill type ID
 * @param {Object} db - SQLite database connection
 * @returns {Promise<Object>} Skill group info
 */
async function getSkillGroup(skillId, db) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT g.groupID, g.groupName, g.categoryID
       FROM invTypes t
       JOIN invGroups g ON t.groupID = g.groupID
       WHERE t.typeID = ?`,
      [skillId],
      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row || null);
        }
      }
    );
  });
}

module.exports = {
  fetchCharacterSkills,
  getSkillName,
  getAllSkillsFromSDE,
  getSkillGroup,
};
