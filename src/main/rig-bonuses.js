const { rigAffectsProduct, getSecurityMultiplier } = require('./rig-mappings');
const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

/**
 * Get the path to the SDE database
 */
function getSDEPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'sde', 'sqlite-latest.sqlite');
}

/**
 * Get rig bonuses from SDE database
 * @param {number} rigTypeId - Rig type ID
 * @returns {Object} Rig bonuses {materialBonus, timeBonus, costBonus}
 */
function getRigBonusesFromSDE(rigTypeId) {
  try {
    const dbPath = getSDEPath();
    const db = new Database(dbPath, { readonly: true });

    // Get rig attributes
    // attributeID 2594 = Material Reduction Bonus
    // attributeID 2593 = Time Reduction Bonus
    // attributeID 2595 = Cost Reduction Bonus
    const attributes = db.prepare(`
      SELECT attributeID, valueFloat, valueInt
      FROM dgmTypeAttributes
      WHERE typeID = ? AND attributeID IN (2593, 2594, 2595)
    `).all(rigTypeId);

    db.close();

    const bonuses = {
      materialBonus: 0,
      timeBonus: 0,
      costBonus: 0
    };

    attributes.forEach(attr => {
      const value = attr.valueFloat !== null ? attr.valueFloat : attr.valueInt;
      if (attr.attributeID === 2594) {
        bonuses.materialBonus = value || 0;
      } else if (attr.attributeID === 2593) {
        bonuses.timeBonus = value || 0;
      } else if (attr.attributeID === 2595) {
        bonuses.costBonus = value || 0;
      }
    });

    return bonuses;
  } catch (error) {
    console.error('Error getting rig bonuses from SDE:', error);
    return { materialBonus: 0, timeBonus: 0, costBonus: 0 };
  }
}

/**
 * Get rig's group ID from SDE
 * @param {number} rigTypeId - Rig type ID
 * @returns {number|null} Group ID
 */
function getRigGroupId(rigTypeId) {
  try {
    const dbPath = getSDEPath();
    const db = new Database(dbPath, { readonly: true });

    const result = db.prepare(`
      SELECT groupID
      FROM invTypes
      WHERE typeID = ?
    `).get(rigTypeId);

    db.close();
    return result ? result.groupID : null;
  } catch (error) {
    console.error('Error getting rig group ID:', error);
    return null;
  }
}

/**
 * Calculate total material reduction bonus from facility rigs
 * @param {Array} rigs - Array of rig objects {typeId}
 * @param {number} productGroupId - Product group ID to check
 * @param {number} securityStatus - System security status
 * @returns {number} Total material bonus (negative value = reduction)
 */
function getRigMaterialBonus(rigs, productGroupId, securityStatus = 0.5) {
  if (!rigs || rigs.length === 0) {
    return 0;
  }

  const securityMultiplier = getSecurityMultiplier(securityStatus);
  let totalBonus = 0;

  for (const rig of rigs) {
    // Handle both string typeIds and object format {typeId: ...}
    const rigTypeId = typeof rig === 'string' ? parseInt(rig) : rig.typeId;
    const rigGroupId = getRigGroupId(rigTypeId);
    if (!rigGroupId) continue;

    // Check if this rig affects the product
    if (rigAffectsProduct(rigGroupId, productGroupId)) {
      const bonuses = getRigBonusesFromSDE(rigTypeId);
      // Apply security multiplier to the bonus
      totalBonus += bonuses.materialBonus * securityMultiplier;
    }
  }

  return totalBonus;
}

/**
 * Calculate total time reduction bonus from facility rigs
 * @param {Array} rigs - Array of rig objects {typeId}
 * @param {number} productGroupId - Product group ID to check
 * @param {number} securityStatus - System security status
 * @returns {number} Total time bonus (negative value = reduction)
 */
function getRigTimeBonus(rigs, productGroupId, securityStatus = 0.5) {
  if (!rigs || rigs.length === 0) {
    return 0;
  }

  const securityMultiplier = getSecurityMultiplier(securityStatus);
  let totalBonus = 0;

  for (const rig of rigs) {
    // Handle both string typeIds and object format {typeId: ...}
    const rigTypeId = typeof rig === 'string' ? parseInt(rig) : rig.typeId;
    const rigGroupId = getRigGroupId(rigTypeId);
    if (!rigGroupId) continue;

    // Check if this rig affects the product
    if (rigAffectsProduct(rigGroupId, productGroupId)) {
      const bonuses = getRigBonusesFromSDE(rigTypeId);
      // Apply security multiplier to the bonus
      totalBonus += bonuses.timeBonus * securityMultiplier;
    }
  }

  return totalBonus;
}

/**
 * Calculate total cost reduction bonus from facility rigs
 * @param {Array} rigs - Array of rig objects {typeId}
 * @param {number} productGroupId - Product group ID to check
 * @param {number} securityStatus - System security status
 * @returns {number} Total cost bonus (negative value = reduction)
 */
function getRigCostBonus(rigs, productGroupId, securityStatus = 0.5) {
  if (!rigs || rigs.length === 0) {
    return 0;
  }

  const securityMultiplier = getSecurityMultiplier(securityStatus);
  let totalBonus = 0;

  for (const rig of rigs) {
    // Handle both string typeIds and object format {typeId: ...}
    const rigTypeId = typeof rig === 'string' ? parseInt(rig) : rig.typeId;
    const rigGroupId = getRigGroupId(rigTypeId);
    if (!rigGroupId) continue;

    // Check if this rig affects the product
    if (rigAffectsProduct(rigGroupId, productGroupId)) {
      const bonuses = getRigBonusesFromSDE(rigTypeId);
      // Apply security multiplier to the bonus
      totalBonus += bonuses.costBonus * securityMultiplier;
    }
  }

  return totalBonus;
}

module.exports = {
  getRigBonusesFromSDE,
  getRigGroupId,
  getRigMaterialBonus,
  getRigTimeBonus,
  getRigCostBonus,
};
