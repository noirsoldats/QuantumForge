// Plan Matching System - Smart heuristic-based matching for jobs and transactions
const { v4: uuidv4 } = require('uuid');
const { getCharacterDatabase } = require('./character-database');

/**
 * Match industry jobs to a manufacturing plan's blueprints
 * Uses heuristic scoring to determine confidence
 *
 * Matching Heuristics (confidence 0.0 - 1.0):
 * - Blueprint Type Match (Required) - 0.0 if no match
 * - Exact Runs Match - +0.4 if job runs match plan blueprint runs
 * - Facility Match - +0.3 if job facility matches plan blueprint facility
 * - Time Window - +0.2 if job started within 7 days of plan update
 * - Recent Start - +0.1 if within 24 hours
 *
 * @param {string} planId - Plan ID to match jobs against
 * @param {Object} options - Matching options
 * @param {number} options.characterId - Character ID for filtering jobs
 * @param {number} options.maxDaysAgo - Max days to look back (default: 30)
 * @param {number} options.minConfidence - Minimum confidence threshold (default: 0.5)
 * @returns {Array} Array of potential matches with confidence scores
 */
function matchJobsToPlan(planId, options = {}) {
  const { characterId, maxDaysAgo = 30, minConfidence = 0.5 } = options;

  const db = getCharacterDatabase();

  try {
    // Get plan details
    const plan = db.prepare('SELECT * FROM manufacturing_plans WHERE plan_id = ?').get(planId);
    if (!plan) {
      throw new Error('Plan not found');
    }

    // Get plan blueprints
    const planBlueprints = db.prepare(`
      SELECT * FROM plan_blueprints
      WHERE plan_id = ?
      ORDER BY added_at DESC
    `).all(planId);

    if (planBlueprints.length === 0) {
      return [];
    }

    // Get industry jobs for character within time window
    const timeWindow = Date.now() - (maxDaysAgo * 24 * 60 * 60 * 1000);
    const jobs = db.prepare(`
      SELECT * FROM esi_industry_jobs
      WHERE character_id = ?
        AND activity_id = 1
        AND start_date >= ?
      ORDER BY start_date DESC
    `).all(characterId, Math.floor(timeWindow / 1000));

    if (jobs.length === 0) {
      return [];
    }

    // Check for existing matches (don't re-match)
    const existingMatches = db.prepare(`
      SELECT job_id FROM plan_job_matches
      WHERE plan_id = ? AND status IN ('pending', 'confirmed')
    `).all(planId).map(m => m.job_id);

    // Match jobs to plan blueprints
    const matches = [];

    for (const job of jobs) {
      // Skip if already matched
      if (existingMatches.includes(job.job_id)) {
        continue;
      }

      // Find matching plan blueprints (same blueprint type)
      const matchingBlueprints = planBlueprints.filter(pb =>
        pb.blueprint_type_id === job.blueprint_type_id
      );

      if (matchingBlueprints.length === 0) {
        continue;
      }

      // Calculate confidence for each matching blueprint
      for (const planBlueprint of matchingBlueprints) {
        const matchScore = calculateJobMatchScore(job, planBlueprint, plan);

        if (matchScore.confidence >= minConfidence) {
          matches.push({
            job,
            planBlueprint,
            ...matchScore
          });
        }
      }
    }

    return matches.sort((a, b) => b.confidence - a.confidence);

  } catch (error) {
    console.error('Error matching jobs to plan:', error);
    throw error;
  }
}

/**
 * Calculate confidence score for a job-blueprint match
 */
