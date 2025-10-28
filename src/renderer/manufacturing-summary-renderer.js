// Manufacturing Summary Renderer

let allBlueprints = [];
let calculatedData = [];
let currentFilter = 'owned';
let currentSort = { column: 'profit', direction: 'desc' };

// Filter configuration
let blueprintFilters = loadFilterConfig();

function loadFilterConfig() {
  try {
    const saved = localStorage.getItem('manufacturing-summary-filters');
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (error) {
    console.error('Error loading filter config:', error);
  }
  // Default: all filters enabled
  return {
    tech: ['T1', 'T2', 'T3', 'Storyline', 'Navy', 'Pirate'],
    category: ['Ships', 'Drones', 'Modules', 'Ammo/Charges', 'Components', 'Rigs', 'Deployables', 'Subsystems', 'Structures', 'Structure Rigs', 'Structure Modules', 'Boosters', 'Celestials', 'Reactions']
  };
}

function saveFilterConfig() {
  try {
    localStorage.setItem('manufacturing-summary-filters', JSON.stringify(blueprintFilters));
  } catch (error) {
    console.error('Error saving filter config:', error);
  }
}

// Column configuration
const ALL_COLUMNS = [
  // Default columns
  { id: 'category', label: 'Category', default: true, sortable: true, align: 'left' },
  { id: 'name', label: 'Item Name', default: true, sortable: true, align: 'left' },
  { id: 'owned', label: 'Owned?', default: true, sortable: true, align: 'center' },
  { id: 'tech', label: 'Tech', default: true, sortable: true, align: 'center' },
  { id: 'me', label: 'ME', default: true, sortable: true, align: 'center' },
  { id: 'te', label: 'TE', default: true, sortable: true, align: 'center' },
  { id: 'profit', label: 'Profit', default: true, sortable: true, align: 'right' },
  { id: 'isk-per-hour', label: 'ISK/Hour', default: true, sortable: true, align: 'right' },
  { id: 'svr', label: 'SVR', default: true, sortable: true, align: 'right' },
  { id: 'total-cost', label: 'Total Cost', default: true, sortable: true, align: 'right' },
  { id: 'roi', label: 'ROI %', default: true, sortable: true, align: 'right' },

  // Optional columns
  { id: 'job-costs', label: 'Job Costs', default: false, sortable: true, align: 'right' },
  { id: 'material-purchase-fees', label: 'Material Purchase Fees', default: false, sortable: true, align: 'right' },
  { id: 'product-selling-fees', label: 'Product Selling Fees', default: false, sortable: true, align: 'right' },
  { id: 'trading-fees-total', label: 'Trading Fees Total', default: false, sortable: true, align: 'right' },
  { id: 'blueprint-type', label: 'Blueprint Type', default: false, sortable: true, align: 'center' },
  { id: 'product-market-price', label: 'Product Market Price', default: false, sortable: true, align: 'right' },
  { id: 'profit-percentage', label: 'Profit %', default: false, sortable: true, align: 'right' },
  { id: 'manufacturing-steps', label: 'Manufacturing Steps', default: false, sortable: true, align: 'center' },
  { id: 'm3-inputs', label: 'M³ Inputs', default: false, sortable: true, align: 'right' },
  { id: 'm3-outputs', label: 'M³ Outputs', default: false, sortable: true, align: 'right' },
  { id: 'current-sell-orders', label: 'Current Sell Orders', default: false, sortable: true, align: 'right' },

  // New Market Trend Columns
  { id: 'profit-velocity', label: 'Profit Velocity (ISK/Day)', default: false, sortable: true, align: 'right' },
  { id: 'market-saturation', label: 'Market Saturation Index', default: false, sortable: true, align: 'right' },
  { id: 'price-momentum', label: 'Price Momentum', default: false, sortable: true, align: 'right' },
  { id: 'profit-stability', label: 'Profit Stability Index', default: false, sortable: true, align: 'right' },
  { id: 'demand-growth', label: 'Demand Growth Rate', default: false, sortable: true, align: 'right' },
  { id: 'material-cost-volatility', label: 'Material Cost Volatility', default: false, sortable: true, align: 'right' },
  { id: 'market-health-score', label: 'Market Health Score', default: false, sortable: true, align: 'right' },
];

let visibleColumns = loadColumnConfig();

// Load column configuration from localStorage
function loadColumnConfig() {
  try {
    const saved = localStorage.getItem('manufacturing-summary-columns');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Validate that all column IDs exist
      const validColumns = parsed.filter(id => ALL_COLUMNS.find(col => col.id === id));
      if (validColumns.length > 0) {
        return validColumns;
      }
    }
  } catch (error) {
    console.error('Error loading column config:', error);
  }
  // Default columns if no saved config or error
  return ALL_COLUMNS.filter(col => col.default).map(col => col.id);
}

// Save column configuration to localStorage
function saveColumnConfig() {
  try {
    localStorage.setItem('manufacturing-summary-columns', JSON.stringify(visibleColumns));
  } catch (error) {
    console.error('Error saving column config:', error);
  }
}

// Initialize the page
document.addEventListener('DOMContentLoaded', async () => {
  await loadFacilities();
  setupEventListeners();
  renderTableHeaders(); // Initialize table headers with saved/default columns
});

// Load facilities into dropdown
async function loadFacilities() {
  try {
    const facilities = await window.electronAPI.facilities.getFacilities();
    const facilitySelect = document.getElementById('facility-select');

    if (facilities && facilities.length > 0) {
      facilities.forEach(facility => {
        const option = document.createElement('option');
        option.value = facility.id;
        option.textContent = facility.name;
        if (facility.usage === 'default') {
          option.selected = true;
        }
        facilitySelect.appendChild(option);
      });
    } else {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No facilities configured';
      facilitySelect.appendChild(option);
    }
  } catch (error) {
    console.error('Error loading facilities:', error);
  }
}

