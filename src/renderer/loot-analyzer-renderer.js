/**
 * Loot Analyzer Renderer
 * Handles the Loot Analyzer standalone window UI.
 */

// ============================================================
// Hub-enabled regions (mirrors getTradeHubs() in sde-database.js)
// ============================================================
const HUB_REGIONS = {
  10000002: { name: 'Jita IV - Moon 4',      stationId: 60003760 },
  10000043: { name: 'Amarr VIII - Oris',     stationId: 60008494 },
  10000032: { name: 'Dodixie IX - Moon 20',  stationId: 60011866 },
  10000030: { name: 'Rens VI - Moon 8',       stationId: 60004588 },
  10000042: { name: 'Hek VIII - Moon 12',    stationId: 60005686 },
};

const STALE_WARN_MS  = 2 * 60 * 60 * 1000; // 2 hours
const STALE_CRIT_MS  = 6 * 60 * 60 * 1000; // 6 hours

// ============================================================
// State
// ============================================================
let regionDashboard = [];        // [{ regionId, regionName, lastFetch }]
let currentItems = [];           // enriched items from parseAndEnrich
let currentPrices = {};          // price map from fetchPrices (item typeIds → price data)
let currentMaterialPrices = {}; // material price map from fetchPrices (material typeIds → {m1Sell, m1Buy})
let currentReprocessingConfig = null; // { stationConfig, implantBonus } for per-item yield
let sortColumn = 'totalBest';
let sortDir = 'desc';

// Mapping from skill DOM id → Eve skill typeID (mirrors reprocessing-calculator.js ORE_GROUP_SKILL_MAP)
const ORE_SKILL_INPUTS = [
  // Mineral Ore Processing skills (SDE-verified skill typeIDs)
  { id: 'skill-simple-ore',    skillId: 60377 }, // Simple Ore Processing
  { id: 'skill-coherent-ore',  skillId: 60378 }, // Coherent Ore Processing
  { id: 'skill-variegated-ore',skillId: 60379 }, // Variegated Ore Processing
  { id: 'skill-complex-ore',   skillId: 60380 }, // Complex Ore Processing
  { id: 'skill-abyssal-ore',   skillId: 60381 }, // Abyssal Ore Processing
  { id: 'skill-erratic-ore',   skillId: 90040 }, // Erratic Ore Processing
  { id: 'skill-mercoxit-ore',  skillId: 12189 }, // Mercoxit Ore Processing
  // Ice
  { id: 'skill-ice',           skillId: 18025 }, // Ice Processing
  // Modules & items
  { id: 'skill-scrapmetal',    skillId: 12196 }, // Scrapmetal Processing
  // Moon Ores
  { id: 'skill-moon-ubiquitous', skillId: 46152 }, // Ubiquitous Moon Ore Processing
  { id: 'skill-moon-common',     skillId: 46153 }, // Common Moon Ore Processing
  { id: 'skill-moon-uncommon',   skillId: 46154 }, // Uncommon Moon Ore Processing
  { id: 'skill-moon-rare',       skillId: 46155 }, // Rare Moon Ore Processing
  { id: 'skill-moon-exceptional',skillId: 46156 }, // Exceptional Moon Ore Processing
];

