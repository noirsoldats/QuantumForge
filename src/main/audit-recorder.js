/**
 * Audit Mode recorder — an in-memory, session-only ring buffer of pricing,
 * material, and invention calculations, captured when the user's
 * general.auditModeEnabled setting is on. Used by the Audit Log window
 * (audit-window.js) to show, live, what calculation happened, with what
 * inputs, and which candidate value was chosen.
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
let auditWindowWebContents = null;

function setAuditEnabled(enabled) {
  auditEnabled = !!enabled;
}

function isAuditEnabled() {
  return auditEnabled;
}

function setAuditWindow(webContents) {
  auditWindowWebContents = webContents || null;
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

  if (auditWindowWebContents && !auditWindowWebContents.isDestroyed()) {
    auditWindowWebContents.send('audit:recordAdded', fullRecord);
  }
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
  setAuditWindow,
  recordCalculation,
  recordPricing,
  recordMaterials,
  recordInvention,
  getRecords,
  clearRecords,
  getSummary,
};
