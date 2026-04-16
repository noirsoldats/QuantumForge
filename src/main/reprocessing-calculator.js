/**
 * Reprocessing Calculator
 * Pure logic module for loot text parsing and Eve Online reprocessing yield calculations.
 * No DB or IPC dependencies.
 */

// ============================================================
// Type-specific skill mapping
// Maps groupID → Eve skill typeID for reprocessing yield bonus
// Source: Eve Online SDE dgmTypeAttributes (attributeID=790)
// ============================================================

// Ore groups (categoryID 25) — verified against SDE dgmTypeAttributes
const ORE_GROUP_SKILL_MAP = {
  // --- Simple Ore Processing (60377) ---
  458: 60377, // Plagioclase
  459: 60377, // Pyroxeres
  460: 60377, // Scordite
  462: 60377, // Veldspar
  4513: 60377, // Mordunium
  4857: 60377, // Tyranite

  // --- Coherent Ore Processing (60378) ---
  454: 60378, // Hedbergite
  455: 60378, // Hemorphite
  456: 60378, // Jaspet
  457: 60378, // Kernite
  469: 60378, // Omber
  4514: 60378, // Ytirium
  4756: 60378, // Nocxite
  4759: 60378, // Griemeer

  // --- Variegated Ore Processing (60379) ---
  452: 60379, // Crokite
  453: 60379, // Dark Ochre
  467: 60379, // Gneiss
  4755: 60379, // Kylixium

  // --- Complex Ore Processing (60380) ---
  450: 60380, // Arkonor
  451: 60380, // Bistot
  461: 60380, // Spodumain
  4515: 60380, // Eifyrium
  4516: 60380, // Ducinium
  4757: 60380, // Ueganite
  4758: 60380, // Hezorime

  // --- Abyssal Ore Processing (60381) ---
  4029: 60381, // Talassonite
  4030: 60381, // Rakovene
  4031: 60381, // Bezdnacine

  // --- Erratic Ore Processing (90040) ---
  4915: 90040, // Prismaticite

  // --- Mercoxit Ore Processing (12189) ---
  468: 12189, // Mercoxit

  // Moon ores
  1884: 46152, // Ubiquitous Moon Ore
  1920: 46153, // Common Moon Ore
  1921: 46154, // Uncommon Moon Ore
  1922: 46155, // Rare Moon Ore
  1923: 46156, // Exceptional Moon Ore
};

// Ice groups (categoryID 25)
const ICE_GROUP_SKILL_MAP = {
  465: 18025, // Ice → Ice Processing
  903: 18025, // Ancient Compressed Ice → Ice Processing
};

// Categories that use Scrapmetal Processing (12196) — all non-ore/ice/moon reprocessable items
// Eve applies Scrapmetal Processing to: modules, drones, charges, structure modules
const SCRAPMETAL_CATEGORY_IDS = new Set([7, 8, 18, 66]); // Module, Charge, Drone, Structure Module

// Skill names for display in UI
const SKILL_NAMES = {
  60377: 'Simple Ore Processing',
  60378: 'Coherent Ore Processing',
  60379: 'Variegated Ore Processing',
  60380: 'Complex Ore Processing',
  60381: 'Abyssal Ore Processing',
  90040: 'Erratic Ore Processing',
  12189: 'Mercoxit Ore Processing',
  18025: 'Ice Processing',
  46152: 'Ubiquitous Moon Ore Processing',
  46153: 'Common Moon Ore Processing',
  46154: 'Uncommon Moon Ore Processing',
  46155: 'Rare Moon Ore Processing',
  46156: 'Exceptional Moon Ore Processing',
  12196: 'Scrapmetal Processing',
};

// ============================================================
// Loot Text Parser
// ============================================================

/**
 * Parse raw pasted loot text from Eve Online.
 * Supports two formats:
 *   Format 1 (Inventory): "ItemName\tQuantity"
 *   Format 2 (Assets):    "ItemName\tQuantity\tCategory\tVolume\tPrice ISK"
 *
 * @param {string} rawText - Raw clipboard paste
 * @returns {{ items: Array<{rawName: string, quantity: number}>, parseErrors: string[] }}
 */
