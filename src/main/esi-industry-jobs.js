const { getCharacter } = require('./settings-manager');
const { getCharacterDatabase } = require('./character-database');
const { esiFetch } = require('./esi-fetch');

/**
 * Fetch character industry jobs from ESI
 * @param {number} characterId - Character ID
 * @param {boolean} includeCompleted - Whether to include completed jobs (default: false)
 * @returns {Promise<Object>} Industry jobs data with metadata
 */
async function fetchCharacterIndustryJobs(characterId, includeCompleted = false) {
  const callKey = `character_${characterId}_industry_jobs`;

  const includeParam = includeCompleted ? 'include_completed=true' : '';
  const url = `https://esi.evetech.net/latest/characters/${characterId}/industry/jobs/?datasource=tranquility${includeParam ? '&' + includeParam : ''}`;

  console.log(`Fetching character industry jobs (includeCompleted: ${includeCompleted})...`);

  const result = await esiFetch('industry_jobs', callKey, url, {
    characterId,
    category: 'character',
    endpointLabel: 'Industry Jobs',
  });

  if (result.skipped) {
    return {
      jobs: [],
      characterId,
      lastUpdated: Date.now(),
      cacheExpiresAt: null,
      skipped: true,
    };
  }

  const jobs = result.data || [];
  console.log(`Fetched ${jobs.length} industry jobs`);

  return {
    jobs,
    characterId,
    lastUpdated: Date.now(),
    cacheExpiresAt: result.cacheExpiresAt,
  };
}

/**
 * Fetch corporation industry jobs from ESI
 * @param {number} characterId - Character ID (used for authentication)
 * @param {number} corporationId - Corporation ID
 * @param {boolean} includeCompleted - Whether to include completed jobs (default: false)
 * @returns {Promise<Object>} Industry jobs data with metadata
 */
async function fetchCorporationIndustryJobs(characterId, corporationId, includeCompleted = false) {
  const callKey = `corporation_${corporationId}_industry_jobs`;
  const emptyResult = { jobs: [], corporationId, characterId, lastUpdated: Date.now(), cacheExpiresAt: null };

  // Cheap scope pre-check before touching the network / status tracker.
  const character = getCharacter(characterId);
  if (!character) {
    throw Object.assign(new Error('Character not found'), { code: 'NOT_FOUND', characterId });
  }
  if (!character.scopes || !character.scopes.includes('esi-industry.read_corporation_jobs.v1')) {
    console.log('Character does not have corporation industry jobs scope, skipping...');
    return emptyResult;
  }

  const includeParam = includeCompleted ? 'include_completed=true' : '';
  const url = `https://esi.evetech.net/latest/corporations/${corporationId}/industry/jobs/?datasource=tranquility${includeParam ? '&' + includeParam : ''}`;

  console.log(`Fetching corporation ${corporationId} industry jobs (includeCompleted: ${includeCompleted})...`);

  try {
    const result = await esiFetch('corporation_industry_jobs', callKey, url, {
      characterId,
      corporationId,
      category: 'corporation',
      endpointLabel: 'Corporation Industry Jobs',
    });

    if (result.skipped) {
      return { ...emptyResult, skipped: true };
    }
    // Role-based 403 (not a director) — esiFetch returns empty silently.
    if (result.roleForbidden) {
      console.log('Character does not have permission to view corporation industry jobs (requires director role)');
      return emptyResult;
    }

    const jobs = result.data || [];
    console.log(`Fetched ${jobs.length} corporation industry jobs across ${result.pages} page(s)`);

    return {
      jobs,
      corporationId,
      characterId,
      isCorporation: true,
      lastUpdated: Date.now(),
      cacheExpiresAt: result.cacheExpiresAt,
    };
  } catch (error) {
    // Re-throw auth errors so IPC handlers can broadcast them to renderers
    if (error.code === 'ESI_TOKEN_REFRESH_FAILED' || error.code === 'ESI_SCOPE_ERROR') {
      throw error;
    }
    // Rate-limited or network error — return empty so personal jobs still work.
    console.error('Error fetching corporation industry jobs:', error);
    return emptyResult;
  }
}