// Setup event listeners
function setupEventListeners() {
  // Back button - close window
  document.getElementById('back-btn').addEventListener('click', () => {
    window.close();
  });

  // Blueprint filter radios
  document.querySelectorAll('input[name="blueprint-filter"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      currentFilter = e.target.value;
    });
  });

  // Calculate button
  document.getElementById('calculate-btn').addEventListener('click', calculateSummary);

  // Search box
  document.getElementById('search-box').addEventListener('input', (e) => {
    filterAndDisplayResults(e.target.value);
  });

  // Configure columns button
  document.getElementById('configure-columns-btn')?.addEventListener('click', openColumnConfigModal);

  // Close column modal
  document.getElementById('close-column-modal-btn')?.addEventListener('click', closeColumnConfigModal);

  // Reset columns button
  document.getElementById('reset-columns-btn')?.addEventListener('click', resetColumns);

  // Apply columns button
  document.getElementById('apply-columns-btn')?.addEventListener('click', applyColumns);

  // Filter modal handlers
  document.getElementById('configure-filters-btn')?.addEventListener('click', openFilterConfigModal);
  document.getElementById('close-filter-modal-btn')?.addEventListener('click', closeFilterConfigModal);
  document.getElementById('select-all-filters-btn')?.addEventListener('click', selectAllFilters);
  document.getElementById('clear-all-filters-btn')?.addEventListener('click', clearAllFilters);
  document.getElementById('apply-filters-btn')?.addEventListener('click', applyFilters);

  // Modal backdrop click
  document.getElementById('column-config-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'column-config-modal') {
      closeColumnConfigModal();
    }
  });

  document.getElementById('filter-config-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'filter-config-modal') {
      closeFilterConfigModal();
    }
  });
}