// ============================================================
// Init
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Wire close button
  document.getElementById('close-btn').addEventListener('click', () => window.close());

  // Load configured regions
  await loadRegions();

  // Restore saved locations from localStorage
  restoreSavedLocations();

  // Wire region change events
  document.getElementById('market1-region').addEventListener('change', () => {
    updateHubDropdown(1);
    checkMarketDataAge();
    saveLocations();
  });
  document.getElementById('market2-region').addEventListener('change', () => {
    updateHubDropdown(2);
    checkMarketDataAge();
    saveLocations();
  });
  document.getElementById('market1-hub').addEventListener('change', saveLocations);
  document.getElementById('market2-hub').addEventListener('change', saveLocations);

  // Restore saved reprocessing config before wiring change events
  restoreReprocessingConfig();
  restoreOreSkills();

  // Wire station-type change
  document.getElementById('station-type').addEventListener('change', onStationTypeChange);

  // Wire reprocessing config change → save
  // (station-type is handled by onStationTypeChange which calls saveReprocessingConfig itself)
  const reprConfigIds = [
    'rig-1', 'rig-2',
    'skill-reprocessing', 'skill-reprocessing-eff', 'implant-bonus',
  ];
  for (const id of reprConfigIds) {
    document.getElementById(id).addEventListener('change', saveReprocessingConfig);
  }

  // Wire ore skills modal
  document.getElementById('ore-skills-btn').addEventListener('click', openOreSkillsModal);
  document.getElementById('ore-skills-modal-close').addEventListener('click', closeOreSkillsModal);
  document.getElementById('ore-skills-save-btn').addEventListener('click', () => { saveOreSkills(); closeOreSkillsModal(); });
  document.getElementById('ore-skills-set-all-btn').addEventListener('click', () => setAllOreSkills(5));
  document.getElementById('ore-skills-clear-btn').addEventListener('click', () => setAllOreSkills(0));
  document.getElementById('ore-skills-character-select').addEventListener('change', onCharacterSelectChange);
  document.getElementById('ore-skills-load-char-btn').addEventListener('click', loadSkillsFromCharacter);
  document.getElementById('ore-skills-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeOreSkillsModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOreSkillsModal();
  });

  // Wire analyze button
  document.getElementById('analyze-btn').addEventListener('click', handleAnalyze);

  // Wire column sort
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (sortColumn === col) {
        sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        sortColumn = col;
        sortDir = 'desc';
      }
      updateSortHeaders();
      if (currentItems.length > 0) renderTable();
    });
  });
});

// ============================================================
// Region loading
// ============================================================
async function loadRegions() {
  try {
    regionDashboard = await window.electronAPI.market.getRegionDashboard();
  } catch (e) {
    console.error('[LootAnalyzer] Failed to load region dashboard:', e);
    regionDashboard = [];
  }

  if (!regionDashboard || regionDashboard.length === 0) {
    document.getElementById('no-regions-state').classList.remove('hidden');
    document.getElementById('analyze-btn').disabled = true;
    return;
  }

  populateRegionDropdown('market1-region', false);
  populateRegionDropdown('market2-region', true);
}

function populateRegionDropdown(selectId, includeNone) {
  const select = document.getElementById(selectId);
  // Keep the first option (placeholder / "None")
  while (select.options.length > 1) select.remove(1);

  for (const region of regionDashboard) {
    const opt = document.createElement('option');
    opt.value = region.regionId;
    opt.textContent = region.regionName;
    select.appendChild(opt);
  }
}

// ============================================================
// Hub dropdown management
// ============================================================
function updateHubDropdown(slot) {
  const regionSel = document.getElementById(`market${slot}-region`);
  const hubSel    = document.getElementById(`market${slot}-hub`);
  const regionId  = parseInt(regionSel.value, 10);
  const hub       = HUB_REGIONS[regionId];

  if (hub && regionSel.value) {
    // Populate hub dropdown
    hubSel.innerHTML = '';
    const entireOpt = document.createElement('option');
    entireOpt.value = '';
    entireOpt.textContent = 'Entire Region';
    hubSel.appendChild(entireOpt);
    const hubOpt = document.createElement('option');
    hubOpt.value = hub.stationId;
    hubOpt.textContent = hub.name;
    hubSel.appendChild(hubOpt);
    // Auto-select the hub by default
    hubSel.value = hub.stationId;
    hubSel.classList.remove('hidden');
  } else {
    hubSel.classList.add('hidden');
    hubSel.value = '';
  }
}

// ============================================================
// Location persistence (localStorage)
// ============================================================
function saveLocations() {
  const m1 = getLocationForSlot(1);
  const m2 = getLocationForSlot(2);
  localStorage.setItem('lootAnalyzer_m1', JSON.stringify(m1));
  localStorage.setItem('lootAnalyzer_m2', JSON.stringify(m2));
}