/**
 * Save industry jobs to database
 * @param {Object} jobsData - Jobs data from ESI
 * @param {boolean} jobsData.isCorporation - Whether these are corporation jobs
 * @param {number} jobsData.corporationId - Corporation ID (for corp jobs)
 * @returns {boolean} Success status
 */
function saveIndustryJobs(jobsData) {
  try {
    const db = getCharacterDatabase();

    // Begin transaction
    db.exec('BEGIN TRANSACTION');

    try {
      // Durable append/upsert log — never blind-delete. ESI's include_completed
      // only returns a rolling recent window, so a delete-then-reinsert would
      // silently drop completed jobs that aged out of that window and weaken
      // plan matching for older plans. Instead we upsert by job_id (the PK,
      // globally unique in EVE) so completed jobs are retained and their status
      // refreshes in place as they progress (active -> delivered).
      const insertJob = db.prepare(`
        INSERT INTO esi_industry_jobs (
          job_id, character_id, installer_id, facility_id, activity_id,
          blueprint_type_id, runs, status, start_date, end_date,
          completed_date, last_updated, cache_expires_at, is_corporation, corporation_id,
          cost, product_type_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          status = excluded.status,
          completed_date = excluded.completed_date,
          end_date = excluded.end_date,
          last_updated = excluded.last_updated,
          cache_expires_at = excluded.cache_expires_at,
          cost = excluded.cost,
          product_type_id = excluded.product_type_id
      `);

      const isCorporation = jobsData.isCorporation ? 1 : 0;
      const corporationId = jobsData.corporationId || null;

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
          jobsData.cacheExpiresAt || null,
          isCorporation,
          corporationId,
          job.cost != null ? job.cost : null,
          job.product_type_id != null ? job.product_type_id : null
        );
      }

      db.exec('COMMIT');
      const logMsg = jobsData.isCorporation
        ? `Saved ${jobsData.jobs.length} corporation industry jobs for corp ${jobsData.corporationId}`
        : `Saved ${jobsData.jobs.length} personal industry jobs for character ${jobsData.characterId}`;
      console.log(logMsg);

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
 * @param {Object} filters - Optional filters (status, activityId, blueprintTypeId, includeCorporation, corporationId)
 * @returns {Array} Industry jobs
 */
function getIndustryJobs(characterId, filters = {}) {
  try {
    const db = getCharacterDatabase();

    let query = '';
    const params = [];

    // Build query based on whether we want corp jobs included
    if (filters.includeCorporation && filters.corporationIds && filters.corporationIds.length > 0) {
      // Query personal jobs for character AND corporation jobs for specified corps
      const corpPlaceholders = filters.corporationIds.map(() => '?').join(',');
      query = `SELECT * FROM esi_industry_jobs WHERE (
        (character_id = ? AND is_corporation = 0)
        OR (corporation_id IN (${corpPlaceholders}) AND is_corporation = 1)
      )`;
      params.push(characterId);
      params.push(...filters.corporationIds);
    } else if (filters.corporationId) {
      // Query only corporation jobs for a specific corporation
      query = 'SELECT * FROM esi_industry_jobs WHERE corporation_id = ? AND is_corporation = 1';
      params.push(filters.corporationId);
    } else {
      // Default: only personal jobs for character
      query = 'SELECT * FROM esi_industry_jobs WHERE character_id = ? AND is_corporation = 0';
      params.push(characterId);
    }

    // Apply additional filters
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
      isCorporation: row.is_corporation === 1,
      corporationId: row.corporation_id,
      cost: row.cost,
      productTypeId: row.product_type_id,
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
  fetchCorporationIndustryJobs,
  saveIndustryJobs,
  getIndustryJobs,
  getIndustryJobsCacheStatus,
};