// Main calculation function
async function calculateSummary() {
  const facilityId = document.getElementById('facility-select').value;
  if (!facilityId) {
    alert('Please select a facility');
    return;
  }

  // Show loading
  showLoading('Loading blueprints...');
  hideEmptyState();
  hideResults();

  try {
    // Get blueprints based on filter
    const blueprints = await getBlueprintsByFilter();

    if (!blueprints || blueprints.length === 0) {
      showEmptyState();
      hideLoading();
      return;
    }

    allBlueprints = blueprints;
    calculatedData = [];

    // Calculate data for each blueprint
    showLoading(`Calculating profitability for ${blueprints.length} blueprints...`);

    const facility = await window.electronAPI.facilities.getFacility(facilityId);
    const svrPeriod = parseInt(document.getElementById('svr-period').value);
    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();

    // Get owned blueprints list based on current filter
    let ownedBlueprintsList = null;
    if (defaultCharacter && (currentFilter === 'owned' || currentFilter === 'corp')) {
      const allOwnedBlueprints = await window.electronAPI.blueprints.getAll(defaultCharacter.characterId);

      // Filter based on current filter setting
      if (currentFilter === 'owned') {
        // Character blueprints only
        ownedBlueprintsList = allOwnedBlueprints.filter(bp => {
          const isCorp = bp.isCorporation || (
            bp.locationFlag && (
              bp.locationFlag.startsWith('CorpSAG') ||
              bp.locationFlag.startsWith('CorpDeliveries')
            )
          );
          return !isCorp;
        });
      } else if (currentFilter === 'corp') {
        // Corporation blueprints only
        ownedBlueprintsList = allOwnedBlueprints.filter(bp => {
          return bp.isCorporation || (
            bp.locationFlag && (
              bp.locationFlag.startsWith('CorpSAG') ||
              bp.locationFlag.startsWith('CorpDeliveries')
            )
          );
        });
      }
    }

    let completed = 0;
    for (const blueprint of blueprints) {
      completed++;
      if (completed % 10 === 0) {
        showLoading(`Calculating... ${completed}/${blueprints.length}`);
        // Allow UI to update
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      // Check if blueprint matches filters
      const techLevel = determineTechLevel(blueprint);
      const category = determineCategory(blueprint);

      if (!blueprintFilters.tech.includes(techLevel) || !blueprintFilters.category.includes(category)) {
        continue; // Skip this blueprint
      }

      try {
        const data = await calculateBlueprintData(blueprint, facility, svrPeriod, defaultCharacter, ownedBlueprintsList);
        if (data) {
          calculatedData.push(data);
        }
      } catch (error) {
        console.error(`Error calculating blueprint ${blueprint.typeName}:`, error);
      }
    }

    hideLoading();
    sortTable(currentSort.column, currentSort.direction);
    displayResults();

  } catch (error) {
    console.error('Error calculating summary:', error);
    alert('Error calculating summary: ' + error.message);
    hideLoading();
    showEmptyState();
  }
}

// Get blueprints based on current filter
async function getBlueprintsByFilter() {
  switch (currentFilter) {
    case 'all':
      return await window.electronAPI.calculator.getAllBlueprints(null);

    case 'owned':
      const defaultChar = await window.electronAPI.esi.getDefaultCharacter();
      if (!defaultChar) {
        alert('No default character set. Please set a default character in settings.');
        return [];
      }
      const allOwnedBlueprints = await window.electronAPI.blueprints.getAll(defaultChar.characterId);

      // Filter for character blueprints only (not corporation)
      const characterBlueprints = allOwnedBlueprints.filter(bp => {
        // Check if it's a corporation blueprint
        const isCorp = bp.isCorporation || (
          bp.locationFlag && (
            bp.locationFlag.startsWith('CorpSAG') ||
            bp.locationFlag.startsWith('CorpDeliveries')
          )
        );
        return !isCorp; // Return only character blueprints
      });

      // Get full blueprint data from SDE
      const allBPs = await window.electronAPI.calculator.getAllBlueprints(null);
      return allBPs.filter(bp => characterBlueprints.some(owned => owned.typeId === bp.typeID));

    case 'corp':
      const defaultCharCorp = await window.electronAPI.esi.getDefaultCharacter();
      if (!defaultCharCorp) {
        alert('No default character set. Please set a default character in settings.');
        return [];
      }
      const allOwnedBlueprintsCorp = await window.electronAPI.blueprints.getAll(defaultCharCorp.characterId);

      // Filter for corporation blueprints only
      const corporationBlueprints = allOwnedBlueprintsCorp.filter(bp => {
        // Check if it's a corporation blueprint
        return bp.isCorporation || (
          bp.locationFlag && (
            bp.locationFlag.startsWith('CorpSAG') ||
            bp.locationFlag.startsWith('CorpDeliveries')
          )
        );
      });

      if (corporationBlueprints.length === 0) {
        alert('No corporation blueprints found for this character.');
        return [];
      }

      // Get full blueprint data from SDE
      const allBPsCorp = await window.electronAPI.calculator.getAllBlueprints(null);
      return allBPsCorp.filter(bp => corporationBlueprints.some(owned => owned.typeId === bp.typeID));

    default:
      return [];
  }
}

// Calculate all data for a single blueprint
async function calculateBlueprintData(blueprint, facility, svrPeriod, defaultCharacter, ownedBlueprintsList = null) {
  try {
    const characterId = defaultCharacter ? defaultCharacter.characterId : null;

    // Get owned blueprint info from the provided list
    const ownedBP = ownedBlueprintsList ?
      ownedBlueprintsList.find(bp => bp.typeId === blueprint.typeID) : null;

    const isOwned = !!ownedBP;
    const meLevel = ownedBP ? (ownedBP.materialEfficiency || 0) : 0;
    const teLevel = ownedBP ? (ownedBP.timeEfficiency || 0) : 0;

    // Calculate materials and pricing
    const result = await window.electronAPI.calculator.calculateMaterials(
      blueprint.typeID,
      1, // 1 run
      meLevel,
      characterId,
      facility.id
    );

    if (!result || !result.pricing) {
      return null;
    }

    const pricing = result.pricing;

    // Calculate ISK per Hour
    const productionTimeSeconds = calculateProductionTime(blueprint.baseTime, teLevel, facility);
    const productionTimeHours = productionTimeSeconds / 3600;
    const iskPerHour = productionTimeHours > 0 ? pricing.profit / productionTimeHours : 0;

    // Calculate SVR
    const svr = await calculateSVR(blueprint.productTypeID, svrPeriod, productionTimeHours);

    // Calculate ROI
    const roi = pricing.totalCosts > 0 ? (pricing.profit / pricing.totalCosts) * 100 : 0;

    // Determine tech level
    const techLevel = determineTechLevel(blueprint);

    // Blueprint type
    const blueprintType = ownedBP?.isCopy ? 'BPC' : 'BPO';

    // Profit percentage - use pricing.profitMargin which is already calculated correctly
    const profitPercentage = pricing.profitMargin || 0;

    // Extract fee data from the correct pricing structure
    // Job costs are in pricing.jobCostBreakdown
    const jcb = pricing.jobCostBreakdown || {};
    const jobCostsTotal = (jcb.jobBaseCost || 0) + (jcb.facilityTax || 0) + (jcb.sccSurcharge || 0);

    // Trading taxes are in pricing.taxesBreakdown
    const tb = pricing.taxesBreakdown || {};
    const materialBrokerFee = tb.materialBrokerFee || 0;
    const productSellingFees = (tb.productSalesTax || 0) + (tb.productBrokerFee || 0);
    const tradingFeesTotal = (tb.productSalesTax || 0) + (tb.productBrokerFee || 0) + (tb.materialBrokerFee || 0);

    // Extract input and output costs
    const inputCosts = pricing.inputCosts || {};
    const outputValue = pricing.outputValue || {};

    // Calculate M³ for inputs
    const materialTypeIds = Object.keys(result.materials).map(id => parseInt(id));
    const materialVolumes = await window.electronAPI.sde.getItemVolumes(materialTypeIds);
    let totalInputVolume = 0;
    for (const [typeId, quantity] of Object.entries(result.materials)) {
      const volume = materialVolumes[typeId] || 0;
      totalInputVolume += volume * quantity;
    }

    // Get M³ for output product
    const productVolume = await window.electronAPI.sde.getItemVolume(blueprint.productTypeID);
    const totalOutputVolume = productVolume * result.product.quantity;

    // Get current sell orders volume
    const currentSellOrders = await calculateTotalSellVolume(blueprint.productTypeID);

    // Calculate manufacturing steps (1 for main blueprint + intermediate components)
    const intermediateComponents = result.breakdown?.[0]?.intermediateComponents || [];
    const manufacturingSteps = 1 + intermediateComponents.length;

    // Calculate new market trend metrics
    const profitVelocity = await calculateProfitVelocity(blueprint.productTypeID, pricing.profit, 30);
    const marketSaturation = await calculateMarketSaturation(blueprint.productTypeID, currentSellOrders, 30);
    const priceMomentum = await calculatePriceMomentum(blueprint.productTypeID);
    const profitStability = await calculateProfitStability(blueprint.productTypeID, pricing.profit, 28);
    const demandGrowth = await calculateDemandGrowth(blueprint.productTypeID);
    const materialCostVolatility = await calculateMaterialCostVolatility(result.materials, 30);
    const marketHealthScore = calculateMarketHealthScore(svr, marketSaturation, priceMomentum, profitStability);

    return {
      blueprintTypeId: blueprint.typeID,
      category: blueprint.category || 'Unknown',
      itemName: blueprint.typeName,
      productName: blueprint.productName,
      isOwned,
      techLevel,
      meLevel,
      teLevel,
      profit: pricing.profit,
      iskPerHour,
      svr,
      totalCost: pricing.totalCosts,
      roi,
      productionTimeHours,
      // New optional columns
      jobCosts: jobCostsTotal,
      materialPurchaseFees: materialBrokerFee,
      productSellingFees: productSellingFees,
      tradingFeesTotal: tradingFeesTotal,
      blueprintType: isOwned ? blueprintType : 'N/A',
      productMarketPrice: outputValue.totalValue || 0,
      profitPercentage,
      manufacturingSteps,
      m3Inputs: totalInputVolume,
      m3Outputs: totalOutputVolume,
      currentSellOrders,
      // New market trend metrics
      profitVelocity,
      marketSaturation,
      priceMomentum,
      profitStability,
      demandGrowth,
      materialCostVolatility,
      marketHealthScore,
    };
  } catch (error) {
    console.error(`Error calculating data for ${blueprint.typeName}:`, error);
    return null;
  }
}

// Calculate production time with bonuses
function calculateProductionTime(baseTime, teLevel, facility) {
  if (!baseTime) return 0;

  // Apply TE reduction (1% per level)
  let time = baseTime * (1 - (teLevel / 100));

  // Apply facility bonuses
  if (facility && facility.structureBonuses && facility.structureBonuses.timeEfficiency) {
    time = time * (1 - (facility.structureBonuses.timeEfficiency / 100));
  }

  // Apply rig bonuses (if applicable)
  // TODO: Add rig time bonuses when implemented

  return time;
}

// Calculate SVR (Sales to Volume Ratio)
async function calculateSVR(productTypeId, period, productionTimeHours) {
  try {
    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    // Get market history for the product
    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);

    if (!allHistory || allHistory.length === 0) {
      return 0;
    }

    // Filter to only the specified period (most recent N days)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period);
    const recentHistory = allHistory.filter(day => {
      const dayDate = new Date(day.date);
      return dayDate >= cutoffDate;
    });

    if (recentHistory.length === 0) {
      return 0;
    }

    // Calculate total units sold in the period
    const totalSold = recentHistory.reduce((sum, day) => sum + (day.volume || 0), 0);

    // Calculate how many units we could produce in the same period
    const periodHours = period * 24;
    const unitsProducible = productionTimeHours > 0 ? periodHours / productionTimeHours : 0;

    // SVR = units sold / units producible
    const svr = unitsProducible > 0 ? totalSold / unitsProducible : 0;

    return svr;
  } catch (error) {
    console.error('Error calculating SVR:', error);
    return 0;
  }
}

