// Plan Matching System - Smart heuristic-based matching for jobs and transactions
const { randomUUID: uuidv4 } = require('crypto');
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
 * @param {number} options.characterId - Character ID for filtering jobs (deprecated, use characterIds)
 * @param {number[]} options.characterIds - Character IDs for filtering personal jobs
 * @param {number[]} options.corporationIds - Corporation IDs for filtering corporate jobs
 * @param {number} options.maxDaysAgo - Max days to look back (default: 30)
 * @param {number} options.minConfidence - Minimum confidence threshold (default: 0.5)
 * @returns {Array} Array of potential matches with confidence scores
 */
function matchJobsToPlan(planId, options = {}) {
  const { characterId, characterIds, corporationIds, maxDaysAgo = 30, minConfidence = 0.5 } = options;

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

    // Support multiple characters
    let charIds = characterIds || [];
    if (!charIds || charIds.length === 0) {
      // Fallback to single character for backward compatibility
      charIds = characterId ? [characterId] : [];
    }

    // Get corporation IDs (if provided)
    const corpIds = corporationIds || [];

    if (charIds.length === 0 && corpIds.length === 0) {
      return [];
    }

    // Get industry jobs within time window
    // Query personal jobs for characters AND corporate jobs for corporations
    const timeWindow = Date.now() - (maxDaysAgo * 24 * 60 * 60 * 1000);
    let jobs = [];

    // Build query based on what IDs we have
    if (charIds.length > 0 && corpIds.length > 0) {
      // Query both personal and corporate jobs
      const charPlaceholders = charIds.map(() => '?').join(',');
      const corpPlaceholders = corpIds.map(() => '?').join(',');
      jobs = db.prepare(`
        SELECT * FROM esi_industry_jobs
        WHERE (
          (character_id IN (${charPlaceholders}) AND is_corporation = 0)
          OR (corporation_id IN (${corpPlaceholders}) AND is_corporation = 1)
        )
          AND activity_id IN (1, 9)
          AND start_date >= ?
        ORDER BY start_date DESC
      `).all(...charIds, ...corpIds, timeWindow);
    } else if (charIds.length > 0) {
      // Query only personal jobs
      const charPlaceholders = charIds.map(() => '?').join(',');
      jobs = db.prepare(`
        SELECT * FROM esi_industry_jobs
        WHERE character_id IN (${charPlaceholders})
          AND is_corporation = 0
          AND activity_id IN (1, 9)
          AND start_date >= ?
        ORDER BY start_date DESC
      `).all(...charIds, timeWindow);
    } else if (corpIds.length > 0) {
      // Query only corporate jobs
      const corpPlaceholders = corpIds.map(() => '?').join(',');
      jobs = db.prepare(`
        SELECT * FROM esi_industry_jobs
        WHERE corporation_id IN (${corpPlaceholders})
          AND is_corporation = 1
          AND activity_id IN (1, 9)
          AND start_date >= ?
        ORDER BY start_date DESC
      `).all(...corpIds, timeWindow);
    }

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
  const { characterId, characterIds, corporationIds, maxDaysAgo = 30, minConfidence = 0.5 } = options;

  const db = getCharacterDatabase();

  try {
    // Get plan details
    const plan = db.prepare('SELECT * FROM manufacturing_plans WHERE plan_id = ?').get(planId);
    if (!plan) {
      throw new Error('Plan not found');
    }

    // Get plan materials and products from plan_material_nodes
    const materials = db.prepare(`
      SELECT type_id, SUM(quantity_needed) as quantity,
             MAX(price_each) as base_price
      FROM plan_material_nodes
      WHERE plan_id = ? AND node_type = 'material'
      GROUP BY type_id
    `).all(planId);

    const products = db.prepare(`
      SELECT type_id, SUM(quantity_needed) as quantity,
             MAX(price_each) as base_price
      FROM plan_material_nodes
      WHERE plan_id = ? AND node_type = 'product' AND depth = 0
      GROUP BY type_id
    `).all(planId);

    if (materials.length === 0 && products.length === 0) {
      return [];
    }

    // Support multiple characters
    let charIds = characterIds || [];
    if (!charIds || charIds.length === 0) {
      // Fallback to single character for backward compatibility
      charIds = characterId ? [characterId] : [];
    }

    // Corporation IDs (if provided) — mirrors matchJobsToPlan.
    const corpIds = corporationIds || [];

    if (charIds.length === 0 && corpIds.length === 0) {
      return [];
    }

    // Get wallet transactions for ALL characters + corps within time window.
    // date is stored in ms (same as timeWindow) — bind directly (ms/seconds fix).
    const timeWindow = Date.now() - (maxDaysAgo * 24 * 60 * 60 * 1000);
    let transactions = [];

    if (charIds.length > 0 && corpIds.length > 0) {
      const charPlaceholders = charIds.map(() => '?').join(',');
      const corpPlaceholders = corpIds.map(() => '?').join(',');
      transactions = db.prepare(`
        SELECT * FROM esi_wallet_transactions
        WHERE (
          (character_id IN (${charPlaceholders}) AND is_corporation = 0)
          OR (corporation_id IN (${corpPlaceholders}) AND is_corporation = 1)
        )
          AND date >= ?
        ORDER BY date DESC
      `).all(...charIds, ...corpIds, timeWindow);
    } else if (charIds.length > 0) {
      const charPlaceholders = charIds.map(() => '?').join(',');
      transactions = db.prepare(`
        SELECT * FROM esi_wallet_transactions
        WHERE character_id IN (${charPlaceholders}) AND is_corporation = 0
          AND date >= ?
        ORDER BY date DESC
      `).all(...charIds, timeWindow);
    } else if (corpIds.length > 0) {
      const corpPlaceholders = corpIds.map(() => '?').join(',');
      transactions = db.prepare(`
        SELECT * FROM esi_wallet_transactions
        WHERE corporation_id IN (${corpPlaceholders}) AND is_corporation = 1
          AND date >= ?
        ORDER BY date DESC
      `).all(...corpIds, timeWindow);
    }

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
function saveTransactionMatches(planId, matches) {
  const db = getCharacterDatabase();

  const insert = db.prepare(`
    INSERT INTO plan_transaction_matches (
      match_id, plan_id, transaction_id, type_id, match_type,
      quantity, match_confidence, match_reason, status, is_corporation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  const saveMany = db.transaction((matchArray) => {
    for (const match of matchArray) {
      const matchId = uuidv4();
      insert.run(
        matchId,
        planId,
        match.transaction.transaction_id,
        match.transaction.type_id,
        match.matchType,
        match.transaction.quantity,
        match.confidence,
        match.matchReason,
        match.transaction.is_corporation ? 1 : 0
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
    const match = db.prepare('SELECT * FROM plan_job_matches WHERE match_id = ?').get(matchId);
    if (!match) {
      return { success: false };
    }

    const result = db.prepare(`
      UPDATE plan_job_matches
      SET status = 'confirmed',
          confirmed_at = ?,
          confirmed_by_user = 1
      WHERE match_id = ?
    `).run(Math.floor(Date.now() / 1000), matchId);

    // Write the job-installation cost ledger row (real ESI cost).
    const job = db.prepare('SELECT * FROM esi_industry_jobs WHERE job_id = ?').get(match.job_id);
    writeJobLedgerRow(db, match, job);

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
    const match = db.prepare('SELECT * FROM plan_job_matches WHERE match_id = ?').get(matchId);

    const result = db.prepare(`
      UPDATE plan_job_matches
      SET status = 'rejected',
          confirmed_at = ?
      WHERE match_id = ?
    `).run(Math.floor(Date.now() / 1000), matchId);

    // Remove any ledger cost row written when this job was confirmed.
    if (match) {
      removeLedgerRowsForSource(db, match.plan_id, 'industry_job', match.job_id);
    }

    return { success: result.changes > 0 };
  } catch (error) {
    console.error('Error rejecting job match:', error);
    throw error;
  }
}

// ─── Ledger write-through (confirmed matches become ledger rows) ──────────────

/**
 * Write (or refresh) a ledger row from a confirmed transaction match. Idempotent
 * via the UNIQUE(plan_id, source_type, source_id) index — a given transaction
 * produces at most one ledger row.
 *
 * Material BUYS  → event_type='acquired', method='purchased' (spend + acquired qty).
 * Product SELLS  → event_type='sold',    method='sold'      (revenue; first-class
 *                  row, naturally excluded from spend totals and acquisition math).
 * @param {Object} db - character DB
 * @param {Object} match - plan_transaction_matches row
 * @param {Object} tx - esi_wallet_transactions row
 */
function writeTransactionLedgerRow(db, match, tx) {
  if (!tx) return;

  const isBuy = match.match_type === 'material_buy' && tx.is_buy === 1;
  const isSell = match.match_type === 'product_sell' && tx.is_buy === 0;
  if (!isBuy && !isSell) return;

  const eventType = isBuy ? 'acquired' : 'sold';
  const method = isBuy ? 'purchased' : 'sold';

  db.prepare(`
    INSERT INTO plan_material_ledger
      (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note,
       source_type, source_id, character_id, corporation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL,
            'wallet_transaction', ?, ?, ?, ?)
    ON CONFLICT(plan_id, source_type, source_id) WHERE source_id IS NOT NULL DO UPDATE SET
      quantity = excluded.quantity,
      unit_price = excluded.unit_price,
      character_id = excluded.character_id,
      corporation_id = excluded.corporation_id
  `).run(
    uuidv4(), match.plan_id, tx.type_id, eventType, tx.quantity, method, tx.unit_price,
    tx.transaction_id, tx.character_id, tx.corporation_id || null, Date.now()
  );
}

/**
 * Write (or refresh) a job-installation cost ledger row from a confirmed job
 * match, using the real ESI-reported cost. Idempotent via the source index.
 * @param {Object} db - character DB
 * @param {Object} match - plan_job_matches row
 * @param {Object} job - esi_industry_jobs row
 */
function writeJobLedgerRow(db, match, job) {
  if (!job || job.cost == null) {
    return; // no real ESI cost captured — read model surfaces an estimate instead
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO plan_material_ledger
      (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note,
       source_type, source_id, character_id, corporation_id, cost_category, created_at)
    VALUES (?, ?, 0, 'cost', 0, 'cost', ?, NULL,
            'industry_job', ?, ?, ?, 'job_install', ?)
    ON CONFLICT(plan_id, source_type, source_id) WHERE source_id IS NOT NULL DO UPDATE SET
      unit_price = excluded.unit_price,
      character_id = excluded.character_id,
      corporation_id = excluded.corporation_id
  `).run(
    uuidv4(), match.plan_id, job.cost, job.job_id,
    job.character_id, job.corporation_id || null, now
  );
}

/**
 * Remove any ledger rows sourced from a given match's source (transaction or job).
 * Called on reject/unlink so ledger totals revert. Also removes dependent journal
 * fee rows whose parent was this transaction/job (fees follow their parent).
 * @param {Object} db - character DB
 * @param {string} planId
 * @param {string} sourceType - 'wallet_transaction' | 'industry_job'
 * @param {number} sourceId - transaction_id or job_id
 */
function removeLedgerRowsForSource(db, planId, sourceType, sourceId) {
  db.prepare(`
    DELETE FROM plan_material_ledger
    WHERE plan_id = ? AND source_type = ? AND source_id = ?
  `).run(planId, sourceType, sourceId);

  // Remove dependent journal-fee rows tied to this transaction/job via context_id.
  db.prepare(`
    DELETE FROM plan_material_ledger
    WHERE plan_id = ? AND source_type = 'wallet_journal'
      AND source_id IN (
        SELECT id FROM esi_wallet_journal WHERE context_id = ?
      )
  `).run(planId, sourceId);
}

/**
 * Attribute wallet-journal fee entries to a plan by linking them, through their
 * context_id, to a transaction/job already confirmed-matched to this plan.
 * Fees follow their parent — no separate user confirmation. Idempotent via the
 * UNIQUE(plan_id, source_type, source_id) index.
 *
 * Mapping:
 *   brokers_fee / transaction_tax  → context_id = market_transaction_id → confirmed tx
 *   industry_job_tax               → context_id = industry_job_id       → confirmed job
 *
 * @param {string} planId
 * @returns {number} count of fee rows written/refreshed
 */
function attributeJournalFeesToPlan(planId) {
  const db = getCharacterDatabase();
  let written = 0;

  try {
    // Confirmed transaction ids for this plan (fee parents).
    const confirmedTxIds = new Set(
      db.prepare(`
        SELECT transaction_id FROM plan_transaction_matches
        WHERE plan_id = ? AND status = 'confirmed'
      `).all(planId).map(r => r.transaction_id)
    );
    // Confirmed job ids for this plan.
    const confirmedJobIds = new Set(
      db.prepare(`
        SELECT job_id FROM plan_job_matches
        WHERE plan_id = ? AND status = 'confirmed'
      `).all(planId).map(r => r.job_id)
    );

    if (confirmedTxIds.size === 0 && confirmedJobIds.size === 0) {
      return 0;
    }

    // Fee-bearing journal entries.
    const feeEntries = db.prepare(`
      SELECT * FROM esi_wallet_journal
      WHERE ref_type IN ('brokers_fee','transaction_tax','industry_job_tax')
        AND context_id IS NOT NULL
    `).all();

    const catFor = (refType) => {
      if (refType === 'brokers_fee') return 'broker_fee';
      if (refType === 'transaction_tax') return 'sales_tax';
      if (refType === 'industry_job_tax') return 'job_tax';
      return 'other';
    };

    const upsert = db.prepare(`
      INSERT INTO plan_material_ledger
        (ledger_id, plan_id, type_id, event_type, quantity, method, unit_price, note,
         source_type, source_id, character_id, corporation_id, cost_category, created_at)
      VALUES (?, ?, 0, 'cost', 0, 'cost', ?, NULL,
              'wallet_journal', ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id, source_type, source_id) WHERE source_id IS NOT NULL DO UPDATE SET
        unit_price = excluded.unit_price,
        cost_category = excluded.cost_category
    `);

    const now = Date.now();
    for (const entry of feeEntries) {
      const isTxFee = entry.ref_type === 'brokers_fee' || entry.ref_type === 'transaction_tax';
      const isJobFee = entry.ref_type === 'industry_job_tax';
      const attributed =
        (isTxFee && confirmedTxIds.has(entry.context_id)) ||
        (isJobFee && confirmedJobIds.has(entry.context_id));
      if (!attributed) continue;

      upsert.run(
        uuidv4(), planId, Math.abs(entry.amount || 0), entry.id,
        entry.character_id, entry.corporation_id || null, catFor(entry.ref_type), now
      );
      written++;
    }

    if (written > 0) {
      console.log(`[Plan Matching] Attributed ${written} journal fee row(s) to plan ${planId}`);
    }
    return written;
  } catch (error) {
    console.error('Error attributing journal fees to plan:', error);
    return 0;
  }
}

/**
 * Confirm a transaction match
 */
function confirmTransactionMatch(matchId) {
  const db = getCharacterDatabase();

  try {
    const match = db.prepare('SELECT * FROM plan_transaction_matches WHERE match_id = ?').get(matchId);
    if (!match) {
      return { success: false };
    }

    const result = db.prepare(`
      UPDATE plan_transaction_matches
      SET status = 'confirmed',
          confirmed_at = ?,
          confirmed_by_user = 1
      WHERE match_id = ?
    `).run(Math.floor(Date.now() / 1000), matchId);

    // Write the purchased-material ledger row from the underlying transaction
    // (disambiguated by is_corporation — transaction_id alone is not unique).
    const tx = db.prepare('SELECT * FROM esi_wallet_transactions WHERE transaction_id = ? AND is_corporation = ?')
      .get(match.transaction_id, match.is_corporation ? 1 : 0);
    writeTransactionLedgerRow(db, match, tx);

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
    const match = db.prepare('SELECT * FROM plan_transaction_matches WHERE match_id = ?').get(matchId);

    const result = db.prepare(`
      UPDATE plan_transaction_matches
      SET status = 'rejected',
          confirmed_at = ?
      WHERE match_id = ?
    `).run(Math.floor(Date.now() / 1000), matchId);

    // Remove the purchased-material ledger row (and dependent fee rows).
    if (match) {
      removeLedgerRowsForSource(db, match.plan_id, 'wallet_transaction', match.transaction_id);
    }

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
        ij.character_id,
        ij.is_corporation,
        ij.corporation_id,
        pb.blueprint_type_id as plan_blueprint_type_id,
        pb.runs as plan_runs,
        pb.me_level,
        pb.te_level,
        c.character_name
      FROM plan_job_matches jm
      JOIN esi_industry_jobs ij ON jm.job_id = ij.job_id
      JOIN plan_blueprints pb ON jm.plan_blueprint_id = pb.plan_blueprint_id
      LEFT JOIN characters c ON ij.character_id = c.character_id
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
        completedDate: row.completed_date,
        characterId: row.character_id,
        characterName: row.character_name,
        isCorporation: row.is_corporation === 1,
        corporationId: row.corporation_id
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
        wt.is_personal,
        c.character_name
      FROM plan_transaction_matches tm
      JOIN esi_wallet_transactions wt ON tm.transaction_id = wt.transaction_id AND tm.is_corporation = wt.is_corporation
      LEFT JOIN characters c ON wt.character_id = c.character_id
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
        isPersonal: row.is_personal,
        characterName: row.character_name
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
      JOIN esi_wallet_transactions wt ON tm.transaction_id = wt.transaction_id AND tm.is_corporation = wt.is_corporation
      WHERE tm.plan_id = ?
        AND tm.status = 'confirmed'
        AND tm.match_type = 'material_buy'
    `).get(planId);

    // Calculate actual product sales from confirmed transaction matches
    const productSales = db.prepare(`
      SELECT
        SUM(wt.quantity * wt.unit_price) as total_sales
      FROM plan_transaction_matches tm
      JOIN esi_wallet_transactions wt ON tm.transaction_id = wt.transaction_id AND tm.is_corporation = wt.is_corporation
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
        ij.character_id,
        ij.is_corporation,
        ij.corporation_id,
        pb.blueprint_type_id as plan_blueprint_type_id,
        pb.runs as plan_runs,
        pb.me_level,
        pb.te_level,
        c.character_name
      FROM plan_job_matches jm
      JOIN esi_industry_jobs ij ON jm.job_id = ij.job_id
      JOIN plan_blueprints pb ON jm.plan_blueprint_id = pb.plan_blueprint_id
      LEFT JOIN characters c ON ij.character_id = c.character_id
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
        completedDate: row.completed_date,
        characterId: row.character_id,
        characterName: row.character_name,
        isCorporation: row.is_corporation === 1,
        corporationId: row.corporation_id
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
    const match = db.prepare('SELECT * FROM plan_job_matches WHERE match_id = ?').get(matchId);

    const result = db.prepare(`
      DELETE FROM plan_job_matches
      WHERE match_id = ?
    `).run(matchId);

    if (result.changes === 0) {
      throw new Error('Match not found');
    }

    // Remove any ledger cost row written when this job was confirmed.
    if (match) {
      removeLedgerRowsForSource(db, match.plan_id, 'industry_job', match.job_id);
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
        wt.character_id,
        wt.date,
        wt.is_buy,
        wt.is_personal,
        wt.location_id,
        wt.quantity,
        wt.type_id as wt_type_id,
        wt.unit_price,
        c.character_name
      FROM plan_transaction_matches tm
      JOIN esi_wallet_transactions wt ON tm.transaction_id = wt.transaction_id AND tm.is_corporation = wt.is_corporation
      LEFT JOIN characters c ON wt.character_id = c.character_id
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
        characterId: row.character_id,
        date: row.date,
        isBuy: row.is_buy,
        isPersonal: row.is_personal,
        locationId: row.location_id,
        quantity: row.quantity,
        typeId: row.wt_type_id,
        unitPrice: row.unit_price,
        characterName: row.character_name
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
    const match = db.prepare('SELECT * FROM plan_transaction_matches WHERE match_id = ?').get(matchId);

    const result = db.prepare(`
      DELETE FROM plan_transaction_matches
      WHERE match_id = ?
    `).run(matchId);

    if (result.changes === 0) {
      throw new Error('Match not found');
    }

    // Remove the purchased-material ledger row (and dependent fee rows).
    if (match) {
      removeLedgerRowsForSource(db, match.plan_id, 'wallet_transaction', match.transaction_id);
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
  unlinkTransactionMatch,
  attributeJournalFeesToPlan
};
