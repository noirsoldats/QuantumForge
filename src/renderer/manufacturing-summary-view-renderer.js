/**
 * Manufacturing Summary — native shell view.
 *
 * Ported from "Manufacturing Summary (1a).dc.html". Unlike the per-character
 * screens, this one mounts IN PLACE in the main window's content pane; the
 * pop-out affordance arrives with the generic pop-out work.
 *
 * WHAT MOVED, AND WHAT DID NOT
 *
 * The profitability formulas are NOT in this file. They were extracted to
 * `src/main/manufacturing-metrics.js` as pure functions and are reached through
 * `market.metricsForProduct`, which fetches each product's history ONCE and
 * feeds every metric from it. The old renderer called six functions per
 * blueprint that each re-fetched the same history - roughly 1,200 history calls
 * on a 200-blueprint run instead of ~200.
 *
 * Everything else about the calculation is unchanged: the same blueprint/
 * reaction selection, the same batching (6 concurrent), the same speculative
 * invention path, the same column set.
 *
 * Behaviours carried over from the live screen:
 *   - blueprint filter (all / owned / character), character sub-filter
 *   - SVR period and threshold, IPH and profit thresholds with enable toggles
 *   - tech level and category chips
 *   - speculative invention with decryptor strategy and custom volume
 *   - market set / manufacturing facility / reaction facility selection,
 *     persisted per tool
 *   - 34 configurable columns with drag reorder, saved to the config file
 *   - sortable results, client-side search, row selection, Add to Plan
 *   - market data staleness banner
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------- state

  const state = {
    loading: false,
    cancelling: false,
    calculated: false,

    // filters
    blueprintFilter: 'owned',
    characterFilter: 'all',
    characterId: null,
    svrPeriod: 30,
    svrThreshold: null,
    iphEnabled: false,
    iphThreshold: null,
    profitEnabled: false,
    profitThreshold: null,
    techLevels: {},
    categories: {},

    // speculative invention
    specEnabled: false,
    decryptorStrategy: 'total-per-item',

    // context
    marketSetId: null,
    marketSets: [],
    facilityId: null,
    facilities: [],
    reactionFacilityId: null,
    reactionFacilities: [],
    characters: [],

    // results
    results: [],
    filtered: [],
    selected: {},
    sortColumn: 'profit',
    sortDirection: 'desc',
    query: '',

    // columns
    visibleColumns: [],
    columnOrder: null,
    dragColumn: null,
    dropColumn: null,
  };

  let els = {};

  /**
   * LEGACY localStorage keys - READ ONCE, then deleted.
   *
   * The un-ported screen persisted chips and columns here. Both now live in
   * quantum_config.json; these constants exist only so an upgrading user's
   * setup can be lifted across on first load. Nothing writes to them.
   */
  const COLUMN_STORAGE_KEY = 'manufacturing-summary-columns';
  const FILTER_STORAGE_KEY = 'manufacturing-summary-filters';

  // -------------------------------------------------------------- columns

  /**
   * The full column set, with ids carried over verbatim from the live screen
   * so a config migrated out of localStorage still resolves every column.
   */
  const ALL_COLUMNS = [
    { id: 'category', label: 'Category', def: true, numeric: false },
    { id: 'name', label: 'Item Name', def: true, numeric: false },
    { id: 'owned', label: 'Owned?', def: true, numeric: false },
    { id: 'tech', label: 'Tech', def: true, numeric: false },
    { id: 'bp-type', label: 'BP Type', def: true, numeric: false },
    { id: 'me', label: 'ME', def: true, numeric: true },
    { id: 'te', label: 'TE', def: true, numeric: true },
    { id: 'profit', label: 'Profit', def: true, numeric: true },
    { id: 'isk-per-hour', label: 'ISK/Hour', def: true, numeric: true },
    { id: 'svr', label: 'SVR', def: true, numeric: true },
    { id: 'total-cost', label: 'Total Cost', def: true, numeric: true },
    { id: 'roi', label: 'ROI %', def: true, numeric: true },

    { id: 'owner', label: 'Owner', def: false, numeric: false },
    { id: 'location', label: 'Location', def: false, numeric: false },
    { id: 'job-costs', label: 'Job Costs', def: false, numeric: true },
    { id: 'material-purchase-fees', label: 'Material Purchase Fees', def: false, numeric: true },
    { id: 'product-selling-fees', label: 'Product Selling Fees', def: false, numeric: true },
    { id: 'trading-fees-total', label: 'Trading Fees Total', def: false, numeric: true },
    { id: 'product-market-price', label: 'Product Market Price', def: false, numeric: true },
    { id: 'profit-percentage', label: 'Profit %', def: false, numeric: true },
    { id: 'manufacturing-steps', label: 'Manufacturing Steps', def: false, numeric: true },
    { id: 'm3-inputs', label: 'M³ Inputs', def: false, numeric: true },
    { id: 'm3-outputs', label: 'M³ Outputs', def: false, numeric: true },
    { id: 'current-sell-orders', label: 'Current Sell Orders', def: false, numeric: true },

    { id: 'profit-velocity', label: 'Profit Velocity (ISK/Day)', def: false, numeric: true },
    { id: 'market-saturation', label: 'Market Saturation Index', def: false, numeric: true },
    { id: 'price-momentum', label: 'Price Momentum', def: false, numeric: true },
    { id: 'profit-stability', label: 'Profit Stability Index', def: false, numeric: true },
    { id: 'demand-growth', label: 'Demand Growth Rate', def: false, numeric: true },
    { id: 'material-cost-volatility', label: 'Material Cost Volatility', def: false, numeric: true },
    { id: 'market-health-score', label: 'Market Health Score', def: false, numeric: true },

    { id: 'invention-status', label: 'Invention Status', def: false, numeric: false },
    { id: 'optimal-decryptor', label: 'Optimal Decryptor', def: false, numeric: false },
    { id: 'invention-probability', label: 'Invention Probability', def: false, numeric: true },
    { id: 'invention-cost-attempt', label: 'Invention Cost/Attempt', def: false, numeric: true },
    { id: 'total-cost-with-invention', label: 'Total Cost w/ Invention', def: false, numeric: true },
  ];

  /**
   * Must match determineTechLevel() in manufacturing-summary.js EXACTLY - these
   * are compared by string, so a label the engine never emits is a chip that
   * always matches nothing. The mapping is not the obvious one: meta group 3 is
   * 'Storyline', 4/52 are 'Navy', 5/6 are 'Pirate'.
   */
  const TECH_LEVELS = ['T1', 'T2', 'T3', 'Storyline', 'Navy', 'Pirate'];

  /**
   * Fixed list, NOT derived from the results. These chips select which
   * blueprints go INTO the calculation, so they have to be selectable before
   * any calculation has run. 'Reactions' is load-bearing: the engine keys
   * whether to load reactions at all off its presence.
   */
  const CATEGORIES = [
    'Ships', 'Drones', 'Modules', 'Ammo/Charges', 'Components', 'Rigs',
    'Deployables', 'Subsystems', 'Structures', 'Structure Rigs',
    'Structure Modules', 'Boosters', 'Celestials', 'Reactions',
  ];

  function defaultColumns() {
    return ALL_COLUMNS.filter((c) => c.def).map((c) => c.id);
  }

  /**
   * Chips and columns live in the CONFIG FILE, not localStorage.
   *
   * The un-ported screen kept them in localStorage, which is per-origin and
   * invisible to the user - it does not travel with quantum_config.json, and
   * every other ported screen persists through settings. They are migrated
   * out of localStorage once, on first load, so nobody loses their setup.
   */
  function saveColumnConfig() {
    try {
      window.electronAPI.settings.update('manufacturingSummary', {
        visibleColumns: state.visibleColumns,
        // null means "default order". Persisting it alongside the visible set
        // is what makes a drag-reorder survive a remount.
        columnOrder: state.columnOrder,
      }).catch((error) => console.error('[summary] Could not save columns:', error));
    } catch (error) {
      console.error('[summary] Could not save columns:', error);
    }
  }

  function saveFilterConfig() {
    try {
      window.electronAPI.settings.update('manufacturingSummary', {
        blueprintChips: {
          tech: selectedKeys(state.techLevels),
          category: selectedKeys(state.categories),
        },
      }).catch((error) => console.error('[summary] Could not save chips:', error));
    } catch (error) {
      console.error('[summary] Could not save chips:', error);
    }
  }

  /**
   * One-time migration of the legacy localStorage keys.
   *
   * Returns whatever was found so the caller can adopt it, and clears the keys
   * so this never runs twice. Reads defensively: a corrupt value must not stop
   * the screen loading.
   */
  function readLegacyLocalStorage() {
    const legacy = { chips: null, columns: null };
    try {
      const chips = localStorage.getItem(FILTER_STORAGE_KEY);
      if (chips) legacy.chips = JSON.parse(chips);
      localStorage.removeItem(FILTER_STORAGE_KEY);
    } catch (error) {
      console.error('[summary] Could not migrate saved chips:', error);
    }
    try {
      const columns = localStorage.getItem(COLUMN_STORAGE_KEY);
      if (columns) legacy.columns = JSON.parse(columns);
      localStorage.removeItem(COLUMN_STORAGE_KEY);
    } catch (error) {
      console.error('[summary] Could not migrate saved columns:', error);
    }
    return legacy;
  }

  /** Keep only ids that still exist, else fall back to the default set. */
  function validColumns(ids) {
    if (!Array.isArray(ids)) return null;
    const valid = ids.filter((id) => ALL_COLUMNS.some((c) => c.id === id));
    return valid.length > 0 ? valid : null;
  }

  /**
   * Normalise a saved column order.
   *
   * Drops ids that no longer exist and APPENDS any column the saved order
   * never knew about, so a release that adds a column does not make it
   * unreachable for anyone with a stored order. Returns null for "no custom
   * order", which is what resetColumns() writes.
   */
  function completeOrder(saved) {
    if (!Array.isArray(saved) || saved.length === 0) return null;

    const known = new Set(ALL_COLUMNS.map((c) => c.id));
    const seen = new Set();
    const order = [];

    saved.forEach((id) => {
      if (!known.has(id) || seen.has(id)) return;
      seen.add(id);
      order.push(id);
    });

    ALL_COLUMNS.forEach((c) => {
      if (!seen.has(c.id)) order.push(c.id);
    });

    return order;
  }

  /**
   * Saved array -> on/off map, dropping names that no longer exist.
   *
   * A missing or unparseable list means "not saved yet" and defaults to all
   * on. An explicitly EMPTY saved list is honoured as-is - the user really did
   * deselect everything, and silently re-enabling it would fight them.
   */
  function toMap(savedList, known) {
    if (!Array.isArray(savedList)) {
      return Object.fromEntries(known.map((k) => [k, true]));
    }
    const chosen = new Set(savedList);
    return Object.fromEntries(known.map((k) => [k, chosen.has(k)]));
  }

  /** The chip keys currently switched on, as a plain array. */
  function selectedKeys(map) {
    return Object.keys(map || {}).filter((k) => map[k]);
  }

  /**
   * Chips changed, so the rows on screen were costed against a different
   * blueprint set. We deliberately do NOT re-filter them - that would imply the
   * chips subset the results, when they actually change what gets loaded and
   * costed. Flag the staleness and let the user press Calculate.
   */
  function markFiltersDirty() {
    // Only meaningful once something has been calculated - before that, the
    // chips are simply the settings for the first run.
    state.filtersDirty = state.results.length > 0;
    renderStaleNotice();
  }

  function renderStaleNotice() {
    if (els && els.staleNotice) els.staleNotice.hidden = !state.filtersDirty;
  }

  function orderedColumns() {
    const order = state.columnOrder || ALL_COLUMNS.map((c) => c.id);
    return order.map((id) => ALL_COLUMNS.find((c) => c.id === id)).filter(Boolean);
  }

  function activeColumns() {
    return orderedColumns().filter((c) => state.visibleColumns.includes(c.id));
  }

  // ------------------------------------------------------------ formatting

  function fmtNumber(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
  }

  /** ISK with a magnitude suffix, matching the live screen. */
  function fmtISK(value) {
    const v = Number(value) || 0;
    const abs = Math.abs(v);
    if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
    return v.toFixed(2);
  }

  function fmtPercent(v) {
    return `${((Number(v) || 0) * 100).toFixed(1)}%`;
  }

  function fmtDecimal(v, places = 2) {
    return (Number(v) || 0).toFixed(places);
  }

  // --------------------------------------------------------------- helpers

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function checkbox(checked) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.style.pointerEvents = 'none';
    input.tabIndex = -1;
    return input;
  }

  /**
   * Show a toast. QFToast exposes show(message, type) - there are NO per-type
   * methods, and calling one is a silent TypeError.
   */
  function toast(message, type = 'info') {
    if (window.QFToast && typeof window.QFToast.show === 'function') {
      window.QFToast.show(message, type);
    } else {
      console.log(`[summary] ${message}`);
    }
  }

  // ---------------------------------------------------------- persistence

  async function loadSettings() {
    try {
      const spec = await window.electronAPI.settings.get(
        'manufacturingSummary', 'speculativeInvention'
      );
      if (spec) {
        state.specEnabled = spec.enabled === true;
        state.decryptorStrategy = spec.decryptorStrategy || 'total-per-item';
      }

      // The market thresholds were previously in-memory only and reset on
      // every launch. They are a deliberate configuration of what to build,
      // so they persist alongside everything else.
      const thresholds = await window.electronAPI.settings.get(
        'manufacturingSummary', 'marketThresholds'
      );
      if (thresholds) {
        state.svrPeriod = thresholds.svrPeriod || 30;
        state.svrThreshold = numberOrNull(thresholds.svrThreshold);
        state.iphEnabled = thresholds.iphEnabled === true;
        state.iphThreshold = numberOrNull(thresholds.iphThreshold);
        state.profitEnabled = thresholds.profitEnabled === true;
        state.profitThreshold = numberOrNull(thresholds.profitThreshold);
      }

      // Source and facility selections. Validated against what actually
      // exists in loadContext() - a stored facility or character may have
      // been deleted since.
      const selections = await window.electronAPI.settings.get(
        'manufacturingSummary', 'selections'
      );
      if (selections) {
        state.blueprintFilter = selections.blueprintFilter || 'owned';
        state.characterFilter = selections.characterFilter || 'all';
        state.characterId = selections.characterId || null;
        state.savedFacilityId = selections.facilityId || null;
        state.savedReactionFacilityId = selections.reactionFacilityId || null;
      }

      // Chips and columns, with a one-time lift out of localStorage for
      // anyone upgrading from the un-ported screen.
      const legacy = readLegacyLocalStorage();
      const [storedChips, storedColumns, storedOrder] = await Promise.all([
        window.electronAPI.settings.get('manufacturingSummary', 'blueprintChips'),
        window.electronAPI.settings.get('manufacturingSummary', 'visibleColumns'),
        window.electronAPI.settings.get('manufacturingSummary', 'columnOrder'),
      ]);

      // The defaults ship blueprintChips as {tech: null, category: null}, so
      // the key always EXISTS - presence cannot mean "configured". Only an
      // actual array counts, and an empty one still counts (a deliberate
      // "select nothing" must not be overwritten by the legacy value).
      const chipsConfigured = storedChips
        && (Array.isArray(storedChips.tech) || Array.isArray(storedChips.category));
      const chips = chipsConfigured ? storedChips : legacy.chips;

      state.techLevels = toMap(chips && chips.tech, TECH_LEVELS);
      state.categories = toMap(chips && chips.category, CATEGORIES);
      state.visibleColumns = validColumns(storedColumns)
        || validColumns(legacy.columns)
        || defaultColumns();
      // A saved order must cover EVERY column - a partial list would silently
      // drop whatever it omits, including columns added in a later release.
      state.columnOrder = completeOrder(storedOrder);

      // Write the lifted values through so the migration happens exactly
      // once; the localStorage keys are already gone by this point.
      if (!chipsConfigured && legacy.chips) saveFilterConfig();
      if (!validColumns(storedColumns) && validColumns(legacy.columns)) saveColumnConfig();
    } catch (error) {
      console.error('[summary] Could not load settings:', error);
    }
  }

  async function saveSelections() {
    try {
      await window.electronAPI.settings.update('manufacturingSummary', {
        selections: {
          blueprintFilter: state.blueprintFilter,
          characterFilter: state.characterFilter,
          // Only meaningful for 'specific'; stored as null otherwise so a
          // stale id cannot resurface if the user switches back.
          characterId: state.characterFilter === 'specific' ? state.characterId : null,
          facilityId: state.facilityId,
          reactionFacilityId: state.reactionFacilityId,
        },
      });
    } catch (error) {
      console.error('[summary] Could not save selections:', error);
    }
  }

  /** Keeps 0 and negatives, which are meaningful thresholds. */
  function numberOrNull(value) {
    return typeof value === 'number' && !Number.isNaN(value) ? value : null;
  }

  /**
   * Persist the speculative-invention block.
   *
   * settings:update merges only ONE level deep, so this object REPLACES the
   * stored one - every field the screen owns has to be written every time.
   */
  async function saveSpecSettings() {
    try {
      await window.electronAPI.settings.update('manufacturingSummary', {
        speculativeInvention: {
          enabled: state.specEnabled,
          decryptorStrategy: state.decryptorStrategy,
        },
      });
    } catch (error) {
      console.error('[summary] Could not save settings:', error);
    }
  }

  async function saveThresholdSettings() {
    try {
      await window.electronAPI.settings.update('manufacturingSummary', {
        marketThresholds: {
          svrPeriod: state.svrPeriod,
          svrThreshold: state.svrThreshold,
          iphEnabled: state.iphEnabled,
          iphThreshold: state.iphThreshold,
          profitEnabled: state.profitEnabled,
          profitThreshold: state.profitThreshold,
        },
      });
    } catch (error) {
      console.error('[summary] Could not save threshold settings:', error);
    }
  }

  // ------------------------------------------------------------ data load

  async function loadContext() {
    const [marketSets, facilities, characters, toolSet] = await Promise.all([
      window.electronAPI.market.getMarketSets().catch(() => []),
      window.electronAPI.facilities.getFacilities().catch(() => []),
      window.electronAPI.esi.getCharacters().catch(() => []),
      window.electronAPI.market.getMarketSetForTool('manufacturingSummary').catch(() => null),
    ]);

    state.marketSets = Array.isArray(marketSets) ? marketSets : [];
    state.characters = Array.isArray(characters) ? characters : [];

    const all = Array.isArray(facilities) ? facilities : [];
    state.facilities = all;
    state.reactionFacilities = all.filter(isReactionFacility);

    const defaultSet = (toolSet && toolSet.marketSet)
      || state.marketSets.find((s) => s.isDefault)
      || state.marketSets[0];
    state.marketSetId = defaultSet ? defaultSet.id : null;

    // A saved selection wins, but only if it still exists - facilities can be
    // deleted between sessions, and a dangling id would select nothing and
    // silently calculate against the wrong facility.
    const savedFacility = state.savedFacilityId
      && state.facilities.find((f) => String(f.id) === String(state.savedFacilityId));

    // Facilities mark their default with `usage: 'default'`. There is no
    // isDefault flag on a facility - checking for one selected whichever
    // happened to be first.
    const defaultFacility = savedFacility
      || state.facilities.find((f) => f.usage === 'default')
      || state.facilities[0];
    state.facilityId = defaultFacility ? defaultFacility.id : null;

    // Reaction facility is optional: "No Facility" is a valid saved choice,
    // so an absent saved id means "none" rather than "pick one for me".
    const savedReaction = state.savedReactionFacilityId
      && state.reactionFacilities.find(
        (f) => String(f.id) === String(state.savedReactionFacilityId)
      );
    state.reactionFacilityId = savedReaction ? savedReaction.id : null;

    // Drop a character selection whose character is gone, so the dropdown and
    // the calculation cannot disagree.
    if (state.characterId
      && !state.characters.some((c) => String(c.characterId) === String(state.characterId))) {
      state.characterId = null;
      if (state.characterFilter === 'specific') state.characterFilter = 'all';
    }
  }

  /**
   * Refineries, or anything the user has tagged for reactions.
   *
   * `usage` is a free-text role ('default', 'components', 'reactions', ...),
   * so it is matched by substring exactly as the existing screen does.
   * structureTypeId is compared as a STRING because that is how it is stored
   * in the config - comparing against the numeric ids silently matched
   * nothing.
   */
  function isReactionFacility(facility) {
    const REFINERY_TYPE_IDS = ['35835', '35836']; // Athanor, Tatara
    if (REFINERY_TYPE_IDS.includes(String(facility.structureTypeId))) return true;
    return typeof facility.usage === 'string' && facility.usage.includes('reaction');
  }

  async function checkMarketDataAge() {
    try {
      const lastFetch = await window.electronAPI.market.getLastFetchTime();
      if (!lastFetch) {
        els.staleness.hidden = true;
        return;
      }

      const ageMs = Date.now() - lastFetch;
      const hours = Math.floor(ageMs / 3600000);
      const minutes = Math.floor((ageMs % 3600000) / 60000);

      // Two hours is the live screen's warning threshold.
      if (hours >= 2) {
        const setName = currentMarketSetName();
        els.stalenessText.textContent =
          `${setName} market data is ${hours}h ${minutes}m old — recalculate for current prices.`;
        els.staleness.hidden = false;
      } else {
        els.staleness.hidden = true;
      }
    } catch (error) {
      console.error('[summary] Could not check market data age:', error);
    }
  }

  function currentMarketSetName() {
    const set = state.marketSets.find((s) => String(s.id) === String(state.marketSetId));
    return set ? set.name : 'Market';
  }

  // ------------------------------------------------------------- rendering

  function render() {
    if (!els.root) return;
    try {
      renderFilters();
      renderControls();
      renderResults();
    } catch (error) {
      // Renderer failures are swallowed into console.error by default, which is
      // how a whole view can silently blank. Surfacing it keeps that visible.
      console.error('[summary] Render failed:', error);
    }
  }

  /**
   * @param {boolean} segment - square "pick one scope" shape rather than the
   *        pill used for the multi-select tech/category tags.
   */
  function chip(label, on, onClick, segment = false) {
    const classes = `ms-chip${segment ? ' ms-chip-seg' : ''}${on ? ' is-on' : ''}`;
    const node = el('button', classes, label);
    node.type = 'button';
    node.setAttribute('aria-pressed', on ? 'true' : 'false');
    node.addEventListener('click', onClick);
    return node;
  }

  function renderFilters() {
    // These three values are what selectBlueprints() switches on. 'character'
    // was invented during the port and matched nothing in the engine, while
    // 'corp' - a real option on the existing screen - was missing entirely.
    const BP_FILTERS = [
      ['all', 'All Blueprints'],
      ['owned', 'Owned BPs'],
      ['corp', 'Corp BPs'],
    ];

    const CHAR_FILTERS = [
      ['all', 'All Characters'],
      ['default', 'Default Character'],
      ['specific', 'Specific Character'],
    ];

    // Also pre-calculation inputs: they choose which blueprints are loaded,
    // so they mark the results stale rather than re-filtering them.
    els.bpFilters.replaceChildren(...BP_FILTERS.map(([id, label]) => chip(
      label, state.blueprintFilter === id,
      () => {
        state.blueprintFilter = id;
        render();
        markFiltersDirty();
        saveSelections();
      },
      true
    )));

    // Always shown, matching the mockup and the existing screen: the character
    // scope applies to owned and corp alike, so hiding it behind a blueprint
    // filter would strand the user's selection.
    els.charFilters.replaceChildren(...CHAR_FILTERS.map(([id, label]) => chip(
      label, state.characterFilter === id,
      () => {
        state.characterFilter = id;
        render();
        markFiltersDirty();
        saveSelections();
      },
      true
    )));

    els.charSelectWrap.hidden = state.characterFilter !== 'specific';
    if (!els.charSelectWrap.hidden) {
      if (els.charSelect.options.length === 0) {
        els.charSelect.replaceChildren(...state.characters.map((c) => {
          const option = document.createElement('option');
          option.value = String(c.characterId);
          option.textContent = c.characterName;
          return option;
        }));
      }
      // Keep state and the visible selection in agreement. Without the else
      // branch an unset characterId leaves the select showing the first
      // character while the engine is told 'specific' with no id, which it
      // rejects - the dropdown would look valid and Calculate would fail.
      if (state.characterId) els.charSelect.value = String(state.characterId);
      else state.characterId = parseInt(els.charSelect.value, 10) || null;
    }

    // Tech and category chips are PRE-CALCULATION inputs: they choose which
    // blueprints get loaded and costed, and take effect on the next Calculate.
    // They must NOT filter the results already on screen - the only live filter
    // over results is the search box.
    els.techChips.replaceChildren(...TECH_LEVELS.map((tech) => chip(
      tech, !!state.techLevels[tech],
      () => {
        state.techLevels[tech] = !state.techLevels[tech];
        renderFilters();
        saveFilterConfig();
        markFiltersDirty();
      }
    )));

    els.catChips.replaceChildren(...CATEGORIES.map((cat) => chip(
      cat, !!state.categories[cat],
      () => {
        state.categories[cat] = !state.categories[cat];
        renderFilters();
        saveFilterConfig();
        markFiltersDirty();
      }
    )));
  }

  function renderControls() {
    els.decStrategyWrap.classList.toggle('is-disabled', !state.specEnabled);
    els.decStrategy.disabled = !state.specEnabled;

    els.iphThreshold.disabled = !state.iphEnabled;
    els.profitThreshold.disabled = !state.profitEnabled;
  }

  /** Populate a <select> once, preserving the current value. */
  function fillSelect(select, items, valueOf, labelOf, current, placeholder) {
    const options = items.map((item) => {
      const option = document.createElement('option');
      option.value = String(valueOf(item));
      option.textContent = labelOf(item);
      return option;
    });

    if (placeholder) {
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = placeholder;
      options.unshift(blank);
    }

    select.replaceChildren(...options);
    // An empty current is meaningful when there is a placeholder - it selects
    // it - so only skip null/undefined.
    if (current != null) select.value = String(current);
    else if (placeholder) select.value = '';
  }

  function renderContextSelectors() {
    fillSelect(els.marketSet, state.marketSets, (s) => s.id, (s) => s.name, state.marketSetId);
    fillSelect(els.facility, state.facilities, (f) => f.id, (f) => f.name, state.facilityId);
    // Reactions are optional, so this one leads with "No Facility".
    fillSelect(
      els.reactionFacility, state.reactionFacilities,
      (f) => f.id, (f) => f.name, state.reactionFacilityId, 'No Facility'
    );
  }

  function cellValue(row, columnId) {
    switch (columnId) {
      case 'category': return row.category || 'Unknown';
      case 'name': return row.itemName || '';
      case 'owned': return row.isOwned ? 'Yes' : 'No';
      case 'tech': return row.techLevel || '';
      case 'bp-type': return row.bpType || 'N/A';
      case 'me': return row.meLevel;
      case 'te': return row.teLevel;
      case 'profit': return row.profit;
      case 'isk-per-hour': return row.iskPerHour;
      case 'svr': return row.svr;
      case 'total-cost': return row.totalCost;
      case 'roi': return row.roi;
      case 'owner': return row.ownerName || '';
      case 'location': return row.location || '';
      case 'job-costs': return row.jobCosts;
      case 'material-purchase-fees': return row.materialPurchaseFees;
      case 'product-selling-fees': return row.productSellingFees;
      case 'trading-fees-total': return row.tradingFeesTotal;
      case 'product-market-price': return row.productMarketPrice;
      case 'profit-percentage': return row.profitPercentage;
      case 'manufacturing-steps': return row.manufacturingSteps;
      case 'm3-inputs': return row.m3Inputs;
      case 'm3-outputs': return row.m3Outputs;
      case 'current-sell-orders': return row.currentSellOrders;
      case 'profit-velocity': return row.profitVelocity;
      case 'market-saturation': return row.marketSaturation;
      case 'price-momentum': return row.priceMomentum;
      case 'profit-stability': return row.profitStability;
      case 'demand-growth': return row.demandGrowth;
      case 'material-cost-volatility': return row.materialCostVolatility;
      case 'market-health-score': return row.marketHealthScore;
      case 'invention-status': return row.inventionStatus || '';
      case 'optimal-decryptor': return row.optimalDecryptor || '';
      case 'invention-probability': return row.inventionProbability;
      case 'invention-cost-attempt': return row.inventionCostPerAttempt;
      case 'total-cost-with-invention': return row.totalCostWithInvention;
      default: return '';
    }
  }

  function renderCell(row, columnId) {
    const value = cellValue(row, columnId);

    switch (columnId) {
      // Both of these truncate, so the full text goes in a title tooltip. No
      // "Owned" badge here - the Owned? column sits directly beside it and
      // said the same thing twice.
      case 'name': {
        const node = el('span', 'ms-item-name', String(value));
        node.title = String(value);
        return node;
      }
      case 'category': {
        const node = el('span', 'ms-category', String(value));
        node.title = String(value);
        return node;
      }
      // A speculative BPC is called out with the same amber pill the row tint
      // uses, so the two read as one signal.
      case 'bp-type': {
        if (!row.isSpeculative) return el('span', null, String(value));
        return el('span', 'ms-pill is-speculative', String(value));
      }
      case 'invention-status': {
        if (!value) return el('span', 'ms-muted', '—');
        return el('span', 'ms-pill is-speculative', String(value));
      }
      case 'profit': {
        const node = el('span', `ms-profit${(row.profit || 0) < 0 ? ' is-negative' : ''}`);
        node.textContent = fmtISK(row.profit);
        return node;
      }
      case 'isk-per-hour':
      case 'total-cost':
      case 'job-costs':
      case 'material-purchase-fees':
      case 'product-selling-fees':
      case 'trading-fees-total':
      case 'product-market-price':
      case 'profit-velocity':
      case 'invention-cost-attempt':
      case 'total-cost-with-invention':
        return el('span', null, fmtISK(value));

      case 'roi':
      case 'profit-percentage':
        return el('span', null, `${fmtDecimal(value, 1)}%`);

      case 'price-momentum':
      case 'demand-growth':
        return el('span', null, fmtPercent(value));

      case 'invention-probability':
        return el('span', null, fmtPercent(value));

      case 'svr':
      case 'market-saturation':
      case 'material-cost-volatility':
      case 'market-health-score':
      case 'profit-stability':
        return el('span', null, fmtDecimal(value, 2));

      case 'm3-inputs':
      case 'm3-outputs':
        return el('span', null, `${fmtNumber(value)} m³`);

      case 'current-sell-orders':
      case 'manufacturing-steps':
      case 'me':
      case 'te':
        return el('span', null, fmtNumber(value));

      default:
        return el('span', null, String(value == null ? '' : value));
    }
  }

  function rowKey(row) {
    // A blueprint can appear once as itself and once as an invention
    // candidate, so the key needs both.
    return `${row.blueprintTypeId}:${row.inventionStatus || 'direct'}`;
  }

  function renderResults() {
    const hasResults = state.filtered.length > 0;

    els.resultsHead.hidden = !state.calculated;
    els.results.hidden = !hasResults;
    els.empty.hidden = state.calculated && hasResults;

    if (state.calculated && !hasResults) {
      els.emptyTitle.textContent = 'No blueprints match';
      els.emptyText.textContent =
        'Adjust your filters or thresholds, then Calculate Summary again.';
    }

    if (!hasResults) {
      // CLEAR the table before leaving. The container is hidden, but the rows
      // are still in the DOM - so a filter that matches nothing left the old
      // results sitting there, ready to reappear the moment the container was
      // shown again. Empty means empty.
      els.tbody.replaceChildren();
      els.resultCount.textContent = '0 rows';
      els.addToPlan.hidden = true;
      return;
    }

    els.resultCount.textContent = `${fmtNumber(state.filtered.length)} rows`;

    const columns = activeColumns();

    // ---- header
    const headerCells = [];
    const allSelected = state.filtered.length > 0
      && state.filtered.every((r) => state.selected[rowKey(r)]);

    const checkTh = el('th', 'ms-th is-check');
    const selectAll = checkbox(allSelected);
    selectAll.style.pointerEvents = 'auto';
    selectAll.tabIndex = 0;
    selectAll.setAttribute('aria-label', 'Select all rows');
    selectAll.addEventListener('change', () => {
      const next = { ...state.selected };
      state.filtered.forEach((r) => { next[rowKey(r)] = !allSelected; });
      state.selected = next;
      renderResults();
    });
    checkTh.appendChild(selectAll);
    headerCells.push(checkTh);

    columns.forEach((col) => {
      const sorted = state.sortColumn === col.id;
      const th = el('th', `ms-th${col.numeric ? ' is-numeric' : ''}${sorted ? ' is-sorted' : ''}`);
      th.scope = 'col';
      th.setAttribute('aria-sort', sorted
        ? (state.sortDirection === 'asc' ? 'ascending' : 'descending')
        : 'none');
      th.textContent = `${col.label} ${sorted ? (state.sortDirection === 'asc' ? '↑' : '↓') : '↕'}`;
      th.addEventListener('click', () => sortBy(col.id));
      headerCells.push(th);
    });

    els.theadRow.replaceChildren(...headerCells);

    // ---- body
    els.tbody.replaceChildren(...state.filtered.map((row) => {
      const key = rowKey(row);
      const selected = !!state.selected[key];
      // Selection wins over the speculative tint - both are box-shadow, and
      // the user needs to see what they have ticked.
      const tr = el('tr', `ms-row${row.isSpeculative ? ' is-speculative' : ''}${selected ? ' is-selected' : ''}`);

      const checkTd = el('td', 'ms-td is-check');
      checkTd.appendChild(checkbox(selected));
      checkTd.addEventListener('click', () => {
        state.selected = { ...state.selected, [key]: !state.selected[key] };
        renderResults();
      });
      tr.appendChild(checkTd);

      columns.forEach((col) => {
        const td = el('td', `ms-td${col.numeric ? ' is-numeric' : ''}`);
        td.appendChild(renderCell(row, col.id));
        tr.appendChild(td);
      });

      return tr;
    }));

    const selectedCount = state.filtered.filter((r) => state.selected[rowKey(r)]).length;
    els.addToPlan.hidden = selectedCount === 0;
    els.addToPlanLabel.textContent = `Add to Plan (${selectedCount})`;
  }

  // ---------------------------------------------------------------- sort

  function sortBy(columnId) {
    if (state.sortColumn === columnId) {
      state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
    } else {
      state.sortColumn = columnId;
      state.sortDirection = 'desc';
    }
    applyFilters();
  }

  /**
   * The ONLY live filter over the results is the search box. Chips and market
   * thresholds are inputs to the calculation, not views onto its output - they
   * decide which blueprints get loaded and costed, and the engine has already
   * applied them by the time rows reach here. Re-applying them would double-
   * filter, and worse, would imply the results can be widened without
   * recalculating when they cannot.
   */
  function applyFilters() {
    const q = state.query.trim().toLowerCase();

    let rows = state.results.filter((row) => {
      if (q && !(row.itemName || '').toLowerCase().includes(q)) return false;
      return true;
    });

    const dir = state.sortDirection === 'asc' ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      const av = cellValue(a, state.sortColumn);
      const bv = cellValue(b, state.sortColumn);
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
    });

    state.filtered = rows;
    renderResults();
  }

  // ---------------------------------------------------------- calculation

  function setProgress(done, total, label) {
    els.progress.hidden = false;
    els.progressText.textContent = label;
    els.progressCount.textContent = `${fmtNumber(done)} / ${fmtNumber(total)}`;
    els.progressFill.style.width = total > 0 ? `${(done / total) * 100}%` : '0%';
  }

  /**
   * The Calculate button doubles as Cancel while a run is in flight, matching
   * the existing screen. It stays ENABLED throughout - a disabled button
   * swallows clicks, which is how the Assets refresh button ended up looking
   * dead.
   */
  async function calculate() {
    if (state.loading) {
      cancelCalculation();
      return;
    }

    if (!state.facilityId) {
      toast('Choose a manufacturing facility first', 'warning');
      return;
    }

    let progressDispose = null;

    state.loading = true;
    state.cancelling = false;
    state.calculated = false;
    state.selected = {};
    els.calculateBtn.classList.add('is-cancel');
    els.calculateLabel.textContent = 'Cancel';
    els.empty.hidden = true;
    els.results.hidden = true;
    els.resultsHead.hidden = true;

    try {
      // Progress arrives on its own channel - a callback cannot cross IPC.
      // Subscribed for the duration of this run only, and disposed in the
      // finally block so a second run cannot accumulate handlers.
      progressDispose = window.electronAPI.summary.onProgress((progress) => {
        setProgress(progress.done, progress.total, progress.label || 'Calculating…');
      });

      const result = await window.electronAPI.summary.calculate({
        blueprintFilter: state.blueprintFilter,
        characterFilter: state.characterFilter,
        characterId: state.characterId,
        marketSetId: state.marketSetId,
        facilityId: state.facilityId,
        reactionFacilityId: state.reactionFacilityId,
        svrPeriod: state.svrPeriod,
        speculativeInvention: state.specEnabled,
        decryptorStrategy: state.decryptorStrategy,

        // Pre-calculation filters: the engine uses these to decide which
        // blueprints to load and cost, and to drop rows below the market
        // thresholds. They are sent as arrays of the SELECTED keys.
        techLevels: selectedKeys(state.techLevels),
        categories: selectedKeys(state.categories),
        svrThreshold: state.svrThreshold,
        iphEnabled: state.iphEnabled,
        iphThreshold: state.iphThreshold,
        profitEnabled: state.profitEnabled,
        profitThreshold: state.profitThreshold,
      });

      // The handler reports a user-requested stop rather than throwing, so a
      // cancellation never reads as a failure.
      if (result && result.cancelled) {
        toast('Calculation cancelled', 'info');
        els.empty.hidden = false;
        els.emptyTitle.textContent = 'Calculation cancelled';
        els.emptyText.textContent = 'Press Calculate Summary to run it again.';
        return;
      }

      const rows = result && Array.isArray(result.rows) ? result.rows : [];
      state.results = rows;
      state.calculated = true;
      // The rows now match the chips, so the "recalculate" hint clears.
      state.filtersDirty = false;
      renderStaleNotice();
      renderFilters();
      applyFilters();

      toast(`Calculated ${fmtNumber(state.results.length)} blueprints`, 'success');
    } catch (error) {
      console.error('[summary] Calculation failed:', error);
      toast(`Calculation failed: ${error.message}`, 'error');
      els.empty.hidden = false;
      els.emptyTitle.textContent = 'Calculation failed';
      els.emptyText.textContent = error.message;
    } finally {
      // Dispose before anything else: leaving it subscribed would double the
      // progress handlers on the next run.
      if (progressDispose) progressDispose();
      state.loading = false;
      state.cancelling = false;
      els.calculateBtn.classList.remove('is-cancel');
      els.calculateBtn.disabled = false;
      els.calculateLabel.textContent = 'Calculate Summary';
      els.progress.hidden = true;
      await checkMarketDataAge();
    }
  }

  async function cancelCalculation() {
    if (state.cancelling) return;
    state.cancelling = true;
    els.calculateLabel.textContent = 'Cancelling…';
    try {
      await window.electronAPI.summary.cancel();
    } catch (error) {
      console.error('[summary] Could not cancel:', error);
    }
  }

  // --------------------------------------------------------- columns modal

  /**
   * Repaint drag affordances WITHOUT rebuilding the list.
   *
   * Binding rule 2a: a handler that re-renders during a drag destroys the very
   * element the drag started on, so the browser never delivers `drop` - the
   * rows looked draggable and simply snapped back. Rebuilding also resets
   * `scrollTop`, which is what threw the user to the top of the list on every
   * checkbox click. Toggle classes on the existing nodes instead.
   */
  function syncColumnDragState() {
    [...els.columnsList.children].forEach((row) => {
      const id = row.dataset.columnId;
      row.classList.toggle('is-dragging', state.dragColumn === id);
      row.classList.toggle(
        'is-drop-target',
        state.dropColumn === id && !!state.dragColumn && state.dragColumn !== id
      );
    });
  }

  /** Move a column in the order and re-sequence the DOM in place. */
  function moveColumn(fromId, toId) {
    if (!fromId || fromId === toId) return;

    const order = orderedColumns().map((c) => c.id);
    const from = order.indexOf(fromId);
    const to = order.indexOf(toId);
    if (from < 0 || to < 0) return;

    order.splice(to, 0, order.splice(from, 1)[0]);
    state.columnOrder = order;
    saveColumnConfig();
    // Live, like the checkbox toggles.
    renderResults();

    // Reorder the existing nodes rather than rebuilding: keeps scroll position
    // and every listener intact.
    const byId = new Map([...els.columnsList.children].map((row) => [row.dataset.columnId, row]));
    order.forEach((id) => {
      const row = byId.get(id);
      if (row) els.columnsList.appendChild(row);
    });
  }

  function renderColumnsModal() {
    els.columnsList.replaceChildren(...orderedColumns().map((col) => {
      const row = el('div', 'ms-column-row');
      row.draggable = true;
      row.dataset.columnId = col.id;

      row.appendChild(el('span', 'ms-column-grip', '⋮⋮'));

      const box = checkbox(state.visibleColumns.includes(col.id));
      box.style.pointerEvents = 'auto';
      box.addEventListener('change', () => {
        if (box.checked) {
          if (!state.visibleColumns.includes(col.id)) state.visibleColumns.push(col.id);
        } else {
          state.visibleColumns = state.visibleColumns.filter((id) => id !== col.id);
        }
        // The table updates live, matching the existing screen. Note this
        // repaints the RESULTS, never the modal list - rebuilding the list is
        // what reset its scroll position on every click.
        saveColumnConfig();
        renderResults();
      });
      row.appendChild(box);

      const label = el('span', 'ms-column-label', col.label);
      label.addEventListener('click', () => {
        box.checked = !box.checked;
        box.dispatchEvent(new Event('change'));
      });
      row.appendChild(label);

      row.addEventListener('dragstart', (e) => {
        state.dragColumn = col.id;
        // Required: without data on the transfer the browser cancels the drag
        // outright, so `drop` never fires no matter what else is correct.
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', col.id);
        }
        syncColumnDragState();
      });
      row.addEventListener('dragover', (e) => {
        // preventDefault marks this a valid drop target - without it `drop`
        // is never delivered.
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        if (state.dropColumn !== col.id) {
          state.dropColumn = col.id;
          syncColumnDragState();
        }
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const dragged = state.dragColumn
          || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
        moveColumn(dragged, col.id);
        state.dragColumn = null;
        state.dropColumn = null;
        syncColumnDragState();
      });
      row.addEventListener('dragend', () => {
        state.dragColumn = null;
        state.dropColumn = null;
        syncColumnDragState();
      });

      return row;
    }));
  }

  function openColumnsModal() {
    renderColumnsModal();
    els.columnsModal.hidden = false;
  }

  function closeColumnsModal() {
    els.columnsModal.hidden = true;
  }

  function applyColumns() {
    saveColumnConfig();
    closeColumnsModal();
    renderResults();
  }

  function resetColumns() {
    state.visibleColumns = defaultColumns();
    // Clearing the order is half the job - "Reset to Default" has to restore
    // the default SEQUENCE too, not just which columns are ticked.
    state.columnOrder = null;
    saveColumnConfig();
    // Rebuilding the modal list IS correct here: reset changes the whole
    // sequence, not just one row's state.
    renderColumnsModal();
    renderResults();
  }

  // ------------------------------------------------------------ plan modal

  /**
   * Which character owns the plan.
   *
   * Plans are per-character: getAll() FILTERS on the id, and create() takes it
   * as its first positional argument. Prefer the character selected on this
   * screen, otherwise the default one.
   */
  async function planCharacterId() {
    if (state.characterFilter === 'specific' && state.characterId) return state.characterId;
    try {
      const def = await window.electronAPI.esi.getDefaultCharacter();
      return def ? def.characterId : null;
    } catch (error) {
      console.error('[summary] Could not read the default character:', error);
      return null;
    }
  }

  async function openPlanModal() {
    const selected = state.filtered.filter((r) => state.selected[rowKey(r)]);
    if (selected.length === 0) return;

    els.planSummary.textContent = selected.length === 1
      ? `Add "${selected[0].itemName}" to a manufacturing plan.`
      : `Add ${fmtNumber(selected.length)} blueprints to a manufacturing plan.`;

    try {
      // getAll(characterId) filters on it - calling with nothing returns an
      // empty list, so the dropdown was always just "Create a new plan…".
      const plans = await window.electronAPI.plans.getAll(await planCharacterId());
      const options = [{ id: '__new__', name: 'Create a new plan…' }]
        .concat(Array.isArray(plans) ? plans : []);
      fillSelect(els.planSelect, options, (p) => p.planId || p.id, (p) => p.name, options[0].id);
    } catch (error) {
      console.error('[summary] Could not load plans:', error);
      fillSelect(els.planSelect, [{ id: '__new__', name: 'Create a new plan…' }],
        (p) => p.id, (p) => p.name, '__new__');
    }

    els.planNewWrap.hidden = els.planSelect.value !== '__new__';
    els.planModal.hidden = false;
  }

  function closePlanModal() {
    els.planModal.hidden = true;
  }

  async function confirmAddToPlan() {
    const selected = state.filtered.filter((r) => state.selected[rowKey(r)]);
    if (selected.length === 0) return;

    const runs = Math.max(1, parseInt(els.planRuns.value, 10) || 1);
    let planId = els.planSelect.value;

    try {
      if (planId === '__new__') {
        const name = els.planName.value.trim();
        if (!name) {
          toast('Give the new plan a name', 'warning');
          els.planName.focus();
          return;
        }
        // POSITIONAL args - (characterId, planName, description). Passing an
        // object put it in the characterId slot and dropped the name, so the
        // plan was created against a bogus owner under an auto-generated one.
        const created = await window.electronAPI.plans.create(
          await planCharacterId(), name, ''
        );
        planId = created && (created.planId || created.id);
        if (!planId) throw new Error('The plan was not created');
      }

      // Sequential by design: each add is a write, and a partial failure should
      // stop rather than race the rest in.
      for (const row of selected) {
        // The handler destructures meLevel/teLevel. `materialEfficiency` and
        // `timeEfficiency` were never read, so every blueprint went in with
        // an undefined ME.
        await window.electronAPI.plans.addBlueprint(planId, {
          blueprintTypeId: row.blueprintTypeId,
          runs,
          lines: 1,
          meLevel: row.meLevel,
          teLevel: row.teLevel,
          facilityId: state.facilityId,
        });
      }

      closePlanModal();
      state.selected = {};
      renderResults();
      toast(`Added ${fmtNumber(selected.length)} blueprint(s) to the plan`, 'success');
    } catch (error) {
      console.error('[summary] Could not add to plan:', error);
      toast(`Could not add to the plan: ${error.message}`, 'error');
    }
  }

  // ---------------------------------------------------------- search clear

  function clearSearch() {
    state.query = '';
    els.search.value = '';
    els.searchClear.hidden = true;
    els.search.focus();
    applyFilters();
  }

  // ----------------------------------------------------------------- mount

  async function mount(container, params, ctx) {
    // `state` is module-level and survives unmount, so a remount would
    // otherwise inherit the previous run's results and filters.
    state.loading = false;
    state.cancelling = false;
    state.calculated = false;
    state.results = [];
    state.filtered = [];
    state.selected = {};
    state.query = '';
    state.filtersDirty = false;
    state.sortColumn = 'profit';
    state.sortDirection = 'desc';
    state.columnOrder = null;

    // Back to defaults before loadSettings() runs, which reads the persisted
    // values from the config file. Chips and columns are seeded here too so a
    // failed load leaves a usable screen rather than an empty one.
    state.techLevels = toMap(null, TECH_LEVELS);
    state.categories = toMap(null, CATEGORIES);
    state.visibleColumns = defaultColumns();
    state.svrPeriod = 30;
    state.svrThreshold = null;
    state.iphEnabled = false;
    state.iphThreshold = null;
    state.profitEnabled = false;
    state.profitThreshold = null;
    state.specEnabled = false;
    state.decryptorStrategy = 'total-per-item';
    state.blueprintFilter = 'owned';
    state.characterFilter = 'all';
    state.characterId = null;
    state.savedFacilityId = null;
    state.savedReactionFacilityId = null;

    const response = await fetch('manufacturing-summary.view.html');
    container.innerHTML = await response.text();

    els = {
      root: container.querySelector('#summary-view'),
      bpFilters: container.querySelector('#ms-bp-filters'),
      charFilters: container.querySelector('#ms-char-filters'),
      charSelectWrap: container.querySelector('#ms-char-select-wrap'),
      charSelect: container.querySelector('#ms-char-select'),
      svrPeriod: container.querySelector('#ms-svr-period'),
      svrThreshold: container.querySelector('#ms-svr-threshold'),
      iphEnabled: container.querySelector('#ms-iph-enabled'),
      iphThreshold: container.querySelector('#ms-iph-threshold'),
      profitEnabled: container.querySelector('#ms-profit-enabled'),
      profitThreshold: container.querySelector('#ms-profit-threshold'),
      techChips: container.querySelector('#ms-tech-chips'),
      catChips: container.querySelector('#ms-cat-chips'),
      specEnabled: container.querySelector('#ms-spec-enabled'),
      decStrategyWrap: container.querySelector('#ms-dec-strategy-wrap'),
      decStrategy: container.querySelector('#ms-dec-strategy'),
      staleness: container.querySelector('#ms-staleness'),
      stalenessText: container.querySelector('#ms-staleness-text'),
      marketSet: container.querySelector('#ms-market-set'),
      facility: container.querySelector('#ms-facility'),
      reactionFacility: container.querySelector('#ms-reaction-facility'),
      calculateBtn: container.querySelector('#ms-calculate'),
      calculateLabel: container.querySelector('#ms-calculate-label'),
      progress: container.querySelector('#ms-progress'),
      progressText: container.querySelector('#ms-progress-text'),
      progressCount: container.querySelector('#ms-progress-count'),
      progressFill: container.querySelector('#ms-progress-fill'),
      resultsHead: container.querySelector('#ms-results-head'),
      resultCount: container.querySelector('#ms-result-count'),
      staleNotice: container.querySelector('#ms-stale-notice'),
      addToPlan: container.querySelector('#ms-add-to-plan'),
      addToPlanLabel: container.querySelector('#ms-add-to-plan-label'),
      columnsBtn: container.querySelector('#ms-columns-btn'),
      search: container.querySelector('#ms-search'),
      searchClear: container.querySelector('#ms-search-clear'),
      results: container.querySelector('#ms-results'),
      theadRow: container.querySelector('#ms-thead-row'),
      tbody: container.querySelector('#ms-tbody'),
      empty: container.querySelector('#ms-empty'),
      emptyTitle: container.querySelector('#ms-empty-title'),
      emptyText: container.querySelector('#ms-empty-text'),
      columnsModal: container.querySelector('#ms-columns-modal'),
      columnsList: container.querySelector('#ms-columns-list'),
      columnsClose: container.querySelector('#ms-columns-close'),
      columnsReset: container.querySelector('#ms-columns-reset'),
      columnsApply: container.querySelector('#ms-columns-apply'),
      planModal: container.querySelector('#ms-plan-modal'),
      planSummary: container.querySelector('#ms-plan-summary'),
      planSelect: container.querySelector('#ms-plan-select'),
      planNewWrap: container.querySelector('#ms-plan-new-wrap'),
      planName: container.querySelector('#ms-plan-name'),
      planRuns: container.querySelector('#ms-plan-runs'),
      planClose: container.querySelector('#ms-plan-close'),
      planCancel: container.querySelector('#ms-plan-cancel'),
      planConfirm: container.querySelector('#ms-plan-confirm'),
    };

    await loadSettings();
    await loadContext();
    renderContextSelectors();

    // Reflect the loaded settings in the controls. Every persisted field has
    // to be written back here or a restored value would never appear.
    els.specEnabled.checked = state.specEnabled;
    els.decStrategy.value = state.decryptorStrategy;

    els.svrPeriod.value = String(state.svrPeriod);
    // '' rather than 'null' when unset, and 0 must still render as "0".
    els.svrThreshold.value = state.svrThreshold == null ? '' : String(state.svrThreshold);
    els.iphEnabled.checked = state.iphEnabled;
    els.iphThreshold.value = state.iphThreshold == null ? '' : String(state.iphThreshold);
    els.profitEnabled.checked = state.profitEnabled;
    els.profitThreshold.value = state.profitThreshold == null ? '' : String(state.profitThreshold);

    // ---- listeners, all via ctx so remount cannot duplicate them
    ctx.on(els.calculateBtn, 'click', calculate);

    ctx.on(els.marketSet, 'change', async () => {
      state.marketSetId = els.marketSet.value;
      // Persisted per tool via toolPreferences, shared with the other tools -
      // deliberately NOT duplicated into this screen's own settings block.
      await window.electronAPI.market.setMarketSetForTool(
        'manufacturingSummary', state.marketSetId
      ).catch((error) => console.error('[summary] Could not save market set:', error));
      markFiltersDirty();
      await checkMarketDataAge();
    });

    // Facility and character changes alter what the next calculation costs,
    // so they persist and mark the current results stale.
    ctx.on(els.facility, 'change', () => {
      state.facilityId = els.facility.value;
      markFiltersDirty();
      saveSelections();
    });
    ctx.on(els.reactionFacility, 'change', () => {
      // '' is the "No Facility" placeholder, not a facility id.
      state.reactionFacilityId = els.reactionFacility.value || null;
      markFiltersDirty();
      saveSelections();
    });
    ctx.on(els.charSelect, 'change', () => {
      state.characterId = parseInt(els.charSelect.value, 10) || null;
      markFiltersDirty();
      saveSelections();
    });

    // Not a threshold: this is the lookback window fed INTO the SVR
    // calculation, so changing it invalidates the SVR column outright.
    ctx.on(els.svrPeriod, 'change', () => {
      state.svrPeriod = parseInt(els.svrPeriod.value, 10) || 30;
      markFiltersDirty();
      saveThresholdSettings();
    });
    // The three market thresholds are also PRE-CALCULATION inputs. They are
    // applied by the engine while costing, so like the chips they take effect
    // on the next Calculate and never re-filter rows already on screen.
    ctx.on(els.svrThreshold, 'input', () => {
      const v = parseFloat(els.svrThreshold.value);
      state.svrThreshold = v > 0 ? v : null;
      markFiltersDirty();
      saveThresholdSettings();
    });

    ctx.on(els.iphEnabled, 'change', () => {
      state.iphEnabled = els.iphEnabled.checked;
      // Enabling seeds the input at 0 (a blank box reads as "no threshold");
      // disabling empties it, so a greyed-out field never shows a stale value
      // the calculation is not using.
      state.iphThreshold = els.iphEnabled.checked ? 0 : null;
      els.iphThreshold.value = els.iphEnabled.checked ? '0' : '';
      renderControls();
      markFiltersDirty();
      saveThresholdSettings();
    });
    ctx.on(els.iphThreshold, 'input', () => {
      const v = parseFloat(els.iphThreshold.value);
      // 0 and negatives are meaningful here - only a blank/invalid box clears.
      state.iphThreshold = Number.isNaN(v) ? null : v;
      markFiltersDirty();
      saveThresholdSettings();
    });

    ctx.on(els.profitEnabled, 'change', () => {
      state.profitEnabled = els.profitEnabled.checked;
      state.profitThreshold = els.profitEnabled.checked ? 0 : null;
      els.profitThreshold.value = els.profitEnabled.checked ? '0' : '';
      renderControls();
      markFiltersDirty();
      saveThresholdSettings();
    });
    ctx.on(els.profitThreshold, 'input', () => {
      const v = parseFloat(els.profitThreshold.value);
      state.profitThreshold = Number.isNaN(v) ? null : v;
      markFiltersDirty();
      saveThresholdSettings();
    });

    ctx.on(els.specEnabled, 'change', async () => {
      state.specEnabled = els.specEnabled.checked;
      renderControls();
      await saveSpecSettings();
    });
    ctx.on(els.decStrategy, 'change', async () => {
      state.decryptorStrategy = els.decStrategy.value;
      renderControls();
      await saveSpecSettings();
    });
    ctx.on(els.search, 'input', () => {
      state.query = els.search.value;
      els.searchClear.hidden = state.query === '';
      applyFilters();
    });
    ctx.on(els.search, 'keydown', (e) => {
      if (e.key === 'Escape' && els.search.value !== '') {
        e.stopPropagation();
        clearSearch();
      }
    });
    ctx.on(els.searchClear, 'click', clearSearch);

    ctx.on(els.columnsBtn, 'click', openColumnsModal);
    ctx.on(els.columnsClose, 'click', closeColumnsModal);
    ctx.on(els.columnsApply, 'click', applyColumns);
    ctx.on(els.columnsReset, 'click', resetColumns);
    ctx.on(els.columnsModal, 'click', (e) => {
      if (e.target === els.columnsModal) closeColumnsModal();
    });

    ctx.on(els.addToPlan, 'click', openPlanModal);
    ctx.on(els.planClose, 'click', closePlanModal);
    ctx.on(els.planCancel, 'click', closePlanModal);
    ctx.on(els.planConfirm, 'click', confirmAddToPlan);
    ctx.on(els.planSelect, 'change', () => {
      els.planNewWrap.hidden = els.planSelect.value !== '__new__';
    });
    ctx.on(els.planModal, 'click', (e) => {
      if (e.target === els.planModal) closePlanModal();
    });

    ctx.on(document, 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!els.planModal.hidden) closePlanModal();
      else if (!els.columnsModal.hidden) closeColumnsModal();
    });

    render();
    await checkMarketDataAge();

    // Market refreshes elsewhere change how stale this screen's data is.
    const api = window.electronAPI.data;
    if (api && api.onMarketChanged) {
      ctx.track(api.onMarketChanged(() => {
        checkMarketDataAge().catch((error) =>
          console.error('[summary] Staleness check failed:', error));
      }));
    }

    return {
      /**
       * State to carry into a popped-out window.
       *
       * Only the RESULTS and how they are being viewed. A sweep over hundreds
       * of blueprints takes seconds, so recomputing it just to move a window is
       * not acceptable; the chips, market set and facility are re-read cheaply
       * from settings on mount and would only go stale if carried.
       *
       * Returns null with no results, so an unrun view pops out clean.
       */
      getHandoff() {
        if (!state.calculated || state.results.length === 0) return null;
        return {
          results: state.results,
          query: state.query,
          sortColumn: state.sortColumn,
          sortDirection: state.sortDirection,
        };
      },

      /** Adopt a popped-out window's results, skipping the sweep entirely. */
      applyHandoff(payload) {
        if (!payload || !Array.isArray(payload.results)) return;

        state.results = payload.results;
        state.calculated = true;
        // The rows came with the config that produced them, so the
        // "recalculate" hint must NOT be showing.
        state.filtersDirty = false;

        if (typeof payload.query === 'string') state.query = payload.query;
        if (payload.sortColumn) state.sortColumn = payload.sortColumn;
        if (payload.sortDirection) state.sortDirection = payload.sortDirection;

        if (els.search) els.search.value = state.query;

        renderStaleNotice();
        renderFilters();
        applyFilters();
      },
    };
  }

  function destroy() {
    els = {};
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('manufacturing-summary', {
      title: 'Manufacturing Summary',
      mount,
      destroy,
    });
  }
})();