// Calculate total sell volume from market orders
async function calculateTotalSellVolume(productTypeId) {
  try {
    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002; // Default to The Forge

    // Get location filter based on market settings
    let locationFilter = null;
    if (marketSettings.locationType === 'system' && marketSettings.systemId) {
      locationFilter = { type: 'system', id: marketSettings.systemId };
    } else if (marketSettings.locationType === 'station' && marketSettings.locationId) {
      locationFilter = { type: 'station', id: marketSettings.locationId };
    }

    // Fetch market orders
    const orders = await window.electronAPI.market.fetchOrders(regionId, productTypeId, locationFilter);

    if (!orders || orders.length === 0) {
      return 0;
    }

    // Filter to sell orders only and sum volume_remain
    const sellOrders = orders.filter(o => !o.is_buy_order);
    const totalSellVolume = sellOrders.reduce((sum, o) => sum + (o.volume_remain || 0), 0);

    return totalSellVolume;
  } catch (error) {
    console.error('Error calculating total sell volume:', error);
    return 0;
  }
}

// Calculate Profit Velocity (ISK/Day)
// Formula: (Average profit per unit) × (Average units sold per day)
async function calculateProfitVelocity(productTypeId, profitPerUnit, period = 30) {
  try {
    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);
    if (!allHistory || allHistory.length === 0) return 0;

    // Filter to recent period
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period);
    const recentHistory = allHistory.filter(day => new Date(day.date) >= cutoffDate);
    if (recentHistory.length === 0) return 0;

    // Calculate average daily sales volume
    const totalSold = recentHistory.reduce((sum, day) => sum + (day.volume || 0), 0);
    const avgDailySales = totalSold / recentHistory.length;

    // Profit Velocity = profit per unit × average daily sales
    return profitPerUnit * avgDailySales;
  } catch (error) {
    console.error('Error calculating profit velocity:', error);
    return 0;
  }
}

// Calculate Market Saturation Index (MSI)
// Formula: Total Sell Volume Listed / Average Daily Sales Volume
async function calculateMarketSaturation(productTypeId, totalSellVolume, period = 30) {
  try {
    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);
    if (!allHistory || allHistory.length === 0) return 0;

    // Filter to recent period
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period);
    const recentHistory = allHistory.filter(day => new Date(day.date) >= cutoffDate);
    if (recentHistory.length === 0) return 0;

    // Calculate average daily sales volume
    const totalSold = recentHistory.reduce((sum, day) => sum + (day.volume || 0), 0);
    const avgDailySales = totalSold / recentHistory.length;

    if (avgDailySales === 0) return 0;

    // MSI = sell orders volume / daily sales volume
    // Higher MSI = oversupply, Lower MSI = healthy demand
    return totalSellVolume / avgDailySales;
  } catch (error) {
    console.error('Error calculating market saturation:', error);
    return 0;
  }
}

// Calculate Price Momentum
// Formula: (MA_7d - MA_30d) / MA_30d
async function calculatePriceMomentum(productTypeId) {
  try {
    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);
    if (!allHistory || allHistory.length < 30) return 0; // Need at least 30 days

    // Sort by date descending (most recent first)
    const sortedHistory = [...allHistory].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate 7-day moving average
    const last7Days = sortedHistory.slice(0, 7);
    const ma7 = last7Days.reduce((sum, day) => sum + (day.average || 0), 0) / last7Days.length;

    // Calculate 30-day moving average
    const last30Days = sortedHistory.slice(0, 30);
    const ma30 = last30Days.reduce((sum, day) => sum + (day.average || 0), 0) / last30Days.length;

    if (ma30 === 0) return 0;

    // Momentum = (MA_7d - MA_30d) / MA_30d
    // Positive = price rising, Negative = price falling
    return (ma7 - ma30) / ma30;
  } catch (error) {
    console.error('Error calculating price momentum:', error);
    return 0;
  }
}

// Calculate Profit Stability Index (PSI)
// Formula: 1 - (Standard Deviation of Weekly Margin / Average Weekly Margin)
async function calculateProfitStability(productTypeId, currentProfit, period = 28) {
  try {
    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);
    if (!allHistory || allHistory.length < period) return 0;

    // Get recent period
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period);
    const recentHistory = allHistory.filter(day => new Date(day.date) >= cutoffDate);
    if (recentHistory.length === 0) return 0;

    // Calculate daily profit margins (approximation using price changes)
    const dailyMargins = recentHistory.map(day => day.average || 0);

    // Calculate mean and standard deviation
    const mean = dailyMargins.reduce((sum, val) => sum + val, 0) / dailyMargins.length;
    const variance = dailyMargins.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / dailyMargins.length;
    const stdDev = Math.sqrt(variance);

    if (mean === 0) return 0;

    // PSI = 1 - (StdDev / Mean)
    // Higher PSI = more stable profits
    const psi = 1 - (stdDev / mean);
    return Math.max(0, Math.min(1, psi)); // Clamp between 0 and 1
  } catch (error) {
    console.error('Error calculating profit stability:', error);
    return 0;
  }
}

