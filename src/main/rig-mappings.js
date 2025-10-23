/**
 * Mapping of Structure Engineering Rig groups to product groups they affect
 * Based on Eve SDE database structure and CCP's design
 */

// Map rig groupIDs to the product groupIDs they affect
const RIG_TO_PRODUCT_GROUPS = {
  // Equipment ME/TE
  1816: [11, 74, 212, 340, 478, 485, 543, 544, 545, 588, 646, 771, 772, 773, 774, 775, 776, 777, 778, 779, 780, 781, 782, 783, 784, 785, 786, 787, 788, 789, 790], // Various module groups
  1819: [11, 74, 212, 340, 478, 485, 543, 544, 545, 588, 646, 771, 772, 773, 774, 775, 776, 777, 778, 779, 780, 781, 782, 783, 784, 785, 786, 787, 788, 789, 790],

  // Ammunition ME/TE
  1820: [83, 84, 85, 86, 87, 88, 89, 90, 297, 385, 386, 387, 388, 389, 390, 479, 480, 481, 482, 652, 653, 654, 655, 656, 657, 658, 659, 660, 661, 662, 663], // Ammo groups
  1821: [83, 84, 85, 86, 87, 88, 89, 90, 297, 385, 386, 387, 388, 389, 390, 479, 480, 481, 482, 652, 653, 654, 655, 656, 657, 658, 659, 660, 661, 662, 663],

  // Drone and Fighter ME/TE
  1822: [100, 101, 157, 544], // Drone groups
  1823: [100, 101, 157, 544],

  // Basic Small Ship ME/TE
  1824: [25, 324, 420, 463, 893, 1305], // Frigates, Assault Frigates, Destroyers, Tactical Destroyers, etc.
  1825: [25, 324, 420, 463, 893, 1305],

  // Basic Medium Ship ME/TE
  1826: [26, 358, 419, 540, 541, 543, 830, 831, 832, 833, 834], // Cruisers, Heavy Assault Cruisers, Battlecruisers, etc.
  1827: [26, 358, 419, 540, 541, 543, 830, 831, 832, 833, 834],

  // Basic Large Ship ME/TE
  1828: [27, 380, 898, 900, 941], // Battleships, Marauders, Black Ops, etc.
  1829: [27, 380, 898, 900, 941],

  // Advanced Small Ship ME/TE
  1830: [237, 324, 831, 834, 893, 1283, 1305], // Covert Ops, Assault Frigates, Command Destroyers, etc.
  1831: [237, 324, 831, 834, 893, 1283, 1305],

  // Advanced Medium Ship ME/TE
  1832: [358, 540, 541, 543, 830, 832, 833, 894, 906, 963, 1283], // HACs, Recons, Heavy Interdictors, Command Ships, etc.
  1833: [358, 540, 541, 543, 830, 832, 833, 894, 906, 963, 1283],

  // Advanced Large Ship ME/TE
  1834: [380, 898, 900, 941], // Marauders, Black Ops, etc.
  1835: [380, 898, 900, 941],

  // Advanced Component ME/TE
  1836: [334, 964], // Advanced components
  1837: [334, 964],

  // Basic Capital Component ME/TE
  1838: [873], // Capital components
  1839: [873],

  // Structure ME/TE
  1840: [1312, 1404, 1406, 1657], // Structures (Engineering Complexes, Refineries, etc.)
  1841: [1312, 1404, 1406, 1657],

  // Large Rig versions (same mappings, just larger structures)
  1843: [11, 74, 212, 340, 478, 485, 543, 544, 545, 588, 646, 771, 772, 773, 774, 775, 776, 777, 778, 779, 780, 781, 782, 783, 784, 785, 786, 787, 788, 789, 790], // Equipment L
  1844: [11, 74, 212, 340, 478, 485, 543, 544, 545, 588, 646, 771, 772, 773, 774, 775, 776, 777, 778, 779, 780, 781, 782, 783, 784, 785, 786, 787, 788, 789, 790],
  1845: [83, 84, 85, 86, 87, 88, 89, 90, 297, 385, 386, 387, 388, 389, 390, 479, 480, 481, 482, 652, 653, 654, 655, 656, 657, 658, 659, 660, 661, 662, 663], // Ammunition L
  1846: [83, 84, 85, 86, 87, 88, 89, 90, 297, 385, 386, 387, 388, 389, 390, 479, 480, 481, 482, 652, 653, 654, 655, 656, 657, 658, 659, 660, 661, 662, 663],
  // ... continue for other Large rig groups
};

/**
 * Get product groups affected by a rig group
 * @param {number} rigGroupId - The rig's group ID
 * @returns {number[]} Array of product group IDs affected by this rig
 */
function getAffectedProductGroups(rigGroupId) {
  return RIG_TO_PRODUCT_GROUPS[rigGroupId] || [];
}

/**
 * Check if a rig affects a specific product
 * @param {number} rigGroupId - The rig's group ID
 * @param {number} productGroupId - The product's group ID
 * @returns {boolean} True if the rig affects this product
 */
function rigAffectsProduct(rigGroupId, productGroupId) {
  const affectedGroups = getAffectedProductGroups(rigGroupId);
  return affectedGroups.includes(productGroupId);
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
  RIG_TO_PRODUCT_GROUPS,
  getAffectedProductGroups,
  rigAffectsProduct,
  SECURITY_MULTIPLIERS,
  getSecurityMultiplier,
};