function restoreSavedLocations() {
  const m1 = tryParseJSON(localStorage.getItem('lootAnalyzer_m1'));
  const m2 = tryParseJSON(localStorage.getItem('lootAnalyzer_m2'));

  if (m1 && m1.regionId) {
    const sel = document.getElementById('market1-region');
    if ([...sel.options].some(o => parseInt(o.value) === m1.regionId)) {
      sel.value = m1.regionId;
      updateHubDropdown(1);
      const hubSel = document.getElementById('market1-hub');
      if (m1.locationId && hubSel) hubSel.value = m1.locationId;
    }
  }
  if (m2 && m2.regionId) {
    const sel = document.getElementById('market2-region');
    if ([...sel.options].some(o => parseInt(o.value) === m2.regionId)) {
      sel.value = m2.regionId;
      updateHubDropdown(2);
      const hubSel = document.getElementById('market2-hub');
      if (m2.locationId && hubSel) hubSel.value = m2.locationId;
    }
  }

  checkMarketDataAge();
}

function getLocationForSlot(slot) {
  const regionSel = document.getElementById(`market${slot}-region`);
  const hubSel    = document.getElementById(`market${slot}-hub`);
  const regionId  = parseInt(regionSel.value, 10) || null;
  if (!regionId) return null;
  const hubVisible = hubSel && !hubSel.classList.contains('hidden');
  const locationId = hubVisible && hubSel.value ? parseInt(hubSel.value, 10) : null;
  return { regionId, locationId };
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ============================================================
// Market data age check
// ============================================================
function checkMarketDataAge() {
  const warning = document.getElementById('market-data-warning');
  const warningText = document.getElementById('market-data-warning-text');

  const m1 = getLocationForSlot(1);
  const m2 = getLocationForSlot(2);
  const selectedRegionIds = [m1?.regionId, m2?.regionId].filter(Boolean);

  if (selectedRegionIds.length === 0) {
    warning.classList.add('hidden');
    warning.classList.remove('critical');
    return;
  }

  const now = Date.now();
  let worstAgeMs = 0;
  const staleRegionNames = [];
  let isCritical = false;

  for (const regionId of selectedRegionIds) {
    const region = regionDashboard.find(r => r.regionId === regionId);
    if (!region || !region.lastFetch) {
      staleRegionNames.push(region ? region.regionName : `Region ${regionId}`);
      isCritical = true;
      worstAgeMs = Infinity;
      continue;
    }
    const ageMs = now - region.lastFetch;
    if (ageMs > STALE_WARN_MS) {
      staleRegionNames.push(region.regionName);
      if (ageMs > worstAgeMs) worstAgeMs = ageMs;
      if (ageMs > STALE_CRIT_MS) isCritical = true;
    }
  }

  if (staleRegionNames.length === 0) {
    warning.classList.add('hidden');
    warning.classList.remove('critical');
    return;
  }

  warning.classList.remove('hidden');
  if (isCritical) {
    warning.classList.add('critical');
    if (worstAgeMs === Infinity) {
      warningText.textContent = `No market data for: ${staleRegionNames.join(', ')}`;
    } else {
      const hours = Math.floor(worstAgeMs / 3600000);
      warningText.textContent = `Market data is ${hours}+ hours old for: ${staleRegionNames.join(', ')}`;
    }
  } else {
    warning.classList.remove('critical');
    const hours = Math.floor(worstAgeMs / 3600000);
    const mins  = Math.floor((worstAgeMs % 3600000) / 60000);
    warningText.textContent = `Market data is ${hours}h ${mins}m old for: ${staleRegionNames.join(', ')}`;
  }
}

// ============================================================
// Station type change
// ============================================================
function onStationTypeChange() {
  const stationType = document.getElementById('station-type').value;
  const rig2Group   = document.getElementById('rig-2-group');

  // Show/hide second rig slot (Tatara only)
  if (stationType === 'tatara') {
    rig2Group.style.display = '';
  } else {
    rig2Group.style.display = 'none';
    document.getElementById('rig-2').value = 'none';
  }

  saveReprocessingConfig();
}

// ============================================================
// Reprocessing config persistence (localStorage)
// ============================================================
const REPR_CONFIG_KEY = 'lootAnalyzer_reprConfig';

function saveReprocessingConfig() {
  const config = {
    stationType:          document.getElementById('station-type').value,
    rig1:                 document.getElementById('rig-1').value,
    rig2:                 document.getElementById('rig-2').value,
    skillReprocessing:    document.getElementById('skill-reprocessing').value,
    skillReprocessingEff: document.getElementById('skill-reprocessing-eff').value,
    implantBonus:         document.getElementById('implant-bonus').value,
  };
  localStorage.setItem(REPR_CONFIG_KEY, JSON.stringify(config));
}

function restoreReprocessingConfig() {
  const saved = tryParseJSON(localStorage.getItem(REPR_CONFIG_KEY));
  if (!saved) return;

  if (saved.stationType)                  document.getElementById('station-type').value           = saved.stationType;
  if (saved.rig1)                         document.getElementById('rig-1').value                  = saved.rig1;
  if (saved.rig2)                         document.getElementById('rig-2').value                  = saved.rig2;
  if (saved.skillReprocessing != null)    document.getElementById('skill-reprocessing').value      = saved.skillReprocessing;
  if (saved.skillReprocessingEff != null) document.getElementById('skill-reprocessing-eff').value  = saved.skillReprocessingEff;
  if (saved.implantBonus != null)         document.getElementById('implant-bonus').value           = saved.implantBonus;

  // Apply show/hide logic for rig slot 2
  const rig2Group = document.getElementById('rig-2-group');
  rig2Group.style.display = saved.stationType === 'tatara' ? '' : 'none';
}

// ============================================================
// Ore Skills Modal
// ============================================================
const ORE_SKILLS_KEY = 'lootAnalyzer_oreSkills';

async function openOreSkillsModal() {
  document.getElementById('ore-skills-modal').classList.remove('hidden');
  await populateCharacterDropdown();
}

async function populateCharacterDropdown() {
  const select = document.getElementById('ore-skills-character-select');
  // Keep first placeholder option, rebuild the rest
  while (select.options.length > 1) select.remove(1);

  try {
    const characters = await window.electronAPI.esi.getCharacters();
    for (const char of characters) {
      const opt = document.createElement('option');
      opt.value = char.characterId;
      opt.textContent = char.characterName;
      select.appendChild(opt);
    }
  } catch (e) {
    console.error('[LootAnalyzer] Failed to load characters:', e);
  }

  // Reset load button state
  document.getElementById('ore-skills-load-char-btn').disabled = !select.value;
}

function onCharacterSelectChange() {
  const select = document.getElementById('ore-skills-character-select');
  document.getElementById('ore-skills-load-char-btn').disabled = !select.value;
}

async function loadSkillsFromCharacter() {
  const select = document.getElementById('ore-skills-character-select');
  const characterId = parseInt(select.value, 10);
  if (!characterId) return;

  const btn = document.getElementById('ore-skills-load-char-btn');
  btn.disabled = true;
  btn.textContent = 'Loading...';

  try {
    const result = await window.electronAPI.loot.getCharacterSkills(characterId);

    if (!result.found) {
      alert('No skill data found for this character. Make sure skills have been fetched in the Skills window.');
      return;
    }

    // IPC JSON serialization converts integer keys to strings — helper handles both
    const skills = result.skills;
    const getSkill = (id) => skills[id] ?? skills[String(id)] ?? 0;

    // Apply ore/ice/moon/scrapmetal processing skills to modal inputs
    for (const { id, skillId } of ORE_SKILL_INPUTS) {
      document.getElementById(id).value = getSkill(skillId);
    }

    // Apply base reprocessing skills (3385, 3389) to the main config inputs
    document.getElementById('skill-reprocessing').value = getSkill(3385);
    document.getElementById('skill-reprocessing-eff').value = getSkill(3389);
    saveReprocessingConfig();

  } catch (e) {
    console.error('[LootAnalyzer] Failed to load character skills:', e);
    alert('Error loading character skills. See console for details.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg> Load Skills`;
  }
}

function closeOreSkillsModal() {
  document.getElementById('ore-skills-modal').classList.add('hidden');
}

function setAllOreSkills(level) {
  for (const { id } of ORE_SKILL_INPUTS) {
    document.getElementById(id).value = level;
  }
  if (level === 5) {
    document.getElementById('skill-reprocessing').value = 5;
    document.getElementById('skill-reprocessing-eff').value = 5;
    saveReprocessingConfig();
  }
}

function saveOreSkills() {
  const skills = {};
  for (const { id, skillId } of ORE_SKILL_INPUTS) {
    skills[skillId] = parseInt(document.getElementById(id).value, 10) || 0;
  }
  localStorage.setItem(ORE_SKILLS_KEY, JSON.stringify(skills));
}

function restoreOreSkills() {
  const saved = tryParseJSON(localStorage.getItem(ORE_SKILLS_KEY));
  if (!saved) return;
  for (const { id, skillId } of ORE_SKILL_INPUTS) {
    if (saved[skillId] != null) {
      document.getElementById(id).value = saved[skillId];
    }
  }
}

/** Returns map of skillId → level (0–5) from the modal inputs */
function getOreSkillLevels() {
  const skills = {};
  for (const { id, skillId } of ORE_SKILL_INPUTS) {
    skills[skillId] = parseInt(document.getElementById(id).value, 10) || 0;
  }
  return skills;
}

// ============================================================
// Main analysis flow
// ============================================================
async function handleAnalyze() {
  const rawText = document.getElementById('loot-input').value.trim();
  if (!rawText) return;

  const market1 = getLocationForSlot(1);
  if (!market1) {
    alert('Please select a Market 1 region.');
    return;
  }

  showLoading('Parsing items...');

  try {
    // Step 1: Parse and enrich
    const parseResult = await window.electronAPI.loot.parseAndEnrich(rawText);
    currentItems = parseResult.items || [];

    // Show unresolved banner
    const unresolvedBanner = document.getElementById('unresolved-banner');
    const unresolvedList   = document.getElementById('unresolved-list');
    const allBadLines = [
      ...(parseResult.unresolvedNames || []),
      ...(parseResult.parseErrors || []),
    ];
    if (allBadLines.length > 0) {
      unresolvedList.textContent = allBadLines.join(', ');
      unresolvedBanner.classList.remove('hidden');
    } else {
      unresolvedBanner.classList.add('hidden');
    }

    if (currentItems.length === 0) {
      hideLoading();
      return;
    }

    // Step 2: Fetch prices
    updateLoadingMessage('Fetching prices...');

    const typeIds = currentItems.map(i => i.typeId);
    const materialTypeIds = [
      ...new Set(
        currentItems.flatMap(i => (i.materials || []).map(m => m.materialTypeId))
      )
    ];

    const market2 = getLocationForSlot(2);

    const stationConfig = {
      stationType: document.getElementById('station-type').value,
      rig: document.getElementById('rig-1').value,
      rig2: document.getElementById('rig-2').value,
    };
    const baseSkills = {
      reprocessing: parseInt(document.getElementById('skill-reprocessing').value, 10) || 0,
      reprocessingEfficiency: parseInt(document.getElementById('skill-reprocessing-eff').value, 10) || 0,
    };
    const implantBonus = parseFloat(document.getElementById('implant-bonus').value) || 0;
    const oreSkillLevels = getOreSkillLevels();

    // Store config for per-item yield recalculation in renderTable
    currentReprocessingConfig = { stationConfig, baseSkills, implantBonus, oreSkillLevels };

    // Build item reprocessing data map (typeId → { portionSize, materials, typeSpecificSkillId })
    const itemReprocessingData = {};
    for (const item of currentItems) {
      if (item.canReprocess) {
        itemReprocessingData[item.typeId] = {
          portionSize: item.portionSize,
          materials: item.materials,
        };
      }
    }

    const priceResult = await window.electronAPI.loot.fetchPrices({
      typeIds,
      materialTypeIds,
      market1,
      market2,
      reprocessingConfig: { stationConfig, baseSkills, implantBonus, oreSkillLevels },
      itemReprocessingData,
      itemTypeSkills: Object.fromEntries(
        currentItems.map(i => [i.typeId, i.typeSpecificSkillId || null])
      ),
    });

    currentPrices = priceResult.items || {};
    currentMaterialPrices = priceResult.materialPrices || {};

    // Yield display: show the base yield (skills 5/5, no type skill) as a reference
    const baseYieldPct = (priceResult.baseYieldRate * 100).toFixed(1);
    document.getElementById('yield-value').textContent = `${baseYieldPct}% base`;

    hideLoading();
    document.getElementById('results-section').classList.remove('hidden');
    renderTable();

  } catch (error) {
    console.error('[LootAnalyzer] Analysis error:', error);
    hideLoading();
  }
}

// ============================================================
// Client-side yield formula (mirrors reprocessing-calculator.js)
// ============================================================
const BASE_YIELDS   = { npc: 0.50, athanor: 0.54, tatara: 0.54 };
const STATION_TAX   = { npc: 0.05, athanor: 0.00, tatara: 0.00 };
const RIG_BONUSES   = { none: 0, t1: 0.02, t2: 0.04 };
const STACKING_PENALTIES = [1.0, 0.8693, 0.5706, 0.2840, 0.1052, 0.0290];

function calcYield(stationConfig, baseSkills, typeSkillLevel, implantBonus) {
  const base = BASE_YIELDS[stationConfig.stationType] || 0.50;
  const tax  = 1 - (STATION_TAX[stationConfig.stationType] ?? 0.05);
  const skillMult = (1 + (baseSkills.reprocessing || 0) * 0.03)
                  * (1 + (baseSkills.reprocessingEfficiency || 0) * 0.02)
                  * (1 + (typeSkillLevel || 0) * 0.02);
  const implant = 1 + (implantBonus || 0);
  const r1 = RIG_BONUSES[stationConfig.rig] || 0;
  const r2 = stationConfig.stationType === 'tatara' ? (RIG_BONUSES[stationConfig.rig2] || 0) : 0;
  let rigMult = 1.0;
  if (r1 > 0) rigMult += r1 * STACKING_PENALTIES[0];
  if (r2 > 0) rigMult += r2 * STACKING_PENALTIES[1];
  return base * tax * skillMult * implant * rigMult;
}

// ============================================================
// Table rendering
// ============================================================
function renderTable() {
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = '';

  // Build sortable rows with computed values
  const rows = currentItems.map(item => {
    const prices = currentPrices[String(item.typeId)] || {};
    const qty = item.quantity;

    const m1SellTotal = (prices.m1Sell || 0) * qty;
    const m1BuyTotal  = (prices.m1Buy  || 0) * qty;
    const m2SellTotal = prices.m2Sell !== null ? prices.m2Sell * qty : null;
    const m2BuyTotal  = prices.m2Buy  !== null ? prices.m2Buy  * qty : null;

    // Reprocessing value is already unit-based from server (we passed qty=1 per-unit)
    // But server uses itemReprocessingData with qty=1 — the actual value scales with qty
    // because batchCount = floor(qty / portionSize).
    // The server returned per-unit values (quantity=1). We need to re-scale:
    //   For qty items: batches = floor(qty / portionSize)
    //   For 1 item: batches = floor(1 / portionSize) which may be 0 for portionSize > 1
    // To get correct totals, we use the raw per-unit reprocess values from server
    // and note: server actually computed for qty=1, so for items needing portionSize>1
    // the reprocess value is 0 unless qty >= portionSize.
    // We should display total reprocess value (server result already accounts for portionSize).
    // Since server called with qty=1, re-call is needed... but that's expensive.
    // Instead: server returns PER-UNIT reprocess sell/buy (based on 1 item).
    // For the total, multiply by qty. This is an approximation — see note below.
    //
    // NOTE: The correct formula is floor(floor(qty/portionSize) * matQty * yield).
    // With qty=1 and portionSize>1, reprocessSell=0. We need to show total value
    // which requires knowing the actual batch count for the real qty.
    // The renderer recalculates this using the stored item data.

    let reprocessSellTotal = 0;
    let reprocessBuyTotal  = 0;
    if (item.canReprocess && item.portionSize && item.materials && item.materials.length > 0 && currentReprocessingConfig) {
      const { stationConfig, baseSkills, implantBonus, oreSkillLevels } = currentReprocessingConfig;
      const typeSkillLevel = item.typeSpecificSkillId ? (oreSkillLevels[item.typeSpecificSkillId] || 0) : 0;
      const itemYieldRate = calcYield(stationConfig, baseSkills, typeSkillLevel, implantBonus);

      const batchCount = Math.floor(qty / item.portionSize);
      if (batchCount > 0) {
        for (const mat of item.materials) {
          const matPrices = currentMaterialPrices[String(mat.materialTypeId)] || currentMaterialPrices[mat.materialTypeId];
          if (!matPrices) continue;
          const yieldedQty = Math.floor(batchCount * mat.quantity * itemYieldRate);
          reprocessSellTotal += yieldedQty * (matPrices.m1Sell || 0);
          reprocessBuyTotal  += yieldedQty * (matPrices.m1Buy  || 0);
        }
      }
    }

    // Best total value
    const actionValues = {
      'sell-m1':   m1SellTotal,
      'sell-m2':   m2SellTotal !== null ? m2SellTotal : -Infinity,
      'reprocess': item.canReprocess ? reprocessSellTotal : -Infinity,
    };
    let bestAction = 'unknown';
    let totalBest  = 0;
    for (const [action, val] of Object.entries(actionValues)) {
      if (val > totalBest) {
        totalBest  = val;
        bestAction = action;
      }
    }

    return {
      item,
      qty,
      m1SellTotal,
      m1BuyTotal,
      m2SellTotal,
      m2BuyTotal,
      reprocessSellTotal,
      reprocessBuyTotal,
      totalBest,
      bestAction,
      svr: prices.svr ?? null,
      m1SellVsM2SellPct: prices.m1SellVsM2SellPct ?? null,
      m1BuyVsM2BuyPct:   prices.m1BuyVsM2BuyPct ?? null,
      m1Spread:          prices.m1Spread ?? null,
      m2Spread:          prices.m2Spread ?? null,
    };
  });

  // Sort
  rows.sort((a, b) => {
    const av = getSortValue(a);
    const bv = getSortValue(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'string') {
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  // Render rows
  for (const row of rows) {
    const tr = document.createElement('tr');

    const hasMkt2 = row.m2SellTotal !== null;

    tr.innerHTML = `
      <td class="col-name">${escapeHtml(row.item.typeName)}</td>
      <td>${formatQty(row.qty)}</td>
      <td>${row.item.canReprocess && row.reprocessSellTotal > 0 ? formatISK(row.reprocessSellTotal) : '<span class="muted">—</span>'}</td>
      <td>${row.item.canReprocess && row.reprocessBuyTotal > 0 ? formatISK(row.reprocessBuyTotal) : '<span class="muted">—</span>'}</td>
      <td>${row.m1SellTotal > 0 ? formatISK(row.m1SellTotal) : '<span class="muted">—</span>'}</td>
      <td>${row.m1BuyTotal > 0 ? formatISK(row.m1BuyTotal) : '<span class="muted">—</span>'}</td>
      <td>${hasMkt2 && row.m2SellTotal > 0 ? formatISK(row.m2SellTotal) : '<span class="muted">—</span>'}</td>
      <td>${hasMkt2 && row.m2BuyTotal > 0 ? formatISK(row.m2BuyTotal) : '<span class="muted">—</span>'}</td>
      <td>${formatPct(row.m1SellVsM2SellPct)}</td>
      <td>${formatPct(row.m1BuyVsM2BuyPct)}</td>
      <td>${formatPct(row.m1Spread)}</td>
      <td>${formatPct(row.m2Spread)}</td>
      <td>${formatSVR(row.svr)}</td>
      <td>${formatBestAction(row.bestAction)}</td>
      <td class="col-total">${row.totalBest > 0 ? formatISK(row.totalBest) : '<span class="muted">—</span>'}</td>
    `;

    tbody.appendChild(tr);
  }
}

function getSortValue(row) {
  switch (sortColumn) {
    case 'name':              return row.item.typeName.toLowerCase();
    case 'quantity':          return row.qty;
    case 'reprocessSell':     return row.reprocessSellTotal;
    case 'reprocessBuy':      return row.reprocessBuyTotal;
    case 'm1Sell':            return row.m1SellTotal;
    case 'm1Buy':             return row.m1BuyTotal;
    case 'm2Sell':            return row.m2SellTotal;
    case 'm2Buy':             return row.m2BuyTotal;
    case 'm1SellVsM2SellPct': return row.m1SellVsM2SellPct;
    case 'm1BuyVsM2BuyPct':   return row.m1BuyVsM2BuyPct;
    case 'm1Spread':          return row.m1Spread;
    case 'm2Spread':          return row.m2Spread;
    case 'svr':               return row.svr;
    case 'bestAction':        return row.bestAction;
    case 'totalBest':         return row.totalBest;
    default:                  return row.totalBest;
  }
}

function updateSortHeaders() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('active');
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = '↕';
  });
  const activeTh = document.querySelector(`th[data-sort="${sortColumn}"]`);
  if (activeTh) {
    activeTh.classList.add('active');
    const icon = activeTh.querySelector('.sort-icon');
    if (icon) icon.textContent = sortDir === 'desc' ? '↓' : '↑';
  }
}

// ============================================================
// Formatters
// ============================================================
function formatISK(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(2)  + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(2)  + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(1)  + 'K';
  return n.toFixed(0);
}

function formatQty(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString();
}

function formatPct(val) {
  if (val === null || val === undefined || isNaN(val)) {
    return '<span class="muted">—</span>';
  }
  const sign = val > 0 ? '+' : '';
  const cls  = val > 0 ? 'pct-positive' : val < 0 ? 'pct-negative' : 'pct-neutral';
  return `<span class="${cls}">${sign}${val.toFixed(1)}%</span>`;
}

function formatSVR(svr) {
  if (svr === null || svr === undefined) {
    return '<span class="svr-badge unknown">N/A</span>';
  }
  let cls, label;
  if (svr >= 100) {
    cls = 'high'; label = `${formatQty(svr)}/d`;
  } else if (svr >= 10) {
    cls = 'medium'; label = `${formatQty(svr)}/d`;
  } else {
    cls = 'low'; label = `${formatQty(svr)}/d`;
  }
  return `<span class="svr-badge ${cls}" title="7-day avg daily volume">${label}</span>`;
}

function formatBestAction(action) {
  const labels = {
    'reprocess': 'Reprocess',
    'sell-m1':   'Sell M1',
    'sell-m2':   'Sell M2',
    'unknown':   '—',
  };
  const cls = action || 'unknown';
  return `<span class="action-pill ${cls}">${labels[action] || '—'}</span>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// Loading overlay helpers
// ============================================================
function showLoading(msg) {
  document.getElementById('loading-message').textContent = msg || 'Loading...';
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function updateLoadingMessage(msg) {
  document.getElementById('loading-message').textContent = msg;
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}