// Calculate Demand Growth Rate (DGR)
// Formula: (Avg daily sales last 7 days - Avg daily sales previous 7 days) / Avg daily sales previous 7 days
async function calculateDemandGrowth(productTypeId) {
  try {
    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    const allHistory = await window.electronAPI.market.fetchHistory(regionId, productTypeId);
    if (!allHistory || allHistory.length < 14) return 0; // Need at least 14 days

    // Sort by date descending (most recent first)
    const sortedHistory = [...allHistory].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Last 7 days
    const last7Days = sortedHistory.slice(0, 7);
    const avgLast7 = last7Days.reduce((sum, day) => sum + (day.volume || 0), 0) / last7Days.length;

    // Previous 7 days (days 8-14)
    const previous7Days = sortedHistory.slice(7, 14);
    const avgPrevious7 = previous7Days.reduce((sum, day) => sum + (day.volume || 0), 0) / previous7Days.length;

    if (avgPrevious7 === 0) return 0;

    // DGR = (recent - previous) / previous
    // Positive = demand growing, Negative = demand shrinking
    return (avgLast7 - avgPrevious7) / avgPrevious7;
  } catch (error) {
    console.error('Error calculating demand growth:', error);
    return 0;
  }
}

// Calculate Material Cost Volatility (MCV)
// Formula: σ(material adjusted prices) / mean(material adjusted prices)
async function calculateMaterialCostVolatility(materials, period = 30) {
  try {
    if (!materials || Object.keys(materials).length === 0) return 0;

    const marketSettings = await window.electronAPI.market.getSettings();
    const regionId = marketSettings.regionId || 10000002;

    // Collect price history for all materials
    const materialPriceHistories = [];
    for (const [typeId, quantity] of Object.entries(materials)) {
      try {
        const history = await window.electronAPI.market.fetchHistory(regionId, parseInt(typeId));
        if (history && history.length > 0) {
          materialPriceHistories.push({ typeId: parseInt(typeId), quantity, history });
        }
      } catch (error) {
        console.error(`Error fetching history for material ${typeId}:`, error);
      }
    }

    if (materialPriceHistories.length === 0) return 0;

    // Calculate daily total material costs
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - period);

    // Get all unique dates
    const allDates = new Set();
    materialPriceHistories.forEach(mph => {
      mph.history.forEach(day => {
        const dayDate = new Date(day.date);
        if (dayDate >= cutoffDate) {
          allDates.add(day.date);
        }
      });
    });

    const sortedDates = Array.from(allDates).sort();
    if (sortedDates.length < 2) return 0;

    // Calculate total material cost for each date
    const dailyCosts = sortedDates.map(date => {
      let totalCost = 0;
      materialPriceHistories.forEach(mph => {
        const dayData = mph.history.find(d => d.date === date);
        if (dayData) {
          totalCost += (dayData.average || 0) * mph.quantity;
        }
      });
      return totalCost;
    }).filter(cost => cost > 0);

    if (dailyCosts.length < 2) return 0;

    // Calculate mean and standard deviation
    const mean = dailyCosts.reduce((sum, val) => sum + val, 0) / dailyCosts.length;
    const variance = dailyCosts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / dailyCosts.length;
    const stdDev = Math.sqrt(variance);

    if (mean === 0) return 0;

    // MCV = StdDev / Mean (coefficient of variation)
    // Higher MCV = more volatile material costs
    return stdDev / mean;
  } catch (error) {
    console.error('Error calculating material cost volatility:', error);
    return 0;
  }
}

// Calculate Market Health Score (Composite Score)
// Formula: 0.3 × SVR + 0.3 × (1 - MSI) + 0.2 × Momentum + 0.2 × PSI
function calculateMarketHealthScore(svr, msi, momentum, psi) {
  try {
    // Normalize SVR to 0-1 range (cap at 2.0 for very high SVR)
    const normalizedSVR = Math.min(svr / 2.0, 1.0);

    // Normalize MSI to 0-1 range (inverse - lower is better, cap at 10 days)
    const normalizedMSI = Math.max(0, 1 - (msi / 10));

    // Normalize Momentum to 0-1 range (assuming -50% to +50% range)
    const normalizedMomentum = Math.max(0, Math.min(1, (momentum + 0.5) / 1.0));

    // PSI is already 0-1

    // Weighted composite score
    const healthScore = (0.3 * normalizedSVR) +
                       (0.3 * normalizedMSI) +
                       (0.2 * normalizedMomentum) +
                       (0.2 * psi);

    return healthScore;
  } catch (error) {
    console.error('Error calculating market health score:', error);
    return 0;
  }
}

// Determine tech level from blueprint data using metaGroupID
function determineTechLevel(blueprint) {
  const metaGroupID = blueprint.productMetaGroupID;

  // Map metaGroupID to tech level
  // Reference from invMetaGroups table:
  // 1 = Tech I, 2 = Tech II, 3 = Storyline, 4 = Faction, 14 = Tech III
  // 5 = Officer, 6 = Deadspace, 52 = Structure Faction, 53 = Structure Tech II

  switch (metaGroupID) {
    case 2:  // Tech II
    case 53: // Structure Tech II
      return 'T2';
    case 14: // Tech III
      return 'T3';
    case 3:  // Storyline
      return 'Storyline';
    case 4:  // Faction (Navy)
    case 52: // Structure Faction
      return 'Navy';
    case 5:  // Officer (Pirate)
    case 6:  // Deadspace (Pirate)
      return 'Pirate';
    case 1:  // Tech I
    case 54: // Structure Tech I
    default:
      return 'T1';
  }
}