function parseLootText(rawText) {
  if (!rawText || !rawText.trim()) {
    return { items: [], parseErrors: [] };
  }

  const lines = rawText.split('\n');
  const itemMap = new Map(); // rawName → quantity (for deduplication)
  const parseErrors = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const cols = trimmed.split('\t');

    let name = null;
    let quantity = 0;

    if (cols.length >= 5 && cols[4] && cols[4].includes('ISK')) {
      // Format 2: Assets window
      name = cols[0].trim();
      quantity = parseInt(cols[1].replace(/,/g, ''), 10);
    } else if (cols.length >= 2) {
      // Format 1: Inventory window
      name = cols[0].trim();
      quantity = parseInt(cols[1].replace(/,/g, ''), 10);
    } else {
      parseErrors.push(trimmed);
      continue;
    }

    if (!name || isNaN(quantity) || quantity <= 0) {
      parseErrors.push(trimmed);
      continue;
    }

    // Aggregate duplicates
    if (itemMap.has(name)) {
      itemMap.set(name, itemMap.get(name) + quantity);
    } else {
      itemMap.set(name, quantity);
    }
  }

  const items = [];
  for (const [rawName, quantity] of itemMap) {
    items.push({ rawName, quantity });
  }

  return { items, parseErrors };
}

// ============================================================
// Type-specific skill lookup
// ============================================================

/**
 * Get the Eve skill typeID that applies to reprocessing items of a given group/category.
 * Returns null if no type-specific skill applies.
 *
 * Scrapmetal Processing (12196) applies to modules, drones, charges, and structure modules
 * (categoryIDs 7, 8, 18, 66) — any item that has invTypeMaterials entries but is not ore/ice/moon.
 *
 * @param {number} categoryId - Eve category ID
 * @param {number} groupId - Eve group ID
 * @returns {{ skillId: number, skillName: string } | null}
 */
function getTypeSpecificSkillId(categoryId, groupId) {
  // Check ore groups first (categoryID 25 covers ore, ice, moon ore)
  const skillId = ORE_GROUP_SKILL_MAP[groupId] || ICE_GROUP_SKILL_MAP[groupId] || null;
  if (skillId) {
    return { skillId, skillName: SKILL_NAMES[skillId] || `Skill ${skillId}` };
  }

  // Scrapmetal Processing for modules, drones, charges, structure modules
  if (SCRAPMETAL_CATEGORY_IDS.has(categoryId)) {
    return { skillId: 12196, skillName: 'Scrapmetal Processing' };
  }

  return null;
}

// ============================================================
// Reprocessing Yield Calculator
// ============================================================

const BASE_YIELDS = {
  npc: 0.50,
  athanor: 0.54,
  tatara: 0.54,
};

const RIG_BONUSES = {
  none: 0,
  t1: 0.02,
  t2: 0.04,
};

// Eve standard stacking penalty constants (same as manufacturing rigs)
const STACKING_PENALTIES = [1.0, 0.8693, 0.5706, 0.2840, 0.1052, 0.0290];

// Tax rates are fixed by station type — not user-configurable
const STATION_TAX = {
  npc: 0.05,      // NPC stations always charge 5%
  athanor: 0.00,  // Player structures: 0% (corp sets their own, but 0 is standard)
  tatara: 0.00,
};

