/**
 * Loot Analyzer view.
 *
 * Ported from `loot-analyzer-renderer.js`. Presentation follows
 * `Loot Analyzer (1a).dc.html`; BEHAVIOUR follows the un-ported screen, which
 * wins wherever the two disagree:
 *
 *   - all 15 columns sort (the mockup allows only 6)
 *   - SVR is a per-market PAIR (m1Svr/m2Svr), not one value
 *   - the best-action rule, including its -Infinity sentinels and the
 *     Minimum SVR gate that yields 'unknown' rather than falling back to
 *     reprocess, is carried over verbatim
 *   - the yield formula and its four constant tables are verbatim
 *
 * Changed deliberately during the port:
 *   - settings move from localStorage into quantum_config.json (migrated once)
 *   - the market-age warning uses the shared QFFreshness badge, which RE-READS
 *     the region dashboard on every market event. The old screen cached the
 *     dashboard once at load, so its warning could never clear.
 *   - alert() and the silent catch become toasts
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- config

  /** Trade hubs offered as a sub-selection when their region is picked. */
  const HUB_REGIONS = {
    10000002: { name: 'Jita IV - Moon 4', stationId: 60003760 },
    10000043: { name: 'Amarr VIII - Oris', stationId: 60008494 },
    10000032: { name: 'Dodixie IX - Moon 20', stationId: 60011866 },
    10000030: { name: 'Rens VI - Moon 8', stationId: 60004588 },
    10000042: { name: 'Hek VIII - Moon 12', stationId: 60005686 },
  };

  /*
   * Yield constants, verbatim from the un-ported screen (which mirrors
   * reprocessing-calculator.js). Rig 2 applies to Tatara ONLY, and the second
   * rig is subject to the stacking penalty - see calcYield.
   */
  const BASE_YIELDS = { npc: 0.50, athanor: 0.54, tatara: 0.54 };
  const STATION_TAX = { npc: 0.05, athanor: 0.00, tatara: 0.00 };
  const RIG_BONUSES = { none: 0, t1: 0.02, t2: 0.04 };
  const STACKING_PENALTIES = [1.0, 0.8693, 0.5706, 0.2840, 0.1052, 0.0290];

  /** Ore processing skills: input id -> SDE skill typeId. */
  const ORE_SKILLS = [
    { id: 'skill-simple-ore', skillId: 60377 },
    { id: 'skill-coherent-ore', skillId: 60378 },
    { id: 'skill-variegated-ore', skillId: 60379 },
    { id: 'skill-complex-ore', skillId: 60380 },
    { id: 'skill-abyssal-ore', skillId: 60381 },
    { id: 'skill-erratic-ore', skillId: 90040 },
    { id: 'skill-mercoxit-ore', skillId: 12189 },
    { id: 'skill-ice', skillId: 18025 },
    { id: 'skill-scrapmetal', skillId: 12196 },
    { id: 'skill-moon-ubiquitous', skillId: 46152 },
    { id: 'skill-moon-common', skillId: 46153 },
    { id: 'skill-moon-uncommon', skillId: 46154 },
    { id: 'skill-moon-rare', skillId: 46155 },
    { id: 'skill-moon-exceptional', skillId: 46156 },
  ];

  /** LEGACY localStorage keys - read once, then deleted. Nothing writes them. */
  const LEGACY_KEYS = {
    m1: 'lootAnalyzer_m1',
    m2: 'lootAnalyzer_m2',
    minSvr: 'lootAnalyzer_minSvr',
    repr: 'lootAnalyzer_reprConfig',
    ore: 'lootAnalyzer_oreSkills',
  };

  // ----------------------------------------------------------------- state

  const state = {
    regions: [],
    dashboard: [],
    items: [],
    prices: {},
    materialPrices: {},
    reprocessingConfig: null,
    sortColumn: 'totalBest',
    sortDirection: 'desc',
    analyzing: false,
  };

  let els = {};
  let freshnessDispose = null;
  /** Set by selectedMarketsTimestamp - see the note there. */
  let noMarketSelected = true;

  // ------------------------------------------------------------- utilities

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function toast(message, type) {
    if (window.QFToast && typeof window.QFToast.show === 'function') {
      window.QFToast.show(message, type || 'info');
    } else {
      console.log(`[loot] ${type || 'info'}: ${message}`);
    }
  }

  function fmtISK(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toFixed(0);
  }

  /** Unabbreviated value for the hover title. */
  function fullISK(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '';
    return `${Math.round(n).toLocaleString()} ISK`;
  }

  function fmtQty(n) {
    if (n === null || n === undefined) return '—';
    return n.toLocaleString();
  }

  function svrClass(svr) {
    if (svr === null || svr === undefined) return 'is-unknown';
    if (svr >= 100) return 'is-high';
    if (svr >= 10) return 'is-medium';
    return 'is-low';
  }

  // --------------------------------------------------------- persistence

  /**
   * Read the legacy localStorage values once and clear them.
   *
   * Returns whatever was found so the caller can adopt it. Reads defensively:
   * a corrupt value must not stop the screen loading.
   */
  function readLegacy() {
    const out = {};
    Object.entries(LEGACY_KEYS).forEach(([name, key]) => {
      try {
        const raw = localStorage.getItem(key);
        if (raw !== null) out[name] = JSON.parse(raw);
        localStorage.removeItem(key);
      } catch (error) {
        console.error(`[loot] could not migrate ${key}:`, error);
      }
    });
    return out;
  }

  async function loadSettings() {
    const legacy = readLegacy();
    let stored = {};

    try {
      const [market1, market2, minSvr, reprocessing, oreSkills] = await Promise.all([
        window.electronAPI.settings.get('lootAnalyzer', 'market1'),
        window.electronAPI.settings.get('lootAnalyzer', 'market2'),
        window.electronAPI.settings.get('lootAnalyzer', 'minSvr'),
        window.electronAPI.settings.get('lootAnalyzer', 'reprocessing'),
        window.electronAPI.settings.get('lootAnalyzer', 'oreSkills'),
      ]);
      stored = { market1, market2, minSvr, reprocessing, oreSkills };
    } catch (error) {
      console.error('[loot] could not load settings:', error);
    }

    // A stored value wins; legacy only fills in where nothing is stored yet.
    // Both shapes are NORMALISED on the way in - see the two helpers below.
    const rawRepr = Object.keys(stored.reprocessing || {}).length > 0
      ? stored.reprocessing
      : legacy.repr;
    const rawOre = (stored.oreSkills && Object.keys(stored.oreSkills).length > 0)
      ? stored.oreSkills
      : legacy.ore;

    const migrated = {
      market1: stored.market1 || legacy.m1 || null,
      market2: stored.market2 || legacy.m2 || null,
      minSvr: stored.minSvr != null ? Number(stored.minSvr) : (Number(legacy.minSvr) || 0),
      reprocessing: normaliseReprocessing(rawRepr),
      oreSkills: normaliseOreSkills(rawOre),
    };

    /*
     * Write back only when something actually needed normalising.
     *
     * Two cases qualify. First, a genuine migration: readLegacy() DELETES the
     * localStorage keys as it reads them, so that can only happen once, on
     * the first launch after the port. Second, a stored config still in the
     * legacy shape - the first version of this migration copied the old keys
     * through verbatim, so `rig1`/`skillReprocessing` can still be sitting in
     * settings; normalising those is also a one-off repair.
     *
     * Once neither is true this is a no-op forever, rather than rewriting the
     * same values on every single mount.
     */
    const migratedFromLocalStorage = Object.keys(legacy).length > 0;
    const storedNeedsNormalising = !!(rawRepr && (
      rawRepr.rig1 !== undefined
      || rawRepr.skillReprocessing !== undefined
      || rawRepr.skillReprocessingEff !== undefined
    ));
    const oreKeyedBySkillId = !!(rawOre && Object.keys(rawOre).some((k) => /^\d+$/.test(k)));

    if (migratedFromLocalStorage || storedNeedsNormalising || oreKeyedBySkillId) {
      await saveSettings(migrated);
    }

    return migrated;
  }

  /**
   * Accept either shape of the reprocessing block.
   *
   * The un-ported screen wrote `rig1` / `skillReprocessing` /
   * `skillReprocessingEff` (the last two as STRINGS); this screen uses
   * `rig` / `reprocessing` / `reprocessingEfficiency` as numbers. An early
   * version of this migration merged the old keys through untouched, so a
   * stored config can carry either - or a hybrid of both.
   */
  function normaliseReprocessing(raw) {
    const r = raw || {};

    /*
     * Take the HIGHEST of the two keyings rather than the first present one.
     *
     * A config can carry both: the first version of this migration wrote
     * new-shape defaults (0 / 'none') alongside the legacy keys it copied
     * through untouched. Preferring the new key would then discard the user's
     * real 5/5 skills in favour of zeros nobody chose. Levels only ever move
     * up by training, so the larger value is the true one.
     */
    const level = (...candidates) => {
      let best = 0;
      candidates.forEach((v) => {
        if (v === undefined || v === null || v === '') return;
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) best = Math.max(best, Math.min(5, n));
      });
      return Math.max(0, best);
    };

    // Same reasoning for the rig: 'none' is the default, so a real rig on
    // either key wins over it.
    const rig = (...candidates) => {
      for (const v of candidates) {
        if (v && v !== 'none') return v;
      }
      return 'none';
    };

    return {
      stationType: r.stationType || 'npc',
      rig: rig(r.rig, r.rig1),
      rig2: rig(r.rig2),
      reprocessing: level(r.reprocessing, r.skillReprocessing),
      reprocessingEfficiency: level(r.reprocessingEfficiency, r.skillReprocessingEff),
      implantBonus: parseFloat(r.implantBonus) || 0,
    };
  }

  /**
   * Normalise ore skills to ELEMENT ids.
   *
   * The un-ported screen keyed these by SDE skill id (12189, 60377, ...).
   * Restoring that shape did `querySelector('#12189')`, and a CSS identifier
   * may not start with a digit - so querySelector THREW, aborting mount()
   * before a single listener was attached and leaving every control on the
   * screen dead. Accept both keyings and always hand back element ids.
   */
  function normaliseOreSkills(raw) {
    const source = raw || {};
    const out = {};

    ORE_SKILLS.forEach(({ id, skillId }) => {
      const value = source[id] !== undefined ? source[id] : source[skillId];
      if (value === undefined || value === null) return;
      const n = parseInt(value, 10);
      if (!Number.isNaN(n)) out[id] = Math.max(0, Math.min(5, n));
    });

    return out;
  }

  /**
   * Persist the whole block.
   *
   * settings:update merges only ONE level deep, so every field this screen
   * owns has to be written every time - an omitted key is destroyed.
   */
  async function saveSettings(partial) {
    const payload = partial || {
      market1: locationForSlot(1),
      market2: locationForSlot(2),
      minSvr: minSvr(),
      reprocessing: {
        stationType: els.stationType.value,
        rig: els.rig1.value,
        rig2: els.rig2.value,
        reprocessing: intValue(els.skillReprocessing),
        reprocessingEfficiency: intValue(els.skillReprocessingEff),
        implantBonus: parseFloat(els.implantBonus.value) || 0,
      },
      oreSkills: oreSkillInputs(),
    };

    try {
      await window.electronAPI.settings.update('lootAnalyzer', payload);
    } catch (error) {
      console.error('[loot] could not save settings:', error);
    }
  }

  function intValue(input) {
    const v = parseInt(input.value, 10);
    return Number.isNaN(v) ? 0 : Math.max(0, Math.min(5, v));
  }

  /** element id -> level, for every ore skill input. */
  function oreSkillInputs() {
    const out = {};
    ORE_SKILLS.forEach(({ id }) => {
      const input = document.getElementById(id);
      if (input) out[id] = intValue(input);
    });
    return out;
  }

  /** SDE skillId -> level, which is what the pricing call expects. */
  function oreSkillLevels() {
    const out = {};
    ORE_SKILLS.forEach(({ id, skillId }) => {
      const input = document.getElementById(id);
      if (input) out[skillId] = intValue(input);
    });
    return out;
  }

  // ------------------------------------------------------------- locations

  async function loadRegions() {
    try {
      state.dashboard = await window.electronAPI.market.getRegionDashboard() || [];
    } catch (error) {
      console.error('[loot] could not load the region dashboard:', error);
      state.dashboard = [];
    }

    state.regions = state.dashboard
      .map((r) => ({ regionId: r.regionId, regionName: r.regionName }))
      .sort((a, b) => a.regionName.localeCompare(b.regionName));

    // Nothing to analyse against without at least one configured region.
    const none = state.regions.length === 0;
    els.noRegions.hidden = !none;

    fillRegions(els.market1Region, '— Select Region —');
    fillRegions(els.market2Region, '— None —');
  }

  function fillRegions(select, placeholder) {
    const options = [el('option', null, placeholder)];
    options[0].value = '';
    state.regions.forEach((r) => {
      const option = el('option', null, r.regionName);
      option.value = String(r.regionId);
      options.push(option);
    });
    select.replaceChildren(...options);
  }

  /**
   * Show the trade-hub sub-selection for hub regions.
   *
   * The hub select is toggled with the `hidden` ATTRIBUTE here, not a class -
   * which is why locationForSlot below tests `.hidden` rather than
   * classList. The un-ported screen used a `.hidden` class and would silently
   * report no hub if that were carried over unchanged.
   */
  function updateHub(slot) {
    const regionSelect = slot === 1 ? els.market1Region : els.market2Region;
    const hubSelect = slot === 1 ? els.market1Hub : els.market2Hub;
    const regionId = parseInt(regionSelect.value, 10);
    const hub = HUB_REGIONS[regionId];

    if (hub && regionSelect.value) {
      const entire = el('option', null, 'Entire Region');
      entire.value = '';
      const hubOption = el('option', null, hub.name);
      hubOption.value = String(hub.stationId);
      hubSelect.replaceChildren(entire, hubOption);
      // Default to the hub itself - region-wide prices are rarely what the
      // user wants when a hub exists.
      hubSelect.value = String(hub.stationId);
      hubSelect.hidden = false;
    } else {
      hubSelect.replaceChildren();
      hubSelect.value = '';
      hubSelect.hidden = true;
    }
  }

  function locationForSlot(slot) {
    const regionSelect = slot === 1 ? els.market1Region : els.market2Region;
    const hubSelect = slot === 1 ? els.market1Hub : els.market2Hub;
    const regionId = parseInt(regionSelect.value, 10) || null;
    if (!regionId) return null;

    const locationId = (!hubSelect.hidden && hubSelect.value)
      ? parseInt(hubSelect.value, 10)
      : null;
    return { regionId, locationId };
  }

  function minSvr() {
    const v = parseFloat(els.minSvr.value);
    return Number.isNaN(v) || v < 0 ? 0 : v;
  }

  // ------------------------------------------------------------- freshness

  /**
   * Worst freshness across the selected markets.
   *
   * Re-reads the dashboard from main every time rather than closing over a
   * cached copy - that cache is precisely why the un-ported warning never
   * cleared after a refresh.
   */
  async function selectedMarketsTimestamp() {
    const wanted = [locationForSlot(1), locationForSlot(2)]
      .filter(Boolean)
      .map((m) => m.regionId);

    // "Nothing selected" is NOT a staleness problem, but getFreshness() maps
    // both null and undefined to level:'none' - the same value it uses for a
    // region that exists but was never fetched. Flag it separately so the
    // badge can stay hidden instead of claiming there is no market data.
    if (wanted.length === 0) {
      noMarketSelected = true;
      return null;
    }
    noMarketSelected = false;

    let dashboard = [];
    try {
      dashboard = await window.electronAPI.market.getRegionDashboard() || [];
    } catch (error) {
      console.error('[loot] could not re-read the region dashboard:', error);
      return null;
    }
    state.dashboard = dashboard;

    let oldest = null;
    for (const regionId of wanted) {
      const region = dashboard.find((r) => r.regionId === regionId);
      // A region with no data at all is worse than any age - report it as
      // "never" so the badge says so rather than showing a stale duration.
      if (!region || !region.lastFetch) return null;
      if (oldest === null || region.lastFetch < oldest) oldest = region.lastFetch;
    }
    return oldest;
  }

  function renderFreshness(freshness) {
    if (!els.warning) return;

    if (noMarketSelected || !freshness || freshness.level === 'fresh') {
      els.warning.hidden = true;
      els.warning.classList.remove('is-stale');
      return;
    }

    const names = selectedRegionNames();
    els.warning.hidden = false;
    els.warning.classList.toggle('is-stale', freshness.level === 'stale' || freshness.level === 'none');

    els.warningText.textContent = freshness.level === 'none'
      ? `No market data for ${names || 'the selected market'}`
      : `Market data for ${names || 'the selected market'} is ${freshness.label} old — prices may be stale.`;
  }

  function selectedRegionNames() {
    const ids = [locationForSlot(1), locationForSlot(2)].filter(Boolean).map((m) => m.regionId);
    const names = ids
      .map((id) => {
        const region = state.regions.find((r) => r.regionId === id);
        return region ? region.regionName : `Region ${id}`;
      })
      .filter(Boolean);
    return [...new Set(names)].join(', ');
  }

  function refreshFreshness() {
    if (!window.QFFreshness) return;
    if (freshnessDispose) freshnessDispose();
    freshnessDispose = window.QFFreshness.subscribe(
      selectedMarketsTimestamp,
      renderFreshness,
      { market: true, cycle: true }
    );
  }

  // ------------------------------------------------------------------ yield

  /**
   * Effective reprocessing yield. Verbatim from the un-ported screen.
   *
   * The second rig only exists on a Tatara, and takes the first stacking
   * penalty (0.8693) rather than applying at full strength.
   */
  function calcYield(stationConfig, baseSkills, typeSkillLevel, implantBonus) {
    const base = BASE_YIELDS[stationConfig.stationType] || 0.50;
    const tax = 1 - (STATION_TAX[stationConfig.stationType] ?? 0.05);
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

  /**
   * Live effective-yield readout in the config header.
   *
   * The un-ported screen only filled this in after an analysis, so the panel
   * sat blank while the user tuned the very inputs that drive it. Computed
   * locally with calcYield - no round trip, so it can update on every edit.
   *
   * Shown WITHOUT a type-specific ore skill, matching what the analysis
   * reports as the base rate; per-item yield still folds in that skill.
   */
  function renderYield() {
    if (!els.yieldValue) return;

    const rate = calcYield(
      {
        stationType: els.stationType.value,
        rig: els.rig1.value,
        rig2: els.rig2.value,
      },
      {
        reprocessing: intValue(els.skillReprocessing),
        reprocessingEfficiency: intValue(els.skillReprocessingEff),
      },
      0,
      parseFloat(els.implantBonus.value) || 0
    );

    setYieldText(`${(rate * 100).toFixed(1)}%`);
  }

  /**
   * The yield appears twice - in the config header and in the results summary
   * bar - and the mockup shows the same value in both. Writing only one leaves
   * the other stale.
   */
  function setYieldText(text) {
    if (els.yieldValue) els.yieldValue.textContent = text;
    if (els.yieldValueResults) els.yieldValueResults.textContent = text;
  }

  function onStationTypeChange() {
    // Only a Tatara has a second rig slot. Leaving Tatara CLEARS that slot -
    // otherwise a hidden rig stays in the saved config and keeps inflating
    // the yield with no visible control explaining why.
    const isTatara = els.stationType.value === 'tatara';
    els.rig2Group.hidden = !isTatara;
    if (!isTatara) els.rig2.value = 'none';
    saveSettings();
    renderYield();
  }

  // ---------------------------------------------------------------- rows

  /**
   * Build one result row.
   *
   * The best-action rule is carried over verbatim. Two parts of it are easy
   * to get wrong and are load-bearing:
   *
   *   - reprocess must beat BOTH sell markets outright, compared with
   *     -Infinity sentinels so an unavailable option never wins by default
   *   - the sell choice is gated by Minimum SVR. If neither market clears the
   *     gate the answer is 'unknown' - it does NOT fall back to reprocess.
   */
  function buildRow(item) {
    const prices = state.prices[String(item.typeId)] || {};
    const qty = item.quantity;

    const m1SellTotal = (prices.m1Sell || 0) * qty;
    const m1BuyTotal = (prices.m1Buy || 0) * qty;
    const hasM2 = prices.m2Sell !== undefined && prices.m2Sell !== null;
    const m2SellTotal = hasM2 ? (prices.m2Sell || 0) * qty : null;
    const m2BuyTotal = hasM2 ? (prices.m2Buy || 0) * qty : null;

    let reprocessSellTotal = 0;
    let reprocessBuyTotal = 0;

    if (item.canReprocess && item.portionSize && item.materials
      && item.materials.length > 0 && state.reprocessingConfig) {
      const { stationConfig, baseSkills, implantBonus, oreSkills } = state.reprocessingConfig;
      const typeSkillLevel = item.typeSpecificSkillId
        ? (oreSkills[item.typeSpecificSkillId] || 0)
        : 0;
      const itemYield = calcYield(stationConfig, baseSkills, typeSkillLevel, implantBonus);

      // Reprocessing runs in whole batches - a partial batch yields nothing.
      const batchCount = Math.floor(qty / item.portionSize);
      if (batchCount > 0) {
        for (const mat of item.materials) {
          const matPrices = state.materialPrices[String(mat.materialTypeId)]
            || state.materialPrices[mat.materialTypeId];
          if (!matPrices) continue;
          const yielded = Math.floor(batchCount * mat.quantity * itemYield);
          reprocessSellTotal += yielded * (matPrices.m1Sell || 0);
          reprocessBuyTotal += yielded * (matPrices.m1Buy || 0);
        }
      }
    }

    const reprocessValue = item.canReprocess ? reprocessSellTotal : -Infinity;
    const m2ValueOrNeg = m2SellTotal !== null ? m2SellTotal : -Infinity;

    let bestAction = 'unknown';
    let totalBest = 0;

    if (reprocessValue > m1SellTotal && reprocessValue > m2ValueOrNeg && reprocessValue > 0) {
      bestAction = 'reprocess';
      totalBest = reprocessValue;
    } else {
      const gate = minSvr();
      const m1Ok = m1SellTotal > 0 && (prices.m1Svr ?? 0) >= gate;
      const m2Ok = m2SellTotal !== null && m2SellTotal > 0 && (prices.m2Svr ?? 0) >= gate;

      if (!m1Ok && !m2Ok) {
        bestAction = 'unknown';
        totalBest = 0;
      } else if (m1Ok && (!m2Ok || m1SellTotal >= m2SellTotal)) {
        bestAction = 'sell-m1';
        totalBest = m1SellTotal;
      } else if (m2Ok) {
        bestAction = 'sell-m2';
        totalBest = m2SellTotal;
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
      m1Svr: prices.m1Svr ?? null,
      m2Svr: prices.m2Svr ?? null,
      m1SellVsM2SellPct: prices.m1SellVsM2SellPct ?? null,
      m1BuyVsM2BuyPct: prices.m1BuyVsM2BuyPct ?? null,
      m1Spread: prices.m1Spread ?? null,
      m2Spread: prices.m2Spread ?? null,
    };
  }

  function sortValue(row) {
    switch (state.sortColumn) {
      case 'name': return row.item.typeName.toLowerCase();
      case 'quantity': return row.qty;
      case 'reprocessSell': return row.reprocessSellTotal;
      case 'reprocessBuy': return row.reprocessBuyTotal;
      case 'm1Sell': return row.m1SellTotal;
      case 'm1Buy': return row.m1BuyTotal;
      case 'm2Sell': return row.m2SellTotal;
      case 'm2Buy': return row.m2BuyTotal;
      case 'm1SellVsM2SellPct': return row.m1SellVsM2SellPct;
      case 'm1BuyVsM2BuyPct': return row.m1BuyVsM2BuyPct;
      case 'm1Spread': return row.m1Spread;
      case 'm2Spread': return row.m2Spread;
      case 'svr': return row.m1Svr;
      case 'bestAction': return row.bestAction;
      case 'totalBest': return row.totalBest;
      default: return row.totalBest;
    }
  }

  // ------------------------------------------------------------- rendering

  function iskCell(value, show) {
    const td = el('td', 'la-td is-numeric');
    if (!show || !(value > 0)) {
      td.appendChild(el('span', 'la-muted', '—'));
      return td;
    }
    const span = el('span', null, fmtISK(value));
    span.title = fullISK(value);
    td.appendChild(span);
    return td;
  }

  function pctCell(value) {
    const td = el('td', 'la-td is-numeric');
    if (value === null || value === undefined || Number.isNaN(value)) {
      td.appendChild(el('span', 'la-muted', '—'));
      return td;
    }
    const cls = value > 0 ? 'la-pct-up' : value < 0 ? 'la-pct-down' : null;
    td.appendChild(el('span', cls, `${value > 0 ? '+' : ''}${value.toFixed(1)}%`));
    return td;
  }

  function svrBadge(svr, label) {
    const span = el('span', `la-svr ${svrClass(svr)}`);
    span.title = '7-day avg daily volume';
    span.textContent = `${label ? `${label}: ` : ''}${svr === null || svr === undefined ? 'N/A' : `${fmtQty(svr)}/d`}`;
    return span;
  }

  function actionPill(action) {
    const labels = {
      reprocess: 'Reprocess',
      'sell-m1': 'Sell M1',
      'sell-m2': 'Sell M2',
      unknown: '—',
    };
    return el('span', `la-action is-${action || 'unknown'}`, labels[action] || '—');
  }

  function renderTable() {
    const rows = state.items.map(buildRow);

    const dir = state.sortDirection === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
    });

    els.tbody.replaceChildren(...rows.map((row) => {
      const tr = el('tr');
      // The row's recommended action drives its wash colour. 'unknown' is
      // deliberately left unstyled.
      if (row.bestAction && row.bestAction !== 'unknown') {
        tr.classList.add(`la-row-${row.bestAction}`);
      }

      const hasM2 = row.m2SellTotal !== null;

      const name = el('td', 'la-td col-name', row.item.typeName);
      name.title = row.item.typeName;
      tr.appendChild(name);

      tr.appendChild(el('td', 'la-td is-numeric', fmtQty(row.qty)));
      tr.appendChild(iskCell(row.reprocessSellTotal, row.item.canReprocess));
      tr.appendChild(iskCell(row.reprocessBuyTotal, row.item.canReprocess));
      tr.appendChild(iskCell(row.m1SellTotal, true));
      tr.appendChild(iskCell(row.m1BuyTotal, true));
      tr.appendChild(iskCell(row.m2SellTotal, hasM2));
      tr.appendChild(iskCell(row.m2BuyTotal, hasM2));
      tr.appendChild(pctCell(row.m1SellVsM2SellPct));
      tr.appendChild(pctCell(row.m1BuyVsM2BuyPct));
      tr.appendChild(pctCell(row.m1Spread));
      tr.appendChild(pctCell(row.m2Spread));

      const svrTd = el('td', 'la-td is-numeric');
      if (hasM2) {
        svrTd.appendChild(svrBadge(row.m1Svr, 'M1'));
        svrTd.appendChild(document.createTextNode(' '));
        svrTd.appendChild(svrBadge(row.m2Svr, 'M2'));
      } else {
        svrTd.appendChild(svrBadge(row.m1Svr));
      }
      tr.appendChild(svrTd);

      const actionTd = el('td', 'la-td is-center');
      actionTd.appendChild(actionPill(row.bestAction));
      tr.appendChild(actionTd);

      tr.appendChild(iskCell(row.totalBest, true));
      return tr;
    }));

    const grand = rows.reduce((sum, r) => sum + (r.totalBest || 0), 0);
    els.grandTotal.textContent = fmtISK(grand);
    els.grandTotal.title = fullISK(grand);
    // "12 items · best-total", matching the mockup - the suffix labels what
    // the figure beside it is summing.
    els.resultCount.textContent =
      `${fmtQty(rows.length)} item${rows.length === 1 ? '' : 's'} · best-total`;

    renderSortHeaders();
  }

  function renderSortHeaders() {
    els.theadRow.querySelectorAll('.la-th.sortable').forEach((th) => {
      const active = th.dataset.sort === state.sortColumn;
      th.classList.toggle('is-active', active);
      const icon = th.querySelector('.la-sort-icon');
      if (icon) icon.textContent = active ? (state.sortDirection === 'asc' ? '↑' : '↓') : '↕';
    });
  }

  function sortBy(column) {
    if (state.sortColumn === column) {
      state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
    } else {
      state.sortColumn = column;
      state.sortDirection = 'desc';
    }
    renderTable();
  }

  // -------------------------------------------------------------- analyze

  function showLoading(message) {
    els.loadingText.textContent = message || 'Loading…';
    els.loading.hidden = false;
  }

  function hideLoading() {
    els.loading.hidden = true;
  }

  async function analyze() {
    if (state.analyzing) return;

    const rawText = els.lootInput.value.trim();
    if (!rawText) {
      toast('Paste some loot or assets first', 'warning');
      return;
    }

    const market1 = locationForSlot(1);
    if (!market1) {
      // Was an alert(): a native dialog is modal and freezes the whole shell.
      toast('Select a Market 1 region first', 'warning');
      return;
    }

    state.analyzing = true;
    showLoading('Parsing items…');

    try {
      const parseResult = await window.electronAPI.loot.parseAndEnrich(rawText);
      state.items = parseResult.items || [];

      const badLines = [
        ...(parseResult.unresolvedNames || []),
        ...(parseResult.parseErrors || []),
      ];
      if (badLines.length > 0) {
        els.unresolvedList.textContent = badLines.join(', ');
        els.unresolved.hidden = false;
      } else {
        els.unresolved.hidden = true;
      }

      if (state.items.length === 0) {
        hideLoading();
        els.results.hidden = true;
        els.emptyState.hidden = false;
        toast('No recognisable items in that text', 'warning');
        return;
      }

      showLoading('Fetching prices…');

      const stationConfig = {
        stationType: els.stationType.value,
        rig: els.rig1.value,
        rig2: els.rig2.value,
      };
      const baseSkills = {
        reprocessing: intValue(els.skillReprocessing),
        reprocessingEfficiency: intValue(els.skillReprocessingEff),
      };
      const implantBonus = parseFloat(els.implantBonus.value) || 0;
      const oreSkills = oreSkillLevels();

      // Kept for the per-item yield recalculation inside buildRow.
      state.reprocessingConfig = { stationConfig, baseSkills, implantBonus, oreSkills };

      const itemReprocessingData = {};
      state.items.forEach((item) => {
        if (item.canReprocess) {
          itemReprocessingData[item.typeId] = {
            portionSize: item.portionSize,
            materials: item.materials,
          };
        }
      });

      const priceResult = await window.electronAPI.loot.fetchPrices({
        typeIds: state.items.map((i) => i.typeId),
        materialTypeIds: [...new Set(
          state.items.flatMap((i) => (i.materials || []).map((m) => m.materialTypeId))
        )],
        market1,
        market2: locationForSlot(2),
        reprocessingConfig: { stationConfig, baseSkills, implantBonus, oreSkillLevels: oreSkills },
        itemReprocessingData,
        itemTypeSkills: Object.fromEntries(
          state.items.map((i) => [i.typeId, i.typeSpecificSkillId || null])
        ),
        minSvr: minSvr(),
      });

      state.prices = priceResult.items || {};
      state.materialPrices = priceResult.materialPrices || {};

      // Main's rate is authoritative, so adopt it - but in the SAME format
      // renderYield uses, or the readout flips between "54.2%" and
      // "54.2% base" depending on whether an analysis has run.
      if (priceResult.baseYieldRate != null) {
        setYieldText(`${(priceResult.baseYieldRate * 100).toFixed(1)}%`);
      } else {
        renderYield();
      }

      els.emptyState.hidden = true;
      els.results.hidden = false;
      renderTable();
    } catch (error) {
      // The un-ported screen swallowed this into console.error, leaving the
      // user with a spinner that simply stopped.
      console.error('[loot] analysis failed:', error);
      toast(`Analysis failed: ${error.message}`, 'error');
    } finally {
      hideLoading();
      state.analyzing = false;
    }
  }

  // ---------------------------------------------------------- ore modal

  async function openOreModal() {
    els.oreModal.hidden = false;
    try {
      const characters = await window.electronAPI.esi.getCharacters() || [];
      const options = [el('option', null, '— Load from character —')];
      options[0].value = '';
      characters.forEach((c) => {
        const option = el('option', null, c.characterName);
        option.value = String(c.characterId);
        options.push(option);
      });
      els.oreCharacter.replaceChildren(...options);
    } catch (error) {
      console.error('[loot] could not load characters:', error);
    }
  }

  function closeOreModal() {
    els.oreModal.hidden = true;
  }

  function setAllOreSkills(level) {
    ORE_SKILLS.forEach(({ id }) => {
      const input = document.getElementById(id);
      if (input) input.value = String(level);
    });
  }

  async function loadSkillsFromCharacter() {
    const characterId = parseInt(els.oreCharacter.value, 10);
    if (!characterId) {
      toast('Pick a character first', 'warning');
      return;
    }

    els.oreLoad.disabled = true;
    const originalLabel = els.oreLoad.textContent;
    els.oreLoad.textContent = 'Loading…';

    try {
      // The handler returns an ENVELOPE - { found, skills } - not the map
      // itself. Treating the response as the map made every lookup miss and
      // reported "no reprocessing skills" for characters that had them.
      const result = await window.electronAPI.loot.getCharacterSkills(characterId);

      if (!result || !result.found) {
        toast(
          'No skill data for that character — fetch their skills first',
          'warning'
        );
        return;
      }

      // IPC serialisation turns integer keys into strings, so try both.
      const skills = result.skills || {};
      const level = (id) => skills[id] ?? skills[String(id)] ?? 0;

      ORE_SKILLS.forEach(({ id, skillId }) => {
        const input = document.getElementById(id);
        if (input) input.value = String(level(skillId));
      });

      // The two BASE reprocessing skills live on the main config panel, not
      // in this modal - loading a character has to fill those in as well or
      // the yield silently keeps the old values.
      els.skillReprocessing.value = String(level(3385));
      els.skillReprocessingEff.value = String(level(3389));

      await saveSettings();
      renderYield();
      toast('Skills loaded from character', 'success');
    } catch (error) {
      console.error('[loot] could not load character skills:', error);
      toast('Could not load skills for that character', 'error');
    } finally {
      els.oreLoad.disabled = false;
      els.oreLoad.textContent = originalLabel;
    }
  }

  // ------------------------------------------------------------------ mount

  async function mount(container, params, ctx) {
    // `state` is module-level and survives unmount.
    state.items = [];
    state.prices = {};
    state.materialPrices = {};
    state.reprocessingConfig = null;
    state.sortColumn = 'totalBest';
    state.sortDirection = 'desc';
    state.analyzing = false;
    noMarketSelected = true;

    const response = await fetch('loot-analyzer.view.html');
    container.innerHTML = await response.text();

    const $ = (id) => container.querySelector(`#${id}`);

    els = {
      lootInput: $('loot-input'),
      market1Region: $('market1-region'),
      market1Hub: $('market1-hub'),
      market2Region: $('market2-region'),
      market2Hub: $('market2-hub'),
      minSvr: $('min-svr'),
      warning: $('market-data-warning'),
      warningText: $('market-data-warning-text'),
      stationType: $('station-type'),
      rig1: $('rig-1'),
      rig2: $('rig-2'),
      rig2Group: $('rig-2-group'),
      skillReprocessing: $('skill-reprocessing'),
      skillReprocessingEff: $('skill-reprocessing-eff'),
      implantBonus: $('implant-bonus'),
      yieldValue: $('yield-value'),
      yieldValueResults: $('yield-value-results'),
      analyzeBtn: $('analyze-btn'),
      unresolved: $('unresolved-banner'),
      unresolvedList: $('unresolved-list'),
      noRegions: $('no-regions-state'),
      emptyState: $('la-empty-state'),
      results: $('results-section'),
      resultCount: $('la-result-count'),
      grandTotal: $('la-grand-total'),
      theadRow: $('la-thead-row'),
      tbody: $('results-tbody'),
      oreBtn: $('ore-skills-btn'),
      oreModal: $('ore-skills-modal'),
      oreModalClose: $('ore-skills-modal-close'),
      oreCharacter: $('ore-skills-character-select'),
      oreLoad: $('ore-skills-load-char-btn'),
      oreSetAll: $('ore-skills-set-all-btn'),
      oreClear: $('ore-skills-clear-btn'),
      oreSave: $('ore-skills-save-btn'),
      loading: $('loading-overlay'),
      loadingText: $('loading-message'),
    };

    await loadRegions();

    // Restore AFTER the region options exist, or setting .value finds no
    // matching option and silently leaves the select on its placeholder.
    const saved = await loadSettings();

    if (saved.market1 && saved.market1.regionId) {
      els.market1Region.value = String(saved.market1.regionId);
      updateHub(1);
      if (saved.market1.locationId) els.market1Hub.value = String(saved.market1.locationId);
    }
    if (saved.market2 && saved.market2.regionId) {
      els.market2Region.value = String(saved.market2.regionId);
      updateHub(2);
      if (saved.market2.locationId) els.market2Hub.value = String(saved.market2.locationId);
    }

    els.minSvr.value = String(saved.minSvr ?? 0);

    const repr = saved.reprocessing || {};
    if (repr.stationType) els.stationType.value = repr.stationType;
    if (repr.rig) els.rig1.value = repr.rig;
    if (repr.rig2) els.rig2.value = repr.rig2;
    els.skillReprocessing.value = String(repr.reprocessing ?? 0);
    els.skillReprocessingEff.value = String(repr.reprocessingEfficiency ?? 0);
    els.implantBonus.value = String(repr.implantBonus ?? 0);
    els.rig2Group.hidden = els.stationType.value !== 'tatara';

    // Look the inputs up by the KNOWN id list rather than by iterating the
    // saved keys. A stray key would otherwise reach querySelector, and an id
    // that is not a valid CSS identifier (a bare number, say) throws and
    // takes the whole mount down with it.
    ORE_SKILLS.forEach(({ id }) => {
      const level = (saved.oreSkills || {})[id];
      if (level === undefined) return;
      const input = container.querySelector(`#${id}`);
      if (input) input.value = String(level);
    });

    // ---- listeners, all via ctx so a remount cannot duplicate them
    ctx.on(els.analyzeBtn, 'click', analyze);

    [1, 2].forEach((slot) => {
      const select = slot === 1 ? els.market1Region : els.market2Region;
      const hub = slot === 1 ? els.market1Hub : els.market2Hub;
      ctx.on(select, 'change', () => {
        updateHub(slot);
        saveSettings();
        refreshFreshness();
      });
      ctx.on(hub, 'change', () => {
        saveSettings();
        refreshFreshness();
      });
    });

    ctx.on(els.minSvr, 'input', () => saveSettings());
    ctx.on(els.stationType, 'change', onStationTypeChange);
    [els.rig1, els.rig2, els.implantBonus].forEach((node) => {
      ctx.on(node, 'change', () => {
        saveSettings();
        renderYield();
      });
    });
    [els.skillReprocessing, els.skillReprocessingEff].forEach((node) => {
      ctx.on(node, 'input', () => {
        saveSettings();
        renderYield();
      });
    });

    ctx.on(els.theadRow, 'click', (e) => {
      const th = e.target.closest('.la-th.sortable');
      if (th && th.dataset.sort) sortBy(th.dataset.sort);
    });

    ctx.on(els.oreBtn, 'click', openOreModal);
    ctx.on(els.oreModalClose, 'click', closeOreModal);
    ctx.on(els.oreLoad, 'click', loadSkillsFromCharacter);
    ctx.on(els.oreSetAll, 'click', () => setAllOreSkills(5));
    ctx.on(els.oreClear, 'click', () => setAllOreSkills(0));
    ctx.on(els.oreSave, 'click', async () => {
      await saveSettings();
      closeOreModal();
      toast('Ore processing skills saved', 'success');
    });
    // Backdrop click and Escape must go through the same teardown as the X.
    ctx.on(els.oreModal, 'click', (e) => {
      if (e.target === els.oreModal) closeOreModal();
    });
    ctx.on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && !els.oreModal.hidden) closeOreModal();
    });

    renderYield();
    refreshFreshness();

    return {
      destroy() {
        // The freshness subscription owns bus listeners AND an interval, so
        // leaving it attached would keep re-reading the dashboard forever.
        if (freshnessDispose) {
          freshnessDispose();
          freshnessDispose = null;
        }
      },

      /**
       * State to carry into a popped-out window.
       *
       * Analysis is an SDE parse plus a price fetch per item across two
       * markets, so the RESULTS are carried rather than recomputed. The pasted
       * text comes too: it is the input the user typed, and losing it would
       * make the popped window unable to re-run its own analysis.
       *
       * Most of the config is NOT carried - station type, rigs, skills,
       * implant, markets and min SVR are all persisted to `lootAnalyzer`
       * settings and reloaded on mount, so the popped window already agrees.
       * `oreCharacter` is the exception: it is a transient picker for the
       * "load skills from character" action and is deliberately left alone.
       */
      getHandoff() {
        const pasted = els.lootInput ? els.lootInput.value : '';
        if (!pasted && state.items.length === 0) return null;

        return {
          pasted,
          items: state.items,
          prices: state.prices,
          materialPrices: state.materialPrices,
          sortColumn: state.sortColumn,
          sortDirection: state.sortDirection,
          yieldText: els.yieldValue ? els.yieldValue.textContent : null,
        };
      },

      /** Adopt a popped-out window's paste and results, skipping the analysis. */
      applyHandoff(payload) {
        if (!payload) return;

        // The paste box first: it is restored even with no results, so a
        // half-finished paste survives the move.
        if (typeof payload.pasted === 'string' && els.lootInput) {
          els.lootInput.value = payload.pasted;
        }

        if (!Array.isArray(payload.items) || payload.items.length === 0) return;

        state.items = payload.items;
        state.prices = payload.prices || {};
        state.materialPrices = payload.materialPrices || {};
        if (payload.sortColumn) state.sortColumn = payload.sortColumn;
        if (payload.sortDirection) state.sortDirection = payload.sortDirection;

        // The yield readout is set by analyze() from main's authoritative rate,
        // so carry the rendered text rather than recomputing it from skills -
        // otherwise it reverts to the "% base" form and reads as a different
        // number.
        if (payload.yieldText) setYieldText(payload.yieldText);

        els.emptyState.hidden = true;
        els.results.hidden = false;
        renderTable();
      },
    };
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('loot-analyzer', {
      title: 'Loot Analyzer',
      mount,
    });
  }
})();