// Map SDE categories/groups to our filter categories
function determineCategory(blueprint) {
  const sdeCategory = blueprint.productCategoryName || '';
  const sdeGroup = blueprint.productGroupName || '';

  // Ships - all products in Ship category
  if (sdeCategory === 'Ship') {
    return 'Ships';
  }

  // Drones - all products in Drone category
  if (sdeCategory === 'Drone') {
    return 'Drones';
  }

  // Fighters - group with Drones
  if (sdeCategory === 'Fighter') {
    return 'Drones';
  }

  // Modules - all products in Module category
  if (sdeCategory === 'Module') {
    return 'Modules';
  }

  // Ammo/Charges - all products in Charge category
  if (sdeCategory === 'Charge') {
    return 'Ammo/Charges';
  }

  // Subsystems - all products in Subsystem category
  if (sdeCategory === 'Subsystem') {
    return 'Subsystems';
  }

  // Deployables - all products in Deployable category
  if (sdeCategory === 'Deployable') {
    return 'Deployables';
  }

  // Structure Modules - all products in Structure Module category
  if (sdeCategory === 'Structure Module') {
    return 'Structure Modules';
  }

  // Structures - all products in Structure category
  if (sdeCategory === 'Structure') {
    // Check if it's a structure rig
    if (sdeGroup && sdeGroup.includes('Rig')) {
      return 'Structure Rigs';
    }
    return 'Structures';
  }

  // Boosters - products in Implant category with Booster groups
  if (sdeCategory === 'Implant' && sdeGroup && sdeGroup.includes('Booster')) {
    return 'Boosters';
  }

  // Reactions - all products in Reaction category
  if (sdeCategory === 'Reaction') {
    return 'Reactions';
  }

  // Celestials - all products in Celestial or Starbase categories
  if (sdeCategory === 'Celestial' || sdeCategory === 'Starbase' || sdeCategory === 'Station') {
    return 'Celestials';
  }

  // Components - check Material category or component-related groups
  if (sdeCategory === 'Material' || sdeCategory === 'Commodity') {
    return 'Components';
  }

  // Rigs - check for module category with rig groups (not structure rigs)
  if (sdeGroup && sdeGroup.includes('Rig') && sdeCategory !== 'Structure') {
    return 'Rigs';
  }

  // Default to Components for anything else (covers materials, intermediate products, etc.)
  return 'Components';
}

// Sort table
function sortTable(column, direction = null) {
  if (direction === null) {
    // Toggle direction if same column
    if (currentSort.column === column) {
      direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      direction = 'desc'; // Default to descending for new column
    }
  }

  currentSort = { column, direction };

  // Update header indicators
  document.querySelectorAll('.summary-table th[data-sort]').forEach(header => {
    header.removeAttribute('data-sort-direction');
  });
  const activeHeader = document.querySelector(`.summary-table th[data-sort="${column}"]`);
  if (activeHeader) {
    activeHeader.setAttribute('data-sort-direction', direction);
  }

  // Sort the data
  calculatedData.sort((a, b) => {
    let aVal, bVal;

    switch (column) {
      case 'category':
        aVal = a.category;
        bVal = b.category;
        break;
      case 'name':
        aVal = a.itemName;
        bVal = b.itemName;
        break;
      case 'owned':
        aVal = a.isOwned ? 1 : 0;
        bVal = b.isOwned ? 1 : 0;
        break;
      case 'tech':
        aVal = a.techLevel;
        bVal = b.techLevel;
        break;
      case 'me':
        aVal = a.meLevel;
        bVal = b.meLevel;
        break;
      case 'te':
        aVal = a.teLevel;
        bVal = b.teLevel;
        break;
      case 'profit':
        aVal = a.profit;
        bVal = b.profit;
        break;
      case 'isk-per-hour':
        aVal = a.iskPerHour;
        bVal = b.iskPerHour;
        break;
      case 'svr':
        aVal = a.svr;
        bVal = b.svr;
        break;
      case 'total-cost':
        aVal = a.totalCost;
        bVal = b.totalCost;
        break;
      case 'roi':
        aVal = a.roi;
        bVal = b.roi;
        break;
      case 'profit-velocity':
        aVal = a.profitVelocity || 0;
        bVal = b.profitVelocity || 0;
        break;
      case 'market-saturation':
        aVal = a.marketSaturation || 0;
        bVal = b.marketSaturation || 0;
        break;
      case 'price-momentum':
        aVal = a.priceMomentum || 0;
        bVal = b.priceMomentum || 0;
        break;
      case 'profit-stability':
        aVal = a.profitStability || 0;
        bVal = b.profitStability || 0;
        break;
      case 'demand-growth':
        aVal = a.demandGrowth || 0;
        bVal = b.demandGrowth || 0;
        break;
      case 'material-cost-volatility':
        aVal = a.materialCostVolatility || 0;
        bVal = b.materialCostVolatility || 0;
        break;
      case 'market-health-score':
        aVal = a.marketHealthScore || 0;
        bVal = b.marketHealthScore || 0;
        break;
      default:
        return 0;
    }

    if (typeof aVal === 'string') {
      aVal = aVal.toLowerCase();
      bVal = bVal.toLowerCase();
    }

    if (direction === 'asc') {
      return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
    } else {
      return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
    }
  });

  displayResults();
}

// Display results in table
function displayResults(searchTerm = '') {
  const tbody = document.getElementById('summary-table-body');
  tbody.innerHTML = '';

  let filteredData = calculatedData;
  if (searchTerm) {
    const search = searchTerm.toLowerCase();
    filteredData = calculatedData.filter(item =>
      item.itemName.toLowerCase().includes(search) ||
      item.category.toLowerCase().includes(search) ||
      item.productName.toLowerCase().includes(search)
    );
  }

  document.getElementById('results-count').textContent = `${filteredData.length} blueprints`;

  filteredData.forEach(item => {
    const row = document.createElement('tr');

    // Build row with visible columns in correct order
    row.innerHTML = visibleColumns.map(colId => getCellContent(colId, item)).join('');

    tbody.appendChild(row);
  });

  showResults();
}