/**
 * Calculate the effective reprocessing yield scalar.
 *
 * Formula:
 *   yield = stationBase × (1 - taxRate)
 *         × (1 + Reprocessing × 0.03)
 *         × (1 + ReprocessingEfficiency × 0.02)
 *         × (1 + TypeSpecificSkill × 0.02)
 *         × (1 + implantBonus)
 *         × rigMultiplier
 *
 * @param {Object} stationConfig
 * @param {string} stationConfig.stationType - 'npc' | 'athanor' | 'tatara'
 * @param {string} stationConfig.rig - 'none' | 't1' | 't2' (slot 1)
 * @param {string} stationConfig.rig2 - 'none' | 't1' | 't2' (slot 2, Tatara only)
 * @param {Object} skills
 * @param {number} skills.reprocessing - 0–5 (skillID 3385)
 * @param {number} skills.reprocessingEfficiency - 0–5 (skillID 3389)
 * @param {number} skills.typeSpecific - 0–5 (ore/ice/moon/scrapmetal processing skill for this item)
 * @param {number} implantBonus - 0 | 0.01 | 0.02 | 0.04
 * @returns {number} Effective yield scalar (e.g. 0.7432)
 */
function calculateReprocessingYield(stationConfig, skills, implantBonus) {
  const base = BASE_YIELDS[stationConfig.stationType] || 0.50;
  const tax = 1 - (STATION_TAX[stationConfig.stationType] ?? 0.05);

  const skillMult = (1 + (skills.reprocessing || 0) * 0.03)
                  * (1 + (skills.reprocessingEfficiency || 0) * 0.02)
                  * (1 + (skills.typeSpecific || 0) * 0.02);

  const implant = 1 + (implantBonus || 0);

  // Rig multiplier with stacking penalties
  const r1 = RIG_BONUSES[stationConfig.rig] || 0;
  const r2 = (stationConfig.stationType === 'tatara') ? (RIG_BONUSES[stationConfig.rig2] || 0) : 0;

  let rigMultiplier = 1.0;
  if (r1 > 0) rigMultiplier += r1 * STACKING_PENALTIES[0];
  if (r2 > 0) rigMultiplier += r2 * STACKING_PENALTIES[1];

  return base * tax * skillMult * implant * rigMultiplier;
}

// ============================================================
// Reprocessing Value Calculator
// ============================================================

/**
 * Calculate the ISK value of reprocessing a stack of items.
 *
 * Formula per material:
 *   batchCount = Math.floor(quantity / portionSize)
 *   yieldedQty = Math.floor(batchCount × materialQty × yieldRate)
 *   value      = yieldedQty × unitPrice
 *
 * @param {number} quantity - Number of items to reprocess
 * @param {number} yieldRate - Effective yield scalar from calculateReprocessingYield
 * @param {Object|null} reprocessingData - Entry from getReprocessingMaterials: { portionSize, materials }
 * @param {Object} materialPrices - Map of materialTypeId → { sell: number, buy: number }
 * @returns {{ sellValue: number, buyValue: number, materials: Array, canReprocess: boolean }}
 */
function calculateReprocessingValue(quantity, yieldRate, reprocessingData, materialPrices) {
  if (!reprocessingData || !reprocessingData.materials || reprocessingData.materials.length === 0) {
    return { sellValue: 0, buyValue: 0, materials: [], canReprocess: false };
  }

  const { portionSize, materials } = reprocessingData;
  const batchCount = Math.floor(quantity / portionSize);

  if (batchCount === 0) {
    return { sellValue: 0, buyValue: 0, materials: [], canReprocess: true };
  }

  let totalSell = 0;
  let totalBuy = 0;
  const materialDetails = [];

  for (const mat of materials) {
    const yieldedQty = Math.floor(batchCount * mat.quantity * yieldRate);
    if (yieldedQty === 0) continue;

    const prices = materialPrices[mat.materialTypeId] || { sell: 0, buy: 0 };
    const matSellValue = yieldedQty * prices.sell;
    const matBuyValue = yieldedQty * prices.buy;

    totalSell += matSellValue;
    totalBuy += matBuyValue;

    materialDetails.push({
      materialTypeId: mat.materialTypeId,
      qty: yieldedQty,
      sellValue: matSellValue,
      buyValue: matBuyValue,
    });
  }

  return {
    sellValue: totalSell,
    buyValue: totalBuy,
    materials: materialDetails,
    canReprocess: true,
  };
}

module.exports = {
  parseLootText,
  getTypeSpecificSkillId,
  calculateReprocessingYield,
  calculateReprocessingValue,
};
