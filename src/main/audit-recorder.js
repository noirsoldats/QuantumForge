/**
 * Audit Mode recorder — an in-memory, session-only ring buffer of pricing,
 * material, and invention calculations, captured when the user's
 * general.auditModeEnabled setting is on. Used by the Audit Log view to show,
 * live, what calculation happened, with what inputs, and which candidate value
 * was chosen.
 *
 * Deliberately not persisted to disk/DB: this is live session diagnostic
 * data, not historical record-keeping. A single manufacturing plan
 * recalculation can trigger hundreds of calculateRealisticPrice calls, so a
 * DB write per record would add real overhead for data nobody needs after
 * the session ends. The cap below bounds memory instead.
 */

const MAX_RECORDS = 1000;

let auditEnabled = false;
let records = [];
let nextId = 1;

function setAuditEnabled(enabled) {
  auditEnabled = !!enabled;
}

function isAuditEnabled() {
  return auditEnabled;
}

/**
 * @param {Object} record - must include `type` ('pricing' | 'materials' | 'invention')
 *   and the corresponding `pricing` / `materials` / `invention` payload, plus optional `context`.
 */
function recordCalculation(record) {
  if (!auditEnabled) return;

  const fullRecord = {
    id: nextId++,
    timestamp: Date.now(),
    ...record,
  };

  records.push(fullRecord);
  if (records.length > MAX_RECORDS) {
    records.shift();
  }

  // Broadcast rather than pushing to one registered window. The Audit Log used
  // to hand its webContents to `setAuditWindow`, which meant exactly ONE
  // consumer: with the view mountable both in the main window and as its own
  // standalone window, whichever registered last silently starved the other.
  // `broadcast` also reaches every frame, not just each window's main frame.
  //
  // Name resolution is async and deliberately NOT awaited: recordCalculation
  // sits on hot calculation paths and must stay synchronous. The record is
  // sent once names are attached, a moment later.
  const { broadcast } = require('./broadcast');
  withTypeNames([fullRecord])
    .then(([named]) => broadcast('audit:recordAdded', named))
    .catch(() => broadcast('audit:recordAdded', fullRecord));
}

function recordPricing(context, priceResult) {
  if (!auditEnabled) return;
  recordCalculation({
    type: 'pricing',
    context,
    pricing: {
      ...context,
      price: priceResult.price,
      confidence: priceResult.confidence,
      warning: priceResult.warning,
      method: priceResult.method,
      candidates: {
        vwap: priceResult.vwap,
        percentile: priceResult.percentile,
        minVolume: priceResult.minVolume,
        cleaned: priceResult.cleaned,
        historical7d: priceResult.historical7d,
        historical30d: priceResult.historical30d,
        immediate: priceResult.immediate,
      },
      metadata: priceResult.metadata,
    },
  });
}

function recordMaterials(context) {
  if (!auditEnabled) return;
  recordCalculation({
    type: 'materials',
    context,
    materials: context,
  });
}

function recordInvention(context) {
  if (!auditEnabled) return;
  recordCalculation({
    type: 'invention',
    context,
    invention: context,
  });
}

/**
 * The type ids a record needs a name for.
 *
 * Callers record IDs only - deliberately. `recordPricing` fires hundreds of
 * times per plan recalculation, so an SDE lookup at each of the 9 call sites
 * would put a query on a hot path for data that is only ever read if the user
 * opens this screen. Names are resolved here instead, batched and lazily.
 */
function typeIdsForRecord(record) {
  const ids = [];
  if (record.type === 'pricing' && record.pricing?.typeId != null) {
    ids.push(record.pricing.typeId);
  }
  if (record.type === 'materials' && record.materials?.blueprintTypeId != null) {
    ids.push(record.materials.blueprintTypeId);
  }
  if (record.type === 'invention') {
    if (record.invention?.blueprintTypeId != null) ids.push(record.invention.blueprintTypeId);
    if (record.invention?.decryptorTypeId != null) ids.push(record.invention.decryptorTypeId);
  }
  return ids;
}

/**
 * Attach display names to a batch of records, resolving every id in ONE query.
 *
 * Returns copies; the buffer itself stays name-free so a later SDE update is
 * never serving stale names from memory. A failed or missing SDE simply leaves
 * the ids in place - the screen falls back to "Type 34", which is what it
 * showed before names existed at all.
 *
 * @param {Array} batch
 * @returns {Promise<Array>} the same records with names filled in
 */
async function withTypeNames(batch) {
  if (!batch || batch.length === 0) return batch || [];

  const ids = [...new Set(batch.flatMap(typeIdsForRecord))];
  if (ids.length === 0) return batch;

  let names = {};
  try {
    const { sdeExists } = require('./sde-manager');
    if (!sdeExists()) return batch;
    const { getTypeNames } = require('./sde-database');
    names = (await getTypeNames(ids)) || {};
  } catch (error) {
    console.error('[Audit] Could not resolve type names:', error);
    return batch;
  }

  return batch.map((record) => {
    if (record.type === 'pricing' && record.pricing) {
      const name = names[record.pricing.typeId];
      if (!name) return record;
      return { ...record, pricing: { ...record.pricing, itemName: name } };
    }
    if (record.type === 'materials' && record.materials) {
      const name = names[record.materials.blueprintTypeId];
      if (!name) return record;
      return { ...record, materials: { ...record.materials, blueprintName: name } };
    }
    if (record.type === 'invention' && record.invention) {
      const blueprintName = names[record.invention.blueprintTypeId];
      const decryptorName = names[record.invention.decryptorTypeId];
      if (!blueprintName && !decryptorName) return record;
      return {
        ...record,
        invention: {
          ...record.invention,
          ...(blueprintName ? { blueprintName } : {}),
          ...(decryptorName ? { decryptorName } : {}),
        },
      };
    }
    return record;
  });
}

function getRecords({ since, type } = {}) {
  let result = records;
  if (type) {
    result = result.filter(r => r.type === type);
  }
  if (since) {
    result = result.filter(r => r.timestamp >= since);
  }
  return [...result].reverse(); // newest first
}

function clearRecords() {
  records = [];
}

function getSummary() {
  const byType = {};
  for (const r of records) {
    byType[r.type] = (byType[r.type] || 0) + 1;
  }
  return {
    total: records.length,
    byType,
    enabled: auditEnabled,
  };
}

module.exports = {
  setAuditEnabled,
  isAuditEnabled,
  withTypeNames,
  recordCalculation,
  recordPricing,
  recordMaterials,
  recordInvention,
  getRecords,
  clearRecords,
  getSummary,
};