function calculateJobMatchScore(job, planBlueprint, plan) {
  let confidence = 0.0;
  const reasons = [];

  // Base confidence for blueprint type match
  confidence = 0.3;
  reasons.push({ criterion: 'blueprint_type', match: true, weight: 0.3 });

  // Exact runs match
  if (job.runs === planBlueprint.runs) {
    confidence += 0.4;
    reasons.push({ criterion: 'exact_runs', match: true, weight: 0.4, value: job.runs });
  } else {
    reasons.push({ criterion: 'exact_runs', match: false, weight: 0.0, expected: planBlueprint.runs, actual: job.runs });
  }

  // Facility match
  if (planBlueprint.facility_snapshot) {
    try {
      const facilitySnapshot = JSON.parse(planBlueprint.facility_snapshot);
      // Check if job facility matches (would need to lookup facility by ID)
      // For now, we can't reliably match without more facility data
      reasons.push({ criterion: 'facility', match: 'unknown', weight: 0.0 });
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Time window match (job started within 7 days of plan update)
  const planUpdated = plan.updated_at * 1000;
  const jobStarted = job.start_date * 1000;
  const daysDiff = Math.abs((jobStarted - planUpdated) / (1000 * 60 * 60 * 24));

  if (daysDiff <= 7) {
    confidence += 0.2;
    reasons.push({ criterion: 'time_window_7d', match: true, weight: 0.2, daysDiff: daysDiff.toFixed(1) });
  } else {
    reasons.push({ criterion: 'time_window_7d', match: false, weight: 0.0, daysDiff: daysDiff.toFixed(1) });
  }

  // Recent start bonus (within 24 hours)
  if (daysDiff <= 1) {
    confidence += 0.1;
    reasons.push({ criterion: 'recent_start_24h', match: true, weight: 0.1 });
  }

  // Cap confidence at 1.0
  confidence = Math.min(confidence, 1.0);

  return {
    confidence,
    matchReason: JSON.stringify(reasons)
  };
}

/**
 * Save job matches to database
 */
function saveJobMatches(matches) {
  const db = getCharacterDatabase();

  const insert = db.prepare(`
    INSERT INTO plan_job_matches (
      match_id, plan_id, plan_blueprint_id, job_id,
      match_confidence, match_reason, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);

  const saveMany = db.transaction((matchArray) => {
    for (const match of matchArray) {
      const matchId = uuidv4();
      insert.run(
        matchId,
        match.planBlueprint.plan_id,
        match.planBlueprint.plan_blueprint_id,
        match.job.job_id,
        match.confidence,
        match.matchReason
      );
    }
  });

  try {
    saveMany(matches);
    return { success: true, count: matches.length };
  } catch (error) {
    console.error('Error saving job matches:', error);
    throw error;
  }
}

/**
 * Match wallet transactions to plan materials and products
 *
 * Material Matching:
 * - Type in plan materials
 * - is_buy = 1 (purchase)
 * - Within timeline (after plan creation, before completion)
 * - Quantity <= remaining needs
 * - Price within 20% of frozen price
 *
 * Product Matching:
 * - Type in plan products
 * - is_buy = 0 (sale)
 * - After job completion (if job matched)
 * - Quantity <= expected output
 * - Price within 20% of frozen price
 */
function matchTransactionsToPlan(planId, options = {}) {
  const { characterId, maxDaysAgo = 30, minConfidence = 0.5 } = options;

  const db = getCharacterDatabase();

  try {
    // Get plan details
    const plan = db.prepare('SELECT * FROM manufacturing_plans WHERE plan_id = ?').get(planId);
    if (!plan) {
      throw new Error('Plan not found');
    }

    // Get plan materials and products
    const materials = db.prepare('SELECT * FROM plan_materials WHERE plan_id = ?').all(planId);
    const products = db.prepare('SELECT * FROM plan_products WHERE plan_id = ?').all(planId);

    if (materials.length === 0 && products.length === 0) {
      return [];
    }

    // Get wallet transactions within time window
    const timeWindow = Date.now() - (maxDaysAgo * 24 * 60 * 60 * 1000);
    const transactions = db.prepare(`
      SELECT * FROM esi_wallet_transactions
      WHERE character_id = ?
        AND date >= ?
      ORDER BY date DESC
    `).all(characterId, Math.floor(timeWindow / 1000));

    if (transactions.length === 0) {
      return [];
    }

    // Check for existing matches
    const existingMatches = db.prepare(`
      SELECT transaction_id FROM plan_transaction_matches
      WHERE plan_id = ? AND status IN ('pending', 'confirmed')
    `).all(planId).map(m => m.transaction_id);

    const matches = [];

    // Match material purchases
    for (const material of materials) {
      const materialTransactions = transactions.filter(t =>
        t.type_id === material.type_id &&
        t.is_buy === 1 &&
        !existingMatches.includes(t.transaction_id) &&
        t.date >= plan.created_at
      );

      for (const transaction of materialTransactions) {
        const matchScore = calculateTransactionMatchScore(
          transaction,
          material,
          'material_buy',
          plan
        );

        if (matchScore.confidence >= minConfidence) {
          matches.push({
            transaction,
            planItem: material,
            matchType: 'material_buy',
            ...matchScore
          });
        }
      }
    }

    // Match product sales
    for (const product of products) {
      const productTransactions = transactions.filter(t =>
        t.type_id === product.type_id &&
        t.is_buy === 0 &&
        !existingMatches.includes(t.transaction_id) &&
        t.date >= plan.created_at
      );

      for (const transaction of productTransactions) {
        const matchScore = calculateTransactionMatchScore(
          transaction,
          product,
          'product_sell',
          plan
        );

        if (matchScore.confidence >= minConfidence) {
          matches.push({
            transaction,
            planItem: product,
            matchType: 'product_sell',
            ...matchScore
          });
        }
      }
    }

    return matches.sort((a, b) => b.confidence - a.confidence);

  } catch (error) {
    console.error('Error matching transactions to plan:', error);
    throw error;
  }
}

/**
 * Calculate confidence score for transaction match
 */
function calculateTransactionMatchScore(transaction, planItem, matchType, plan) {
  let confidence = 0.3; // Base confidence for type match
  const reasons = [];

  reasons.push({ criterion: 'type_match', match: true, weight: 0.3 });

  // Direction match (buy for materials, sell for products)
  const expectedBuy = matchType === 'material_buy' ? 1 : 0;
  if (transaction.is_buy === expectedBuy) {
    confidence += 0.3;
    reasons.push({ criterion: 'direction', match: true, weight: 0.3 });
  } else {
    reasons.push({ criterion: 'direction', match: false, weight: 0.0 });
  }

  // Price within 20% of frozen price
  if (planItem.base_price) {
    const priceDiff = Math.abs(transaction.unit_price - planItem.base_price) / planItem.base_price;
    if (priceDiff <= 0.2) {
      confidence += 0.3;
      reasons.push({
        criterion: 'price_match_20pct',
        match: true,
        weight: 0.3,
        diff: (priceDiff * 100).toFixed(1) + '%'
      });
    } else {
      reasons.push({
        criterion: 'price_match_20pct',
        match: false,
        weight: 0.0,
        diff: (priceDiff * 100).toFixed(1) + '%'
      });
    }
  }

  // Timing match
  const planCreated = plan.created_at * 1000;
  const transactionDate = transaction.date * 1000;
  const daysSinceCreation = (transactionDate - planCreated) / (1000 * 60 * 60 * 24);

  if (daysSinceCreation >= 0 && daysSinceCreation <= 14) {
    confidence += 0.1;
    reasons.push({
      criterion: 'timing_14d',
      match: true,
      weight: 0.1,
      daysSinceCreation: daysSinceCreation.toFixed(1)
    });
  } else {
    reasons.push({
      criterion: 'timing_14d',
      match: false,
      weight: 0.0,
      daysSinceCreation: daysSinceCreation.toFixed(1)
    });
  }

  confidence = Math.min(confidence, 1.0);

  return {
    confidence,
    matchReason: JSON.stringify(reasons)
  };
}

/**
 * Save transaction matches to database
 */
function saveTransactionMatches(matches) {
  const db = getCharacterDatabase();

  const insert = db.prepare(`
    INSERT INTO plan_transaction_matches (
      match_id, plan_id, transaction_id, type_id, match_type,
      quantity, match_confidence, match_reason, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);

  const saveMany = db.transaction((matchArray) => {
    for (const match of matchArray) {
      const matchId = uuidv4();
      insert.run(
        matchId,
        match.planItem.plan_id,
        match.transaction.transaction_id,
        match.transaction.type_id,
        match.matchType,
        match.transaction.quantity,
        match.confidence,
        match.matchReason
      );
    }
  });

  try {
    saveMany(matches);
    return { success: true, count: matches.length };
  } catch (error) {
    console.error('Error saving transaction matches:', error);
    throw error;
  }
}

/**
 * Confirm a job match
 */
function confirmJobMatch(matchId) {
  const db = getCharacterDatabase();

  try {
    const stmt = db.prepare(`
      UPDATE plan_job_matches
      SET status = 'confirmed',
          confirmed_at = ?,
          confirmed_by_user = 1
      WHERE match_id = ?
    `);

    const result = stmt.run(Math.floor(Date.now() / 1000), matchId);
    return { success: result.changes > 0 };
  } catch (error) {
    console.error('Error confirming job match:', error);
    throw error;
  }
}

/**
 * Reject a job match
 */
function rejectJobMatch(matchId) {
  const db = getCharacterDatabase();

  try {
    const stmt = db.prepare(`
      UPDATE plan_job_matches
      SET status = 'rejected',
          confirmed_at = ?
      WHERE match_id = ?
    `);

    const result = stmt.run(Math.floor(Date.now() / 1000), matchId);
    return { success: result.changes > 0 };
  } catch (error) {
    console.error('Error rejecting job match:', error);
    throw error;
  }
}

/**
 * Confirm a transaction match
 */
function confirmTransactionMatch(matchId) {
  const db = getCharacterDatabase();

  try {
    const stmt = db.prepare(`
      UPDATE plan_transaction_matches
      SET status = 'confirmed',
          confirmed_at = ?,
          confirmed_by_user = 1
      WHERE match_id = ?
    `);

    const result = stmt.run(Math.floor(Date.now() / 1000), matchId);
    return { success: result.changes > 0 };
  } catch (error) {
    console.error('Error confirming transaction match:', error);
    throw error;
  }
}

/**
 * Reject a transaction match
 */
function rejectTransactionMatch(matchId) {
  const db = getCharacterDatabase();

  try {
    const stmt = db.prepare(`
      UPDATE plan_transaction_matches
      SET status = 'rejected',
          confirmed_at = ?
      WHERE match_id = ?
    `);

    const result = stmt.run(Math.floor(Date.now() / 1000), matchId);
    return { success: result.changes > 0 };
  } catch (error) {
    console.error('Error rejecting transaction match:', error);
    throw error;
  }
}

/**
 * Get all pending matches for a plan
 */
function getPendingMatches(planId) {
  const db = getCharacterDatabase();

  try {
    // Get job matches with explicit column selection to avoid collisions
    const jobMatchesRaw = db.prepare(`
      SELECT
        jm.match_id,
        jm.plan_id,
        jm.plan_blueprint_id,
        jm.job_id,
        jm.match_confidence,
        jm.match_reason,
        jm.status,
        ij.installer_id,
        ij.facility_id,
        ij.activity_id,
        ij.blueprint_type_id as job_blueprint_type_id,
        ij.runs as job_runs,
        ij.status as job_status,
        ij.start_date,
        ij.end_date,
        ij.completed_date,
        pb.blueprint_type_id as plan_blueprint_type_id,
        pb.runs as plan_runs,
        pb.me_level,
        pb.te_level
      FROM plan_job_matches jm
      JOIN esi_industry_jobs ij ON jm.job_id = ij.job_id
      JOIN plan_blueprints pb ON jm.plan_blueprint_id = pb.plan_blueprint_id
      WHERE jm.plan_id = ? AND jm.status = 'pending'
      ORDER BY jm.match_confidence DESC
    `).all(planId);

    // Restructure job matches to match renderer expectations
    const jobMatches = jobMatchesRaw.map(row => ({
      matchId: row.match_id,
      planId: row.plan_id,
      planBlueprintId: row.plan_blueprint_id,
      confidence: row.match_confidence,
      matchReason: row.match_reason,
      status: row.status,
      job: {
        jobId: row.job_id,
        installerId: row.installer_id,
        facilityId: row.facility_id,
        activityId: row.activity_id,
        blueprintTypeId: row.job_blueprint_type_id,
        runs: row.job_runs,
        status: row.job_status,
        startDate: row.start_date,
        endDate: row.end_date,
        completedDate: row.completed_date
      },
      planBlueprint: {
        blueprintTypeId: row.plan_blueprint_type_id,
        runs: row.plan_runs,
        meLevel: row.me_level,
        teLevel: row.te_level
      }
    }));

    // Get transaction matches with explicit column selection
    const transactionMatchesRaw = db.prepare(`
      SELECT
        tm.match_id,
        tm.plan_id,
        tm.transaction_id,
        tm.type_id as match_type_id,
        tm.match_type,
        tm.quantity as match_quantity,
        tm.match_confidence,
        tm.match_reason,
        tm.status,
        wt.character_id,
        wt.date,
        wt.type_id as transaction_type_id,
        wt.quantity as transaction_quantity,
        wt.unit_price,
        wt.location_id,
        wt.is_buy,
        wt.is_personal
      FROM plan_transaction_matches tm
      JOIN esi_wallet_transactions wt ON tm.transaction_id = wt.transaction_id
      WHERE tm.plan_id = ? AND tm.status = 'pending'
      ORDER BY tm.match_confidence DESC
    `).all(planId);

    // Restructure transaction matches to match renderer expectations
    const transactionMatches = transactionMatchesRaw.map(row => ({
      matchId: row.match_id,
      planId: row.plan_id,
      transactionId: row.transaction_id,
      typeId: row.transaction_type_id,
      matchType: row.match_type,
      quantity: row.match_quantity,
      confidence: row.match_confidence,
      matchReason: row.match_reason,
      status: row.status,
      transaction: {
        transactionId: row.transaction_id,
        characterId: row.character_id,
        date: row.date,
        typeId: row.transaction_type_id,
        quantity: row.transaction_quantity,
        unitPrice: row.unit_price,
        locationId: row.location_id,
        isBuy: row.is_buy,
        isPersonal: row.is_personal
      }
    }));

    return {
      jobMatches,
      transactionMatches
    };
  } catch (error) {
    console.error('Error getting pending matches:', error);
    throw error;
  }
}

/**
 * Calculate actual costs and profits from confirmed matches
 */
function getPlanActuals(planId) {
  const db = getCharacterDatabase();

  try {
    // Calculate actual material costs from confirmed transaction matches
    const materialCosts = db.prepare(`
      SELECT
        SUM(wt.quantity * wt.unit_price) as total_cost
      FROM plan_transaction_matches tm
      JOIN esi_wallet_transactions wt ON tm.transaction_id = wt.transaction_id
      WHERE tm.plan_id = ?
        AND tm.status = 'confirmed'
        AND tm.match_type = 'material_buy'
    `).get(planId);

    // Calculate actual product sales from confirmed transaction matches
    const productSales = db.prepare(`
      SELECT
        SUM(wt.quantity * wt.unit_price) as total_sales
      FROM plan_transaction_matches tm
      JOIN esi_wallet_transactions wt ON tm.transaction_id = wt.transaction_id
      WHERE tm.plan_id = ?
        AND tm.status = 'confirmed'
        AND tm.match_type = 'product_sell'
    `).get(planId);

    // Get confirmed jobs with their status and timing information
    const confirmedJobsData = db.prepare(`
      SELECT
        ij.status,
        ij.start_date,
        ij.end_date,
        ij.completed_date
      FROM plan_job_matches jm
      JOIN esi_industry_jobs ij ON jm.job_id = ij.job_id
      WHERE jm.plan_id = ? AND jm.status = 'confirmed'
    `).all(planId);

    // Get plan blueprints for job completion tracking
    const totalJobs = db.prepare(`
      SELECT COUNT(*) as total_count
      FROM plan_blueprints
      WHERE plan_id = ?
    `).get(planId);

    const totalJobsExpected = totalJobs?.total_count || 0;

    // Calculate time-based progress for confirmed jobs
    const currentTime = Date.now(); // Unix timestamp in milliseconds (ESI uses milliseconds)
    let totalProgress = 0;

    console.log(`[Plan Actuals] Calculating progress for plan ${planId}`);
    console.log(`[Plan Actuals] Current time: ${currentTime}, Date: ${new Date(currentTime).toISOString()}`);
    console.log(`[Plan Actuals] Found ${confirmedJobsData.length} confirmed jobs, ${totalJobsExpected} jobs expected`);

    confirmedJobsData.forEach((job, index) => {
      console.log(`[Plan Actuals] Job ${index + 1}: status="${job.status}", start=${job.start_date}, end=${job.end_date}`);

      if (job.status === 'delivered') {
        // Completed jobs count as 100%
        console.log(`[Plan Actuals] Job ${index + 1}: Delivered, adding 100%`);
        totalProgress += 100;
      } else if (job.status === 'active' && job.start_date && job.end_date) {
        // Active jobs calculate progress based on elapsed time
        const totalDuration = job.end_date - job.start_date;
        const elapsedTime = currentTime - job.start_date;
        const jobProgress = Math.min(100, Math.max(0, (elapsedTime / totalDuration) * 100));
        console.log(`[Plan Actuals] Job ${index + 1}: Active, duration=${totalDuration}ms, elapsed=${elapsedTime}ms, progress=${jobProgress.toFixed(2)}%`);
        totalProgress += jobProgress;
      } else {
        console.log(`[Plan Actuals] Job ${index + 1}: Status "${job.status}" not counted (paused/cancelled/reverted or missing dates)`);
      }
      // Other statuses (paused, cancelled, reverted) count as 0%
    });

    console.log(`[Plan Actuals] Total progress: ${totalProgress}, Total jobs expected: ${totalJobsExpected}, Completion %: ${(totalProgress / totalJobsExpected).toFixed(2)}`);

    const completionPercentage = totalJobsExpected > 0
      ? (totalProgress / totalJobsExpected)
      : 0;

    return {
      actualMaterialCost: materialCosts?.total_cost || 0,
      actualProductSales: productSales?.total_sales || 0,
      actualProfit: (productSales?.total_sales || 0) - (materialCosts?.total_cost || 0),
      confirmedJobsCount: confirmedJobsData.length,
      totalJobsExpected: totalJobsExpected,
      completionPercentage: completionPercentage
    };
  } catch (error) {
    console.error('Error calculating plan actuals:', error);
    throw error;
  }
}

/**
 * Get confirmed job matches for a plan
 */
function getConfirmedJobMatches(planId) {
  const db = getCharacterDatabase();

  try {
    const jobMatchesRaw = db.prepare(`
      SELECT
        jm.match_id,
        jm.plan_id,
        jm.plan_blueprint_id,
        jm.job_id,
        jm.match_confidence,
        jm.match_reason,
        jm.status,
        jm.confirmed_at,
        ij.installer_id,
        ij.facility_id,
        ij.activity_id,
        ij.blueprint_type_id as job_blueprint_type_id,
        ij.runs as job_runs,
        ij.status as job_status,
        ij.start_date,
        ij.end_date,
        ij.completed_date,
        pb.blueprint_type_id as plan_blueprint_type_id,
        pb.runs as plan_runs,
        pb.me_level,
        pb.te_level
      FROM plan_job_matches jm
      JOIN esi_industry_jobs ij ON jm.job_id = ij.job_id
      JOIN plan_blueprints pb ON jm.plan_blueprint_id = pb.plan_blueprint_id
      WHERE jm.plan_id = ? AND jm.status = 'confirmed'
      ORDER BY jm.confirmed_at DESC
    `).all(planId);

    // Transform to structured format
    const jobMatches = jobMatchesRaw.map(row => ({
      matchId: row.match_id,
      planId: row.plan_id,
      planBlueprintId: row.plan_blueprint_id,
      jobId: row.job_id,
      confidence: row.match_confidence,
      reason: row.match_reason,
      status: row.status,
      confirmedAt: row.confirmed_at,
      job: {
        jobId: row.job_id,
        installerId: row.installer_id,
        facilityId: row.facility_id,
        activityId: row.activity_id,
        blueprintTypeId: row.job_blueprint_type_id,
        runs: row.job_runs,
        status: row.job_status,
        startDate: row.start_date,
        endDate: row.end_date,
        completedDate: row.completed_date
      },
      planBlueprint: {
        blueprintTypeId: row.plan_blueprint_type_id,
        runs: row.plan_runs,
        meLevel: row.me_level,
        teLevel: row.te_level
      }
    }));

    return jobMatches;
  } catch (error) {
    console.error('Error getting confirmed job matches:', error);
    throw error;
  }
}

/**
 * Unlink a confirmed job match (remove the link but keep the job in ESI data)
 */
function unlinkJobMatch(matchId) {
  const db = getCharacterDatabase();

  try {
    const stmt = db.prepare(`
      DELETE FROM plan_job_matches
      WHERE match_id = ?
    `);

    const result = stmt.run(matchId);

    if (result.changes === 0) {
      throw new Error('Match not found');
    }

    console.log(`[Plan Matching] Unlinked job match ${matchId}`);
    return { success: true };
  } catch (error) {
    console.error('Error unlinking job match:', error);
    throw error;
  }
}

/**
 * Get confirmed transaction matches for a plan
 */
function getConfirmedTransactionMatches(planId) {
  const db = getCharacterDatabase();

  try {
    const transactionMatchesRaw = db.prepare(`
      SELECT
        tm.match_id,
        tm.plan_id,
        tm.transaction_id,
        tm.type_id,
        tm.match_type,
        tm.match_confidence,
        tm.match_reason,
        tm.status,
        tm.confirmed_at,
        wt.transaction_id as wt_transaction_id,
        wt.date,
        wt.is_buy,
        wt.is_personal,
        wt.location_id,
        wt.quantity,
        wt.type_id as wt_type_id,
        wt.unit_price
      FROM plan_transaction_matches tm
      JOIN esi_wallet_transactions wt ON tm.transaction_id = wt.transaction_id
      WHERE tm.plan_id = ? AND tm.status = 'confirmed'
      ORDER BY tm.confirmed_at DESC
    `).all(planId);

    // Transform to structured format
    const transactionMatches = transactionMatchesRaw.map(row => ({
      matchId: row.match_id,
      planId: row.plan_id,
      transactionId: row.transaction_id,
      typeId: row.type_id,
      matchType: row.match_type,
      confidence: row.match_confidence,
      reason: row.match_reason,
      status: row.status,
      confirmedAt: row.confirmed_at,
      transaction: {
        transactionId: row.wt_transaction_id,
        date: row.date,
        isBuy: row.is_buy,
        isPersonal: row.is_personal,
        locationId: row.location_id,
        quantity: row.quantity,
        typeId: row.wt_type_id,
        unitPrice: row.unit_price
      }
    }));

    return transactionMatches;
  } catch (error) {
    console.error('Error getting confirmed transaction matches:', error);
    throw error;
  }
}

/**
 * Unlink a confirmed transaction match (remove the link but keep the transaction in ESI data)
 */
function unlinkTransactionMatch(matchId) {
  const db = getCharacterDatabase();

  try {
    const stmt = db.prepare(`
      DELETE FROM plan_transaction_matches
      WHERE match_id = ?
    `);

    const result = stmt.run(matchId);

    if (result.changes === 0) {
      throw new Error('Match not found');
    }

    console.log(`[Plan Matching] Unlinked transaction match ${matchId}`);
    return { success: true };
  } catch (error) {
    console.error('Error unlinking transaction match:', error);
    throw error;
  }
}

module.exports = {
  matchJobsToPlan,
  saveJobMatches,
  matchTransactionsToPlan,
  saveTransactionMatches,
  confirmJobMatch,
  rejectJobMatch,
  confirmTransactionMatch,
  rejectTransactionMatch,
  getPendingMatches,
  getPlanActuals,
  getConfirmedJobMatches,
  unlinkJobMatch,
  getConfirmedTransactionMatches,
  unlinkTransactionMatch
};