// Filter and display results based on search
function filterAndDisplayResults(searchTerm) {
  displayResults(searchTerm);
}

// UI State Management
function showLoading(message) {
  const indicator = document.getElementById('loading-indicator');
  const messageEl = document.getElementById('loading-message');
  messageEl.textContent = message;
  indicator.classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-indicator').classList.add('hidden');
}

function showResults() {
  document.getElementById('results-section').classList.remove('hidden');
}

function hideResults() {
  document.getElementById('results-section').classList.add('hidden');
}

function showEmptyState() {
  document.getElementById('empty-state').classList.remove('hidden');
}

function hideEmptyState() {
  document.getElementById('empty-state').classList.add('hidden');
}

// Utility Functions
function formatISK(value) {
  if (!value || value === 0) return '0.00';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(text) {
  if (text === null || text === undefined) {
    return '';
  }
  // Convert to string if not already
  const str = String(text);
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return str.replace(/[&<>"']/g, m => map[m]);
}

// Column Configuration Functions
function openColumnConfigModal() {
  const modal = document.getElementById('column-config-modal');
  const columnList = document.getElementById('column-list');

  // Build ordered column list: visible columns first (in saved order), then hidden columns
  const visibleColumnObjs = visibleColumns.map(id => ALL_COLUMNS.find(col => col.id === id)).filter(Boolean);
  const hiddenColumnObjs = ALL_COLUMNS.filter(col => !visibleColumns.includes(col.id));
  const orderedColumns = [...visibleColumnObjs, ...hiddenColumnObjs];

  // Build column list
  columnList.innerHTML = orderedColumns.map((col, index) => {
    const isVisible = visibleColumns.includes(col.id);
    const badge = col.default ? '<span class="column-badge">Default</span>' : '';

    return `
      <div class="column-item" draggable="true" data-column-id="${col.id}" data-index="${index}">
        <span class="drag-handle">☰</span>
        <input type="checkbox" class="column-checkbox" id="col-check-${col.id}" ${isVisible ? 'checked' : ''}>
        <label class="column-label" for="col-check-${col.id}">${col.label}</label>
        ${badge}
      </div>
    `;
  }).join('');

  // Setup drag and drop
  setupColumnDragAndDrop();

  modal.style.display = 'flex';
}

function closeColumnConfigModal() {
  const modal = document.getElementById('column-config-modal');
  modal.style.display = 'none';
}

function resetColumns() {
  visibleColumns = ALL_COLUMNS.filter(col => col.default).map(col => col.id);

  // Save configuration
  saveColumnConfig();

  // Update checkboxes
  ALL_COLUMNS.forEach(col => {
    const checkbox = document.getElementById(`col-check-${col.id}`);
    if (checkbox) {
      checkbox.checked = col.default;
    }
  });

  // Re-render the column list in default order
  const columnList = document.getElementById('column-list');
  columnList.innerHTML = ALL_COLUMNS.map((col, index) => {
    const isVisible = visibleColumns.includes(col.id);
    const badge = col.default ? '<span class="column-badge">Default</span>' : '';

    return `
      <div class="column-item" draggable="true" data-column-id="${col.id}" data-index="${index}">
        <span class="drag-handle">☰</span>
        <input type="checkbox" class="column-checkbox" id="col-check-${col.id}" ${isVisible ? 'checked' : ''}>
        <label class="column-label" for="col-check-${col.id}">${col.label}</label>
        ${badge}
      </div>
    `;
  }).join('');

  // Re-setup drag and drop
  setupColumnDragAndDrop();
}

function applyColumns() {
  // Get checked columns in current order
  const columnItems = document.querySelectorAll('.column-item');
  const newVisibleColumns = [];

  columnItems.forEach(item => {
    const columnId = item.getAttribute('data-column-id');
    const checkbox = item.querySelector('.column-checkbox');
    if (checkbox && checkbox.checked) {
      newVisibleColumns.push(columnId);
    }
  });

  if (newVisibleColumns.length === 0) {
    alert('You must have at least one column visible');
    return;
  }

  visibleColumns = newVisibleColumns;

  // Save configuration
  saveColumnConfig();

  // Re-render table
  renderTableHeaders();
  displayResults();

  closeColumnConfigModal();
}

// Filter Configuration Functions
function openFilterConfigModal() {
  const modal = document.getElementById('filter-config-modal');

  // Set checkbox states based on current filters
  document.querySelectorAll('.filter-checkbox').forEach(checkbox => {
    const filterType = checkbox.getAttribute('data-filter-type');
    const value = checkbox.value;
    checkbox.checked = blueprintFilters[filterType]?.includes(value) || false;
  });

  modal.style.display = 'flex';
}

function closeFilterConfigModal() {
  const modal = document.getElementById('filter-config-modal');
  modal.style.display = 'none';
}

function selectAllFilters() {
  document.querySelectorAll('.filter-checkbox').forEach(checkbox => {
    checkbox.checked = true;
  });
}

function clearAllFilters() {
  document.querySelectorAll('.filter-checkbox').forEach(checkbox => {
    checkbox.checked = false;
  });
}

function applyFilters() {
  // Collect selected filters
  const newFilters = {
    tech: [],
    category: []
  };

  document.querySelectorAll('.filter-checkbox').forEach(checkbox => {
    if (checkbox.checked) {
      const filterType = checkbox.getAttribute('data-filter-type');
      const value = checkbox.value;
      newFilters[filterType].push(value);
    }
  });

  // Validate at least one filter is selected
  if (newFilters.tech.length === 0 && newFilters.category.length === 0) {
    alert('You must have at least one filter selected');
    return;
  }

  blueprintFilters = newFilters;

  // Save configuration
  saveFilterConfig();

  // Re-calculate with new filters
  closeFilterConfigModal();

  // If we already have calculated data, recalculate
  if (calculatedData.length > 0) {
    calculateSummary();
  }
}

function setupColumnDragAndDrop() {
  const columnItems = document.querySelectorAll('.column-item');
  let draggedItem = null;

  columnItems.forEach(item => {
    item.addEventListener('dragstart', (e) => {
      draggedItem = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedItem = null;
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      const afterElement = getDragAfterElement(item.parentElement, e.clientY);
      if (afterElement == null) {
        item.parentElement.appendChild(draggedItem);
      } else {
        item.parentElement.insertBefore(draggedItem, afterElement);
      }
    });
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.column-item:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;

    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function renderTableHeaders() {
  const thead = document.querySelector('.summary-table thead tr');
  if (!thead) return;

  thead.innerHTML = visibleColumns.map(colId => {
    const col = ALL_COLUMNS.find(c => c.id === colId);
    if (!col) return '';

    const sortAttr = col.sortable ? `data-sort="${col.id}"` : '';
    return `<th ${sortAttr}>${col.label}</th>`;
  }).join('');

  // Re-attach sorting handlers
  document.querySelectorAll('.summary-table th[data-sort]').forEach(header => {
    header.addEventListener('click', () => {
      const column = header.getAttribute('data-sort');
      sortTable(column);
    });
  });
}

function getCellContent(columnId, item) {
  const profitClass = item.profit > 0 ? 'positive' : item.profit < 0 ? 'negative' : 'neutral';
  const svrClass = item.svr >= 1 ? 'positive' : item.svr >= 0.5 ? 'neutral' : 'negative';
  const roiClass = item.roi > 0 ? 'positive' : item.roi < 0 ? 'negative' : 'neutral';

  switch (columnId) {
    case 'category':
      return `<td>${escapeHtml(item.category)}</td>`;
    case 'name':
      return `<td>${escapeHtml(item.itemName)}</td>`;
    case 'owned':
      return `<td class="text-center ${item.isOwned ? 'owned-yes' : 'owned-no'}">${item.isOwned ? 'Yes' : 'No'}</td>`;
    case 'tech':
      return `<td class="text-center">${item.techLevel}</td>`;
    case 'me':
      return `<td class="text-center">${item.meLevel}</td>`;
    case 'te':
      return `<td class="text-center">${item.teLevel}</td>`;
    case 'profit':
      return `<td class="text-right ${profitClass}">${formatISK(item.profit)}</td>`;
    case 'isk-per-hour':
      return `<td class="text-right">${formatISK(item.iskPerHour)}</td>`;
    case 'svr':
      return `<td class="text-right ${svrClass}">${item.svr.toFixed(2)}</td>`;
    case 'total-cost':
      return `<td class="text-right">${formatISK(item.totalCost)}</td>`;
    case 'roi':
      return `<td class="text-right ${roiClass}">${item.roi.toFixed(2)}%</td>`;
    case 'job-costs':
      return `<td class="text-right">${formatISK(item.jobCosts || 0)}</td>`;
    case 'material-purchase-fees':
      return `<td class="text-right">${formatISK(item.materialPurchaseFees || 0)}</td>`;
    case 'product-selling-fees':
      return `<td class="text-right">${formatISK(item.productSellingFees || 0)}</td>`;
    case 'trading-fees-total':
      return `<td class="text-right">${formatISK(item.tradingFeesTotal || 0)}</td>`;
    case 'blueprint-type':
      return `<td class="text-center">${item.blueprintType || 'N/A'}</td>`;
    case 'product-market-price':
      return `<td class="text-right">${formatISK(item.productMarketPrice || 0)}</td>`;
    case 'profit-percentage':
      return `<td class="text-right ${profitClass}">${item.profitPercentage?.toFixed(2) || '0.00'}%</td>`;
    case 'manufacturing-steps':
      return `<td class="text-center">${item.manufacturingSteps || 0}</td>`;
    case 'm3-inputs':
      return `<td class="text-right">${item.m3Inputs?.toFixed(2) || '0.00'}</td>`;
    case 'm3-outputs':
      return `<td class="text-right">${item.m3Outputs?.toFixed(2) || '0.00'}</td>`;
    case 'current-sell-orders':
      return `<td class="text-right">${item.currentSellOrders?.toLocaleString() || '0'}</td>`;

    // New Market Trend Columns
    case 'profit-velocity': {
      const pvClass = (item.profitVelocity || 0) > 0 ? 'positive' : 'neutral';
      return `<td class="text-right ${pvClass}">${formatISK(item.profitVelocity || 0)}</td>`;
    }
    case 'market-saturation': {
      // Lower MSI is better (less saturated)
      const msi = item.marketSaturation || 0;
      const msiClass = msi < 3 ? 'positive' : msi < 7 ? 'neutral' : 'negative';
      return `<td class="text-right ${msiClass}">${msi.toFixed(2)}</td>`;
    }
    case 'price-momentum': {
      const momentum = item.priceMomentum || 0;
      const momentumClass = momentum > 0.05 ? 'positive' : momentum < -0.05 ? 'negative' : 'neutral';
      const momentumPct = (momentum * 100).toFixed(2);
      return `<td class="text-right ${momentumClass}">${momentumPct}%</td>`;
    }
    case 'profit-stability': {
      const psi = item.profitStability || 0;
      const psiClass = psi > 0.7 ? 'positive' : psi > 0.4 ? 'neutral' : 'negative';
      return `<td class="text-right ${psiClass}">${psi.toFixed(3)}</td>`;
    }
    case 'demand-growth': {
      const dgr = item.demandGrowth || 0;
      const dgrClass = dgr > 0.1 ? 'positive' : dgr < -0.1 ? 'negative' : 'neutral';
      const dgrPct = (dgr * 100).toFixed(2);
      return `<td class="text-right ${dgrClass}">${dgrPct}%</td>`;
    }
    case 'material-cost-volatility': {
      const mcv = item.materialCostVolatility || 0;
      const mcvClass = mcv < 0.15 ? 'positive' : mcv < 0.3 ? 'neutral' : 'negative';
      return `<td class="text-right ${mcvClass}">${mcv.toFixed(3)}</td>`;
    }
    case 'market-health-score': {
      const mhs = item.marketHealthScore || 0;
      const mhsClass = mhs > 0.7 ? 'positive' : mhs > 0.4 ? 'neutral' : 'negative';
      return `<td class="text-right ${mhsClass}">${mhs.toFixed(3)}</td>`;
    }

    default:
      return '<td>N/A</td>';
  }
}
