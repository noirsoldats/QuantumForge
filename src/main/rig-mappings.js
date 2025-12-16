/**
 * Dynamic rig-to-product mapping using SDE database
 * Queries rigIndustryModifierSources and rigAffectedProductGroups tables
 */

const { getSdePath } = require('./sde-manager');
const Database = require('better-sqlite3');

// Removed hard-coded RIG_TO_PRODUCT_GROUPS - now queried from SDE
// Old implementation used rig groupIDs, new implementation uses rig typeIDs for better specificity

/**
 * Get product groups affected by a rig typeID
 * @param {number} rigTypeId - The rig's type ID
 * @param {string} activityKey - Activity type (default: 'manufacturing')
 * @param {string} bonusType - Bonus type (default: 'material')
 * @returns {number[]} Array of product group IDs affected by this rig
 */
function getAffectedProductGroups(rigTypeId, activityKey = 'manufacturing', bonusType = 'material') {
  try {
    const dbPath = getSdePath();
    const db = new Database(dbPath, { readonly: true });

    const productGroups = db.prepare(`
      SELECT DISTINCT productGroupID
      FROM rigAffectedProductGroups
      WHERE rigTypeID = ?
        AND activityKey = ?
        AND bonusType = ?
      ORDER BY productGroupID
    `).all(rigTypeId, activityKey, bonusType);

    db.close();
    return productGroups.map(row => row.productGroupID);
  } catch (error) {
    console.error('Error querying rig affected product groups:', error);
    return [];
  }
}

/**
 * Check if a rig affects a specific product
 * @param {number} rigTypeId - The rig's type ID (NOT groupID)
 * @param {number} productGroupId - The product's group ID
 * @param {string} activityKey - Activity type (default: 'manufacturing')
 * @param {string} bonusType - Bonus type (default: 'material')
 * @returns {boolean} True if the rig affects this product
 */
function rigAffectsProduct(rigTypeId, productGroupId, activityKey = 'manufacturing', bonusType = 'material') {
  try {
    const dbPath = getSdePath();
    const db = new Database(dbPath, { readonly: true });

    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM rigAffectedProductGroups
      WHERE rigTypeID = ?
        AND productGroupID = ?
        AND activityKey = ?
        AND bonusType = ?
    `).get(rigTypeId, productGroupId, activityKey, bonusType);

    db.close();
    return result.count > 0;
  } catch (error) {
    console.error('Error checking rig affects product:', error);
    return false;
  }
}

/**
 * Security status multipliers for rig bonuses
 */
const SECURITY_MULTIPLIERS = {
  HIGH_SEC: 1.0,    // attributeID 2355
  LOW_SEC: 1.9,     // attributeID 2356
  NULL_WH: 2.1,     // attributeID 2357
};

/**
 * Get security multiplier based on system security status
 * @param {number} securityStatus - System security status (-1.0 to 1.0)
 * @returns {number} Security multiplier for rig bonuses
 */
function getSecurityMultiplier(securityStatus) {
  if (securityStatus >= 0.5) {
    return SECURITY_MULTIPLIERS.HIGH_SEC;
  } else if (securityStatus > 0.0) {
    return SECURITY_MULTIPLIERS.LOW_SEC;
  } else {
    return SECURITY_MULTIPLIERS.NULL_WH;
  }
}

module.exports = {
  getAffectedProductGroups,
  rigAffectsProduct,
  SECURITY_MULTIPLIERS,
  getSecurityMultiplier,
};
