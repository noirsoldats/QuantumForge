const { refreshAccessToken, isTokenExpired } = require('./esi-auth');
const { getCharacter, updateCharacterTokens } = require('./settings-manager');
const { getUserAgent } = require('./user-agent');
const { getCharacterDatabase } = require('./character-database');
const { recordESICallStart, recordESICallSuccess, recordESICallError } = require('./esi-status-tracker');

/**
 * Fetch character industry jobs from ESI
 * @param {number} characterId - Character ID
 * @param {boolean} includeCompleted - Whether to include completed jobs (default: false)
 * @returns {Promise<Object>} Industry jobs data with metadata
 */
async function fetchCharacterIndustryJobs(characterId, includeCompleted = false) {
  const callKey = `character_${characterId}_industry_jobs`;

  recordESICallStart(callKey, {
    category: 'character',
    characterId: characterId,
    endpointType: 'industry_jobs',
    endpointLabel: 'Industry Jobs'
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

    // Fetch industry jobs from ESI
    let allJobsData = [];
    let cacheExpiresAt = null;

    const includeParam = includeCompleted ? 'include_completed=true' : '';
    const url = `https://esi.evetech.net/latest/characters/${characterId}/industry/jobs/?datasource=tranquility${includeParam ? '&' + includeParam : ''}`;

    console.log(`Fetching character industry jobs (includeCompleted: ${includeCompleted})...`);

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${character.accessToken}`,
        'User-Agent': getUserAgent(),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errorMsg = `Failed to fetch industry jobs: ${response.status} ${errorText}`;
      recordESICallError(callKey, errorMsg, response.status.toString(), startTime);
      throw new Error(errorMsg);
    }

    const jobsData = await response.json();
    allJobsData = jobsData;

    // Get cache expiry from response headers
    const expiresHeader = response.headers.get('expires');
    if (expiresHeader) {
      const expiresDate = new Date(expiresHeader);
      cacheExpiresAt = expiresDate.getTime();
      console.log('ESI industry jobs cache expires at:', expiresDate.toISOString());
    }

    console.log(`Fetched ${allJobsData.length} industry jobs`);

    const responseSize = JSON.stringify(allJobsData).length;
    recordESICallSuccess(callKey, cacheExpiresAt, null, responseSize, startTime);

    return {
      jobs: allJobsData,
      characterId: characterId,
      lastUpdated: Date.now(),
      cacheExpiresAt: cacheExpiresAt,
    };
  } catch (error) {
    console.error('Error fetching character industry jobs:', error);
    if (!error.message.includes('Character not found') && !error.message.includes('Failed to fetch')) {
      recordESICallError(callKey, error.message, 'NETWORK_ERROR', startTime);
    }
    throw error;
  }
}

/**
 * Save industry jobs to database
 * @param {Object} jobsData - Jobs data from ESI
 * @returns {boolean} Success status
 */
function saveIndustryJobs(jobsData) {
  try {
    const db = getCharacterDatabase();

    // Begin transaction
    db.exec('BEGIN TRANSACTION');

    try {
      // Delete existing jobs for this character
      db.prepare('DELETE FROM esi_industry_jobs WHERE character_id = ?').run(jobsData.characterId);

      // Insert new jobs
      const insertJob = db.prepare(`
        INSERT INTO esi_industry_jobs (
          job_id, character_id, installer_id, facility_id, activity_id,
          blueprint_type_id, runs, status, start_date, end_date,
          completed_date, last_updated, cache_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const job of jobsData.jobs) {
        // Convert date strings to Unix timestamps (milliseconds)
        const startDate = job.start_date ? new Date(job.start_date).getTime() : null;
        const endDate = job.end_date ? new Date(job.end_date).getTime() : null;
        const completedDate = job.completed_date ? new Date(job.completed_date).getTime() : null;

        insertJob.run(
          job.job_id,
          jobsData.characterId,
          job.installer_id,
          job.facility_id,
          job.activity_id,
          job.blueprint_type_id,
          job.runs,
          job.status,
          startDate,
          endDate,
          completedDate,
          jobsData.lastUpdated,
          jobsData.cacheExpiresAt || null
        );
      }

      db.exec('COMMIT');
      console.log(`Saved ${jobsData.jobs.length} industry jobs for character ${jobsData.characterId}`);

      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error saving industry jobs to database:', error);
    return false;
  }
}

/**
 * Get industry jobs from database
 * @param {number} characterId - Character ID
 * @param {Object} filters - Optional filters (status, activityId, blueprintTypeId)
 * @returns {Array} Industry jobs
 */
function getIndustryJobs(characterId, filters = {}) {
  try {
    const db = getCharacterDatabase();

    let query = 'SELECT * FROM esi_industry_jobs WHERE character_id = ?';
    const params = [characterId];

    // Apply filters
    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }

    if (filters.activityId) {
      query += ' AND activity_id = ?';
      params.push(filters.activityId);
    }

    if (filters.blueprintTypeId) {
      query += ' AND blueprint_type_id = ?';
      params.push(filters.blueprintTypeId);
    }

    query += ' ORDER BY start_date DESC';

    const rows = db.prepare(query).all(...params);

    return rows.map(row => ({
      jobId: row.job_id,
      characterId: row.character_id,
      installerId: row.installer_id,
      facilityId: row.facility_id,
      activityId: row.activity_id,
      blueprintTypeId: row.blueprint_type_id,
      runs: row.runs,
      status: row.status,
      startDate: row.start_date,
      endDate: row.end_date,
      completedDate: row.completed_date,
      lastUpdated: row.last_updated,
      cacheExpiresAt: row.cache_expires_at,
    }));
  } catch (error) {
    console.error('Error getting industry jobs from database:', error);
    return [];
  }
}

/**
 * Get industry jobs cache status for a character
 * @param {number} characterId - Character ID
 * @returns {Object} Cache status with isCached, expiresAt, and remainingSeconds
 */
function getIndustryJobsCacheStatus(characterId) {
  try {
    const db = getCharacterDatabase();

    const job = db.prepare(`
      SELECT cache_expires_at
      FROM esi_industry_jobs
      WHERE character_id = ? AND cache_expires_at IS NOT NULL
      LIMIT 1
    `).get(characterId);

    if (!job || !job.cache_expires_at) {
      return { isCached: false, expiresAt: null, remainingSeconds: 0 };
    }

    const now = Date.now();
    const expiresAt = job.cache_expires_at;
    const remainingMs = expiresAt - now;
    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));

    return {
      isCached: remainingMs > 0,
      expiresAt: expiresAt,
      remainingSeconds: remainingSeconds,
    };
  } catch (error) {
    console.error('Error getting industry jobs cache status:', error);
    return { isCached: false, expiresAt: null, remainingSeconds: 0 };
  }
}

module.exports = {
  fetchCharacterIndustryJobs,
  saveIndustryJobs,
  getIndustryJobs,
  getIndustryJobsCacheStatus,
};
