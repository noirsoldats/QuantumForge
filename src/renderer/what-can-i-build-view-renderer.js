/**
 * What Can I Build? view.
 *
 * Ported from `cleanup-tool-renderer.js`. Presentation follows
 * `What Can I Build (1a).dc.html`; behaviour follows the un-ported screen.
 *
 * The calculation moved to main (`what-can-i-build.js`) - the old renderer
 * priced every blueprint itself, one IPC call at a time. This one sends the
 * filters once and receives rows, with progress on its own channel.
 *
 * Changed deliberately during the port:
 *   - the nine `cleanup-tool-*` localStorage keys become one settings block,
 *     migrated once
 *   - Calculate doubles as Cancel while a run is in flight
 *   - column changes apply live; no Apply step
 *   - alert()/confirm() become toasts
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- config

  const TECH_LEVELS = ['T1', 'T2', 'T3', 'Storyline', 'Navy', 'Pirate'];

  /**
   * Thirteen, NOT the Summary's fourteen: reactions are not manufactured from
   * blueprints, so this screen has never offered a Reactions chip.
   */
  const CATEGORIES = [
    'Ships', 'Drones', 'Modules', 'Ammo/Charges', 'Components', 'Rigs',
    'Deployables', 'Subsystems', 'Structures', 'Structure Rigs',
    'Structure Modules', 'Boosters', 'Celestials',
  ];

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

  /** Column ids are part of the persisted config - do not rename them. */
  const ALL_COLUMNS = [
    { id: 'percent-on-hand', label: '% On-Hand', def: true, numeric: false, center: true },
    { id: 'buildable-qty', label: 'Buildable Qty', def: true, numeric: true },
    { id: 'category', label: 'Category', def: true },
    { id: 'name', label: 'Item Name', def: true },
    { id: 'owned', label: 'Owned?', def: true, center: true },
    { id: 'tech', label: 'Tech', def: true, center: true },
    { id: 'bp-type', label: 'BP Type', def: true, center: true },
    { id: 'me', label: 'ME', def: true, center: true },
    { id: 'te', label: 'TE', def: true, center: true },
    { id: 'profit', label: 'Profit', def: true, numeric: true },
    { id: 'isk-per-hour', label: 'ISK/Hour', def: true, numeric: true },
    { id: 'svr', label: 'SVR', def: true, numeric: true },
    { id: 'total-cost', label: 'Total Cost', def: true, numeric: true },
    { id: 'roi', label: 'ROI %', def: true, numeric: true },
    { id: 'owner', label: 'Owner', def: false },
    { id: 'location', label: 'Location', def: false },
    { id: 'product-market-price', label: 'Product Market Price', def: false, numeric: true },
  ];

  /**
   * LEGACY localStorage keys - READ ONCE, then deleted. Nothing writes them.
   *
   * `json` records how the un-ported screen stored each value. It matters:
   * blind JSON.parse would turn the string '75' into a number and, worse,
   * would turn an all-digit facility id into a Number and lose precision past
   * 2^53. Ids are opaque strings and must stay strings.
   */
  const LEGACY_KEYS = [
    { name: 'assetSources', key: 'cleanup-tool-asset-sources', json: true },
    { name: 'blueprintFilter', key: 'cleanup-tool-blueprint-filter', json: false },
    { name: 'characterFilter', key: 'cleanup-tool-character-filter', json: false },
    { name: 'characterId', key: 'cleanup-tool-selected-character', json: true },
    { name: 'facilityId', key: 'cleanup-tool-facility', json: false },
    { name: 'includeT2', key: 'cleanup-tool-include-t2-invention', json: false },
    { name: 'threshold', key: 'cleanup-tool-threshold', json: false },
    { name: 'chips', key: 'cleanup-tool-filters', json: true },
    { name: 'columns', key: 'cleanup-tool-columns', json: true },
    { name: 'sort', key: 'cleanup-tool-sort', json: true },
  ];

  // ----------------------------------------------------------------- state

  const state = {
    assetSources: [],
    expanded: {},
    corpExpanded: {},
    // No corp-level flag: corp assets are selected per DIVISION.
    selection: { personal: {}, divisions: {} },

    marketSets: [],
    marketSetId: null,
    facilities: [],
    facilityId: null,
    characters: [],

    blueprintFilter: 'owned',
    characterFilter: 'all',
    characterId: null,
    includeT2: false,
    threshold: 90,
    techLevels: {},
    categories: {},

    results: [],
    filtered: [],
    selected: {},
    query: '',
    sortColumn: 'profit',
    sortDirection: 'desc',
    visibleColumns: [],
    columnOrder: null,
    dragColumn: null,
    dropColumn: null,

    calculated: false,
    loading: false,
    cancelling: false,
    filtersDirty: false,
    // True for exactly one mount: the first launch after the port, when
    // readLegacy() found (and deleted) the old localStorage keys.
    migratedFromLocalStorage: false,
  };

  let els = {};
  let freshnessDispose = null;
  /** Set by selectedMarketTimestamp - see the note there. */
  let noMarketRegion = true;

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
      console.log(`[wcib] ${type || 'info'}: ${message}`);
    }
  }

  function fmtISK(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toFixed(0);
  }

  function fullISK(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '';
    return `${Math.round(n).toLocaleString()} ISK`;
  }

  function fmtNumber(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return Number(n).toLocaleString();
  }

  function defaultColumns() {
    return ALL_COLUMNS.filter((c) => c.def).map((c) => c.id);
  }

  function selectedKeys(map) {
    return Object.keys(map || {}).filter((k) => map[k]);
  }

  /** Saved array -> on/off map, dropping names that no longer exist. */
  function toMap(savedList, known) {
    if (!Array.isArray(savedList)) {
      return Object.fromEntries(known.map((k) => [k, true]));
    }
    const chosen = new Set(savedList);
    return Object.fromEntries(known.map((k) => [k, chosen.has(k)]));
  }

  function validColumns(ids) {
    if (!Array.isArray(ids)) return null;
    const valid = ids.filter((id) => ALL_COLUMNS.some((c) => c.id === id));
    return valid.length > 0 ? valid : null;
  }

  /**
   * Normalise a saved column order: drop unknown ids, collapse duplicates,
   * and APPEND any column the saved order predates - otherwise a release that
   * adds a column makes it unreachable for anyone with a stored order.
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

  function orderedColumns() {
    const order = state.columnOrder || ALL_COLUMNS.map((c) => c.id);
    return order.map((id) => ALL_COLUMNS.find((c) => c.id === id)).filter(Boolean);
  }

  function activeColumns() {
    return orderedColumns().filter((c) => state.visibleColumns.includes(c.id));
  }

  // ---------------------------------------------------------- persistence

  /**
   * Read the legacy localStorage values once and clear them.
   * Reads defensively: a corrupt value must not stop the screen loading.
   */
  function readLegacy() {
    const out = {};
    LEGACY_KEYS.forEach(({ name, key, json }) => {
      try {
        const raw = localStorage.getItem(key);
        if (raw !== null) {
          out[name] = json ? JSON.parse(raw) : raw;
        }
        localStorage.removeItem(key);
      } catch (error) {
        // A corrupt value must not stop the screen loading.
        console.error(`[wcib] could not migrate ${key}:`, error);
      }
    });
    return out;
  }

  async function loadSettings() {
    const legacy = readLegacy();
    let stored = {};

    try {
      const keys = [
        'blueprintFilter', 'characterFilter', 'characterId', 'facilityId',
        'includeT2Invention', 'threshold', 'assetSources', 'blueprintChips',
        'visibleColumns', 'columnOrder', 'sort',
      ];
      const values = await Promise.all(
        keys.map((k) => window.electronAPI.settings.get('whatCanIBuild', k))
      );
      keys.forEach((k, i) => { stored[k] = values[i]; });
    } catch (error) {
      console.error('[wcib] could not load settings:', error);
    }

    const chipsConfigured = stored.blueprintChips
      && (Array.isArray(stored.blueprintChips.tech)
        || Array.isArray(stored.blueprintChips.category));
    const chips = chipsConfigured ? stored.blueprintChips : legacy.chips;

    state.blueprintFilter = stored.blueprintFilter || legacy.blueprintFilter || 'owned';
    state.characterFilter = stored.characterFilter || legacy.characterFilter || 'all';
    state.characterId = stored.characterId ?? legacy.characterId ?? null;
    state.facilityId = stored.facilityId || legacy.facilityId || null;
    // The legacy value was the STRING 'true'/'false', not a boolean.
    state.includeT2 = stored.includeT2Invention != null
      ? stored.includeT2Invention === true
      : legacy.includeT2 === true || legacy.includeT2 === 'true';
    state.threshold = clampThreshold(
      stored.threshold != null ? stored.threshold : legacy.threshold
    );

    state.techLevels = toMap(chips && chips.tech, TECH_LEVELS);
    state.categories = toMap(chips && chips.category, CATEGORIES);
    state.visibleColumns = validColumns(stored.visibleColumns)
      || validColumns(legacy.columns)
      || defaultColumns();
    state.columnOrder = completeOrder(stored.columnOrder);

    const sort = stored.sort || legacy.sort;
    if (sort && sort.column) {
      state.sortColumn = sort.column;
      state.sortDirection = sort.direction === 'asc' ? 'asc' : 'desc';
    }

    state.savedAssetSources = stored.assetSources || legacy.assetSources || null;

    /*
     * Whether anything was actually lifted out of localStorage.
     *
     * readLegacy() DELETES the keys as it reads them, so it can only ever
     * return data once - on the first launch after the port. From then on
     * `legacy` is empty and no write-back is needed or wanted.
     *
     * The write itself happens in mount(), NOT here: saveSettings() derives
     * assetSources from state.selection, which loadAssetSources() has not
     * seeded yet at this point. Writing here clobbered the stored selection
     * with empties on every launch - invisible unless the process was killed
     * before the next interaction re-saved the real value.
     */
    state.migratedFromLocalStorage = Object.keys(legacy).length > 0;
  }

  function clampThreshold(value) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return 90;
    return Math.max(0, Math.min(100, n));
  }

  /**
   * Persist the whole block.
   *
   * settings:update merges only ONE level deep, so every field this screen
   * owns has to be written every time - an omitted key is destroyed.
   */
  async function saveSettings() {
    try {
      await window.electronAPI.settings.update('whatCanIBuild', {
        blueprintFilter: state.blueprintFilter,
        characterFilter: state.characterFilter,
        // Only meaningful for 'specific'; stored as null otherwise so a stale
        // id cannot resurface if the user switches back.
        characterId: state.characterFilter === 'specific' ? state.characterId : null,
        facilityId: state.facilityId,
        includeT2Invention: state.includeT2,
        threshold: state.threshold,
        assetSources: collectAssetSources(),
        blueprintChips: {
          tech: selectedKeys(state.techLevels),
          category: selectedKeys(state.categories),
        },
        visibleColumns: state.visibleColumns,
        columnOrder: state.columnOrder,
        sort: { column: state.sortColumn, direction: state.sortDirection },
      });
    } catch (error) {
      console.error('[wcib] could not save settings:', error);
    }
  }

  // ----------------------------------------------------------- asset tree

  async function loadAssetSources() {
    try {
      state.assetSources = await window.electronAPI.cleanupTool.getAssetSources() || [];
    } catch (error) {
      console.error('[wcib] could not load asset sources:', error);
      state.assetSources = [];
    }

    // Seed the selection: a saved one wins, otherwise everything the
    // character actually has, with corp divisions following their own
    // enabled flag from Settings.
    const saved = state.savedAssetSources;
    state.assetSources.forEach((source) => {
      const id = source.characterId;
      if (state.expanded[id] === undefined) state.expanded[id] = true;
      // Divisions open by default, as the mockup shows them - they are the
      // whole point of the corp row, and collapsing them hides which of the
      // seven are actually selected.
      if (state.corpExpanded[id] === undefined) state.corpExpanded[id] = true;

      if (saved) {
        state.selection.personal[id] = (saved.personal || [])
          .some((p) => String(p.characterId) === String(id));
        const corp = (saved.corporation || [])
          .find((c) => String(c.characterId) === String(id));
        (source.divisions || []).forEach((d) => {
          state.selection.divisions[`${id}:${d.id}`] =
            !!corp && (corp.divisions || []).map(Number).includes(Number(d.id));
        });
      } else {
        state.selection.personal[id] = true;
        // Divisions seed from their own enabled flag in Settings; there is no
        // corp-level selection to seed.
        (source.divisions || []).forEach((d) => {
          state.selection.divisions[`${id}:${d.id}`] = d.enabled === true;
        });
      }
    });
  }

  /**
   * The shape cleanupTool.aggregateAssets expects.
   *
   * Corp assets are included when at least one DIVISION is ticked - there is
   * no separate "all corporation assets" switch. Corp assets only ever exist
   * inside divisions, and `isInEnabledDivision` reads nothing for an empty
   * list, so a ticked corp box with no divisions looked enabled while
   * contributing zero assets.
   */
  function collectAssetSources() {
    const sources = { personal: [], corporation: [] };

    state.assetSources.forEach((source) => {
      const id = source.characterId;
      if (state.selection.personal[id]) sources.personal.push({ characterId: id });

      if (!source.hasCorpAssets) return;

      const divisions = (source.divisions || [])
        .filter((d) => state.selection.divisions[`${id}:${d.id}`])
        .map((d) => d.id);

      if (divisions.length > 0) sources.corporation.push({ characterId: id, divisions });
    });

    return sources;
  }

  function hasAnyAssetSource() {
    const s = collectAssetSources();
    return s.personal.length > 0 || s.corporation.length > 0;
  }

  function checkbox(checked) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.tabIndex = -1;
    return input;
  }

  function renderAssetTree() {
    if (state.assetSources.length === 0) {
      els.assetTree.replaceChildren(
        el('div', 'wcib-asset-empty', 'No characters found. Add characters in Settings.')
      );
      return;
    }

    els.assetTree.replaceChildren(...state.assetSources.map((source) => {
      const id = source.characterId;
      const wrap = el('div', 'wcib-asset-char');

      // --- character row
      const head = el('div', 'wcib-asset-char-head');
      const expand = el('button', `wcib-expand${state.expanded[id] ? ' is-open' : ''}`);
      expand.type = 'button';
      expand.setAttribute('aria-label', state.expanded[id] ? 'Collapse' : 'Expand');
      expand.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"></path></svg>';
      expand.addEventListener('click', () => {
        state.expanded[id] = !state.expanded[id];
        renderAssetTree();
      });
      head.appendChild(expand);

      if (source.portrait) {
        const avatar = document.createElement('img');
        avatar.className = 'wcib-avatar';
        avatar.src = `${source.portrait}?size=64`;
        avatar.alt = '';
        avatar.addEventListener('error', () => { avatar.style.visibility = 'hidden'; });
        head.appendChild(avatar);
      }
      head.appendChild(el('span', null, source.characterName));
      wrap.appendChild(head);

      if (!state.expanded[id]) return wrap;

      const children = el('div', 'wcib-asset-children');

      // --- personal
      const personal = el('div', 'wcib-asset-row');
      const personalBox = checkbox(state.selection.personal[id]);
      personal.appendChild(personalBox);
      personal.appendChild(el('span', null, 'Personal Assets'));
      personal.addEventListener('click', () => {
        state.selection.personal[id] = !state.selection.personal[id];
        personalBox.checked = state.selection.personal[id];
        saveSettings();
        markFiltersDirty();
      });
      children.appendChild(personal);

      /*
       * --- corporation
       *
       * A LABEL, not a checkbox. Corp assets live in divisions, so the
       * divisions are the only meaningful control; a corp-level tick either
       * duplicated them or - with no divisions ticked - read as enabled while
       * contributing nothing. Clicking the row expands rather than selects.
       */
      if (source.hasCorpAssets) {
        const corp = el('div', 'wcib-asset-row wcib-asset-corp');
        corp.appendChild(el(
          'span', 'wcib-corp-label',
          `Corporation Assets (${source.corporationName || 'Corp'})`
        ));

        const corpExpand = el('button', `wcib-expand${state.corpExpanded[id] ? ' is-open' : ''}`);
        corpExpand.type = 'button';
        corpExpand.setAttribute('aria-label', 'Toggle divisions');
        corpExpand.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"></path></svg>';
        corp.appendChild(corpExpand);

        corp.addEventListener('click', () => {
          state.corpExpanded[id] = !state.corpExpanded[id];
          renderAssetTree();
        });
        children.appendChild(corp);

        if (state.corpExpanded[id]) {
          const divisions = el('div', 'wcib-asset-divisions');
          (source.divisions || []).forEach((d) => {
            const key = `${id}:${d.id}`;
            const row = el('div', 'wcib-asset-row');
            const box = checkbox(state.selection.divisions[key]);
            row.appendChild(box);
            row.appendChild(el('span', null, d.name));
            row.addEventListener('click', () => {
              state.selection.divisions[key] = !state.selection.divisions[key];
              box.checked = state.selection.divisions[key];
              saveSettings();
              markFiltersDirty();
            });
            divisions.appendChild(row);
          });
          children.appendChild(divisions);
        }
      }

      wrap.appendChild(children);
      return wrap;
    }));
  }

  function setAllAssetSources(on) {
    state.assetSources.forEach((source) => {
      const id = source.characterId;
      state.selection.personal[id] = on;
      (source.divisions || []).forEach((d) => {
        state.selection.divisions[`${id}:${d.id}`] = on;
      });
    });
    renderAssetTree();
    saveSettings();
    markFiltersDirty();
  }

  async function refreshAssets() {
    const characterIds = state.assetSources.map((s) => s.characterId);
    if (characterIds.length === 0) {
      toast('No characters to refresh', 'warning');
      return;
    }

    els.assetsRefresh.disabled = true;
    try {
      const result = await window.electronAPI.cleanupTool.refreshAssets(characterIds);

      // The handler reports PER-CHARACTER failures in `errors[]` and leaves
      // `success` true, so checking success alone silently swallows them.
      const errors = (result && result.errors) || [];
      const refreshed = (result && result.refreshed) || [];

      if (errors.length > 0 && refreshed.length === 0) {
        toast(`Could not refresh assets: ${errors[0].error}`, 'error');
      } else if (errors.length > 0) {
        toast(`Refreshed ${refreshed.length}, ${errors.length} failed`, 'warning');
      } else {
        toast('Assets refreshed', 'success');
      }

      await loadAssetSources();
      renderAssetTree();
    } catch (error) {
      console.error('[wcib] could not refresh assets:', error);
      toast('Could not refresh assets from ESI', 'error');
    } finally {
      els.assetsRefresh.disabled = false;
    }
  }

  // -------------------------------------------------------------- context

  async function loadContext() {
    const [marketSets, facilities, characters, toolSet] = await Promise.all([
      window.electronAPI.market.getMarketSets().catch(() => []),
      window.electronAPI.facilities.getFacilities().catch(() => []),
      window.electronAPI.esi.getCharacters().catch(() => []),
      window.electronAPI.market.getMarketSetForTool('cleanupTool').catch(() => null),
    ]);

    state.marketSets = Array.isArray(marketSets) ? marketSets : [];
    state.facilities = Array.isArray(facilities) ? facilities : [];
    state.characters = Array.isArray(characters) ? characters : [];

    const defaultSet = (toolSet && toolSet.marketSet)
      || state.marketSets.find((s) => s.isDefault)
      || state.marketSets[0];
    state.marketSetId = defaultSet ? defaultSet.id : null;

    // A saved facility wins, but only if it still exists.
    const saved = state.facilityId
      && state.facilities.find((f) => String(f.id) === String(state.facilityId));
    const fallback = state.facilities.find((f) => f.usage === 'default')
      || state.facilities[0];
    const chosen = saved || fallback;
    state.facilityId = chosen ? chosen.id : null;

    // Drop a character selection whose character is gone.
    if (state.characterId
      && !state.characters.some((c) => String(c.characterId) === String(state.characterId))) {
      state.characterId = null;
      if (state.characterFilter === 'specific') state.characterFilter = 'all';
    }
  }

  // ------------------------------------------------------------- freshness

  /**
   * When the selected market set's region was last fetched.
   *
   * Re-reads the dashboard on every evaluation rather than closing over a
   * cached copy - a cached array is why the un-ported Loot Analyzer's warning
   * could never clear after a refresh.
   */
  async function selectedMarketTimestamp() {
    const set = state.marketSets.find((s) => String(s.id) === String(state.marketSetId));
    const regionId = set && set.inputMaterials && set.inputMaterials.regionId;

    // No market set chosen is not a staleness problem, but getFreshness()
    // maps null to level:'none' - the same value it uses for a region that
    // exists but was never fetched. Flag it so the badge stays hidden.
    if (!regionId) {
      noMarketRegion = true;
      return null;
    }
    noMarketRegion = false;

    try {
      const dashboard = await window.electronAPI.market.getRegionDashboard() || [];
      const region = dashboard.find((r) => r.regionId === regionId);
      state.marketRegionName = region ? region.regionName : `Region ${regionId}`;
      // A region with no data at all is worse than any age.
      return region && region.lastFetch ? region.lastFetch : null;
    } catch (error) {
      console.error('[wcib] could not read the region dashboard:', error);
      return null;
    }
  }

  function renderFreshness(freshness) {
    if (!els.marketWarning) return;

    if (noMarketRegion || !freshness || freshness.level === 'fresh') {
      els.marketWarning.hidden = true;
      els.marketWarning.classList.remove('is-stale');
      return;
    }

    const name = state.marketRegionName || 'the selected market';
    els.marketWarning.hidden = false;
    els.marketWarning.classList.toggle(
      'is-stale',
      freshness.level === 'stale' || freshness.level === 'none'
    );
    els.marketWarningText.textContent = freshness.level === 'none'
      ? `No market data for ${name} — profit figures cannot be trusted.`
      : `Market data for ${name} is ${freshness.label} old — profit figures may be stale.`;
  }

  function refreshFreshness() {
    if (!window.QFFreshness) return;
    if (freshnessDispose) freshnessDispose();
    freshnessDispose = window.QFFreshness.subscribe(
      selectedMarketTimestamp,
      renderFreshness,
      { market: true, cycle: true }
    );
  }

  function fillSelect(select, items, valueOf, labelOf, current) {
    select.replaceChildren(...items.map((item) => {
      const option = document.createElement('option');
      option.value = String(valueOf(item));
      option.textContent = labelOf(item);
      return option;
    }));
    if (current != null) select.value = String(current);
  }

  // ------------------------------------------------------------ rendering

  function chip(label, on, onClick, segment = false) {
    const classes = `wcib-chip${segment ? ' wcib-chip-seg' : ''}${on ? ' is-on' : ''}`;
    const node = el('button', classes, label);
    node.type = 'button';
    node.setAttribute('aria-pressed', on ? 'true' : 'false');
    node.addEventListener('click', onClick);
    return node;
  }

  function renderFilters() {
    els.bpFilters.replaceChildren(...BP_FILTERS.map(([id, label]) => chip(
      label, state.blueprintFilter === id,
      () => {
        state.blueprintFilter = id;
        renderFilters();
        saveSettings();
        markFiltersDirty();
      },
      true
    )));

    els.charFilters.replaceChildren(...CHAR_FILTERS.map(([id, label]) => chip(
      label, state.characterFilter === id,
      () => {
        state.characterFilter = id;
        renderFilters();
        saveSettings();
        markFiltersDirty();
      },
      true
    )));

    els.charSelectWrap.hidden = state.characterFilter !== 'specific';
    if (!els.charSelectWrap.hidden) {
      if (els.charSelect.options.length === 0) {
        fillSelect(
          els.charSelect, state.characters,
          (c) => c.characterId, (c) => c.characterName, state.characterId
        );
      }
      // Keep state and the visible selection in agreement, or the engine is
      // told 'specific' with no id and rejects the run.
      if (state.characterId) els.charSelect.value = String(state.characterId);
      else state.characterId = parseInt(els.charSelect.value, 10) || null;
    }

    // Tech and category chips choose which blueprints go INTO the
    // calculation; they do not filter rows already on screen.
    els.techChips.replaceChildren(...TECH_LEVELS.map((tech) => chip(
      tech, !!state.techLevels[tech],
      () => {
        state.techLevels[tech] = !state.techLevels[tech];
        renderFilters();
        saveSettings();
        markFiltersDirty();
      }
    )));

    els.catChips.replaceChildren(...CATEGORIES.map((cat) => chip(
      cat, !!state.categories[cat],
      () => {
        state.categories[cat] = !state.categories[cat];
        renderFilters();
        saveSettings();
        markFiltersDirty();
      }
    )));
  }

  /**
   * Chips changed, so the rows on screen were costed against a different
   * blueprint set. We do NOT re-filter them - that would imply the chips
   * subset the results when they actually change what gets loaded.
   */
  function markFiltersDirty() {
    state.filtersDirty = state.results.length > 0;
  }

  function percentClass(percent) {
    if (percent >= 100) return 'is-full';
    if (percent >= 75) return 'is-high';
    if (percent >= 50) return 'is-partial';
    return 'is-low';
  }

  function cellValue(row, columnId) {
    switch (columnId) {
      case 'percent-on-hand': return row.percentOnHand;
      case 'buildable-qty': return row.buildableRuns;
      case 'category': return row.category || 'Unknown';
      case 'name': return row.itemName || '';
      case 'owned': return row.isOwned ? 'Yes' : 'No';
      case 'tech': return row.tech || '';
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
      case 'product-market-price': return row.productMarketPrice;
      default: return '';
    }
  }

  function renderCell(row, columnId) {
    const value = cellValue(row, columnId);

    switch (columnId) {
      case 'percent-on-hand': {
        const node = el('span', `wcib-percent ${percentClass(value)}`);
        node.textContent = `${Math.round(value)}%`;
        return node;
      }
      case 'name': {
        const node = el('span', 'wcib-item-name', String(value));
        node.title = String(value);
        return node;
      }
      case 'category': {
        const node = el('span', 'wcib-category', String(value));
        node.title = String(value);
        return node;
      }
      case 'profit': {
        const node = el('span', `wcib-profit${(row.profit || 0) < 0 ? ' is-negative' : ''}`);
        node.textContent = fmtISK(row.profit);
        node.title = fullISK(row.profit);
        return node;
      }
      case 'isk-per-hour':
      case 'total-cost':
      case 'product-market-price': {
        const node = el('span', null, fmtISK(value));
        node.title = fullISK(value);
        return node;
      }
      case 'buildable-qty':
        return el('span', null, fmtNumber(value));
      case 'svr':
        return el('span', null, (Number(value) || 0).toFixed(2));
      case 'roi':
        return el('span', null, `${(Number(value) || 0).toFixed(1)}%`);
      case 'owner':
      case 'location':
        return value
          ? el('span', null, String(value))
          : el('span', 'wcib-muted', '—');
      default:
        return el('span', null, String(value));
    }
  }

  function applyFilters() {
    const q = state.query.trim().toLowerCase();

    // The ONLY live filter over results is the search box - the chips and the
    // threshold are inputs the engine has already applied.
    let rows = state.results.filter(
      (row) => !q || (row.itemName || '').toLowerCase().includes(q)
    );

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

  function rowKey(row) {
    return String(row.blueprintTypeId);
  }

  function renderResults() {
    const columns = activeColumns();

    els.theadRow.replaceChildren(...[
      (() => {
        const th = el('th', 'wcib-th is-center');
        const box = checkbox(
          state.filtered.length > 0
          && state.filtered.every((r) => state.selected[rowKey(r)])
        );
        box.tabIndex = 0;
        box.addEventListener('change', () => {
          const next = { ...state.selected };
          state.filtered.forEach((r) => { next[rowKey(r)] = box.checked; });
          state.selected = next;
          renderResults();
        });
        th.appendChild(box);
        return th;
      })(),
      ...columns.map((col) => {
        const active = state.sortColumn === col.id;
        const th = el(
          'th',
          `wcib-th sortable${col.numeric ? ' is-numeric' : ''}${col.center ? ' is-center' : ''}${active ? ' is-active' : ''}`
        );
        th.appendChild(document.createTextNode(`${col.label} `));
        th.appendChild(el(
          'span', 'wcib-sort-icon',
          active ? (state.sortDirection === 'asc' ? '↑' : '↓') : '↕'
        ));
        th.addEventListener('click', () => sortBy(col.id));
        return th;
      }),
    ]);

    const hasResults = state.filtered.length > 0;
    els.results.hidden = !hasResults;
    els.empty.hidden = hasResults;

    if (!hasResults) {
      // Clear rather than leaving stale rows hidden behind the empty state.
      els.tbody.replaceChildren();
      els.resultCount.textContent = '0 items';
      els.addToPlan.hidden = true;
      return;
    }

    els.tbody.replaceChildren(...state.filtered.map((row) => {
      const key = rowKey(row);
      const selected = !!state.selected[key];
      const tr = el('tr', `wcib-row${selected ? ' is-selected' : ''}`);

      const checkTd = el('td', 'wcib-td is-center');
      checkTd.appendChild(checkbox(selected));
      checkTd.addEventListener('click', () => {
        state.selected = { ...state.selected, [key]: !state.selected[key] };
        renderResults();
      });
      tr.appendChild(checkTd);

      columns.forEach((col) => {
        const td = el(
          'td',
          `wcib-td${col.numeric ? ' is-numeric' : ''}${col.center ? ' is-center' : ''}`
        );
        td.appendChild(renderCell(row, col.id));
        tr.appendChild(td);
      });

      return tr;
    }));

    els.resultCount.textContent =
      `${fmtNumber(state.filtered.length)} item${state.filtered.length === 1 ? '' : 's'}`;

    const selectedCount = state.filtered.filter((r) => state.selected[rowKey(r)]).length;
    els.addToPlan.hidden = selectedCount === 0;
    els.addToPlanLabel.textContent = `Add to Plan (${selectedCount})`;
  }

  function sortBy(columnId) {
    if (state.sortColumn === columnId) {
      state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
    } else {
      state.sortColumn = columnId;
      state.sortDirection = 'desc';
    }
    saveSettings();
    applyFilters();
  }

  // -------------------------------------------------------- columns modal

  /**
   * Repaint drag affordances WITHOUT rebuilding the list.
   *
   * Binding rule 2a: re-rendering during a drag destroys the element the drag
   * started on, so the browser never delivers `drop`. Rebuilding also resets
   * scrollTop, throwing the user to the top on every checkbox click.
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

  function moveColumn(fromId, toId) {
    if (!fromId || fromId === toId) return;

    const order = orderedColumns().map((c) => c.id);
    const from = order.indexOf(fromId);
    const to = order.indexOf(toId);
    if (from < 0 || to < 0) return;

    order.splice(to, 0, order.splice(from, 1)[0]);
    state.columnOrder = order;
    saveSettings();
    renderResults();

    // Reorder existing nodes rather than rebuilding: keeps scroll position
    // and every listener intact.
    const byId = new Map([...els.columnsList.children].map((r) => [r.dataset.columnId, r]));
    order.forEach((id) => {
      const row = byId.get(id);
      if (row) els.columnsList.appendChild(row);
    });
  }

  function renderColumnsModal() {
    els.columnsList.replaceChildren(...orderedColumns().map((col) => {
      const row = el('div', 'wcib-column-row');
      row.draggable = true;
      row.dataset.columnId = col.id;

      row.appendChild(el('span', 'wcib-column-grip', '⋮⋮'));

      const box = checkbox(state.visibleColumns.includes(col.id));
      box.addEventListener('change', () => {
        if (box.checked) {
          if (!state.visibleColumns.includes(col.id)) state.visibleColumns.push(col.id);
        } else {
          state.visibleColumns = state.visibleColumns.filter((id) => id !== col.id);
        }
        // Repaints the RESULTS, never the modal list.
        saveSettings();
        renderResults();
      });
      row.appendChild(box);

      const label = el('span', 'wcib-column-label', col.label);
      label.addEventListener('click', () => {
        box.checked = !box.checked;
        box.dispatchEvent(new Event('change'));
      });
      row.appendChild(label);

      row.addEventListener('dragstart', (e) => {
        state.dragColumn = col.id;
        // Without data on the transfer the browser cancels the drag outright,
        // so `drop` never fires no matter what else is correct.
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', col.id);
        }
        syncColumnDragState();
      });
      row.addEventListener('dragover', (e) => {
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

  function resetColumns() {
    state.visibleColumns = defaultColumns();
    // Reset restores the default SEQUENCE too, not just which are ticked.
    state.columnOrder = null;
    saveSettings();
    renderColumnsModal();
    renderResults();
  }

  // ------------------------------------------------------------- calculate

  function setProgress(done, total, label) {
    els.progress.hidden = false;
    els.progressText.textContent = label || 'Calculating…';
    els.progressCount.textContent = total > 0 ? `${done}/${total}` : '';
    els.progressFill.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%';
  }

  async function calculate() {
    if (state.loading) {
      cancelCalculation();
      return;
    }

    if (!state.facilityId) {
      toast('Choose a facility first', 'warning');
      return;
    }
    if (!hasAnyAssetSource()) {
      toast('Select at least one asset source', 'warning');
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

    try {
      progressDispose = window.electronAPI.wcib.onProgress((progress) => {
        setProgress(progress.done, progress.total, progress.label);
      });

      const result = await window.electronAPI.wcib.calculate({
        blueprintFilter: state.blueprintFilter,
        characterFilter: state.characterFilter,
        characterId: state.characterId,
        marketSetId: state.marketSetId,
        facilityId: state.facilityId,
        threshold: state.threshold,
        assetSources: collectAssetSources(),
        speculativeInvention: state.includeT2,
        techLevels: selectedKeys(state.techLevels),
        categories: selectedKeys(state.categories),
      });

      if (result && result.cancelled) {
        toast('Calculation cancelled', 'info');
        els.empty.hidden = false;
        els.emptyTitle.textContent = 'Calculation cancelled';
        els.emptyText.textContent = 'Press Calculate Buildable Items to run it again.';
        return;
      }

      state.results = (result && Array.isArray(result.rows)) ? result.rows : [];
      state.calculated = true;
      state.filtersDirty = false;

      if (state.results.length === 0) {
        els.empty.hidden = false;
        els.emptyTitle.textContent = 'Nothing buildable';
        els.emptyText.textContent =
          `No blueprints reach ${state.threshold}% on-hand with the selected sources. `
          + 'Try lowering the threshold or selecting more asset sources.';
        els.results.hidden = true;
        els.tbody.replaceChildren();
        return;
      }

      applyFilters();
      toast(`Found ${fmtNumber(state.results.length)} buildable items`, 'success');
    } catch (error) {
      console.error('[wcib] calculation failed:', error);
      toast(`Calculation failed: ${error.message}`, 'error');
      els.empty.hidden = false;
      els.emptyTitle.textContent = 'Calculation failed';
      els.emptyText.textContent = error.message;
    } finally {
      if (progressDispose) progressDispose();
      state.loading = false;
      state.cancelling = false;
      els.calculateBtn.classList.remove('is-cancel');
      els.calculateLabel.textContent = 'Calculate Buildable Items';
      els.progress.hidden = true;
    }
  }

  async function cancelCalculation() {
    if (state.cancelling) return;
    state.cancelling = true;
    els.calculateLabel.textContent = 'Cancelling…';
    try {
      await window.electronAPI.wcib.cancel();
    } catch (error) {
      console.error('[wcib] could not cancel:', error);
    }
  }

  // ------------------------------------------------------------ plan modal

  /**
   * Which character owns the plan.
   *
   * Plans are per-character. Prefer the one the user has actually selected on
   * this screen, otherwise the default character.
   */
  async function planCharacterId() {
    if (state.characterFilter === 'specific' && state.characterId) return state.characterId;
    try {
      const def = await window.electronAPI.esi.getDefaultCharacter();
      return def ? def.characterId : null;
    } catch (error) {
      console.error('[wcib] could not read the default character:', error);
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
      // Plans are per-character - getAll(characterId) filters on it, so
      // calling with nothing returns an empty list.
      const plans = await window.electronAPI.plans.getAll(await planCharacterId());
      const options = [{ id: '__new__', name: 'Create a new plan…' }]
        .concat(Array.isArray(plans) ? plans : []);
      fillSelect(els.planSelect, options, (p) => p.planId || p.id, (p) => p.name, options[0].id);
    } catch (error) {
      console.error('[wcib] could not load plans:', error);
      fillSelect(
        els.planSelect, [{ id: '__new__', name: 'Create a new plan…' }],
        (p) => p.id, (p) => p.name, '__new__'
      );
    }

    els.planNewWrap.hidden = els.planSelect.value !== '__new__';
    els.planModal.hidden = false;
  }

  function closePlanModal() {
    els.planModal.hidden = true;
  }

  async function confirmPlan() {
    const selected = state.filtered.filter((r) => state.selected[rowKey(r)]);
    if (selected.length === 0) return;

    const runs = Math.max(1, parseInt(els.planRuns.value, 10) || 1);
    els.planConfirm.disabled = true;

    try {
      let planId = els.planSelect.value;

      if (planId === '__new__') {
        const name = els.planName.value.trim()
          || `Buildable ${new Date().toLocaleDateString()}`;
        // POSITIONAL args - (characterId, planName, description). Passing an
        // object puts it in the characterId slot and drops the name, so the
        // plan is created against a bogus owner under an auto-generated name.
        const created = await window.electronAPI.plans.create(
          await planCharacterId(), name, ''
        );
        planId = created && (created.planId || created.id);
        if (!planId) throw new Error('The plan could not be created');
      }

      for (const row of selected) {
        await window.electronAPI.plans.addBlueprint(planId, {
          blueprintTypeId: row.blueprintTypeId,
          runs,
          meLevel: row.meLevel,
          teLevel: row.teLevel,
          facilityId: state.facilityId,
        });
      }

      closePlanModal();
      toast(`Added ${fmtNumber(selected.length)} blueprints to the plan`, 'success');
    } catch (error) {
      console.error('[wcib] could not add to plan:', error);
      toast(`Could not add to plan: ${error.message}`, 'error');
    } finally {
      els.planConfirm.disabled = false;
    }
  }

  // ------------------------------------------------------------------ mount

  async function mount(container, params, ctx) {
    // `state` is module-level and survives unmount.
    state.results = [];
    state.filtered = [];
    state.selected = {};
    state.query = '';
    state.calculated = false;
    state.loading = false;
    state.cancelling = false;
    state.filtersDirty = false;
    state.expanded = {};
    state.corpExpanded = {};
    state.selection = { personal: {}, divisions: {} };
    state.dragColumn = null;
    state.dropColumn = null;
    noMarketRegion = true;

    await QFUI.loadViewTemplate(container, 'what-can-i-build.view.html');

    const $ = (id) => container.querySelector(`#${id}`);

    els = {
      assetTree: $('wcib-asset-tree'),
      assetsAll: $('wcib-assets-all'),
      assetsNone: $('wcib-assets-none'),
      assetsRefresh: $('wcib-assets-refresh'),
      bpFilters: $('wcib-bp-filters'),
      charFilters: $('wcib-char-filters'),
      charSelectWrap: $('wcib-char-select-wrap'),
      charSelect: $('wcib-char-select'),
      includeT2: $('wcib-include-t2'),
      techChips: $('wcib-tech-chips'),
      catChips: $('wcib-cat-chips'),
      thresholdRange: $('wcib-threshold-range'),
      threshold: $('wcib-threshold'),
      marketSet: $('wcib-market-set'),
      facility: $('wcib-facility'),
      calculateBtn: $('wcib-calculate'),
      calculateLabel: $('wcib-calculate-label'),
      marketWarning: $('wcib-market-warning'),
      marketWarningText: $('wcib-market-warning-text'),
      progress: $('wcib-progress'),
      progressText: $('wcib-progress-text'),
      progressCount: $('wcib-progress-count'),
      progressFill: $('wcib-progress-fill'),
      empty: $('wcib-empty'),
      emptyTitle: $('wcib-empty-title'),
      emptyText: $('wcib-empty-text'),
      results: $('wcib-results'),
      resultCount: $('wcib-result-count'),
      addToPlan: $('wcib-add-to-plan'),
      addToPlanLabel: $('wcib-add-to-plan-label'),
      columnsBtn: $('wcib-columns-btn'),
      search: $('wcib-search'),
      searchClear: $('wcib-search-clear'),
      theadRow: $('wcib-thead-row'),
      tbody: $('wcib-tbody'),
      columnsModal: $('wcib-columns-modal'),
      columnsClose: $('wcib-columns-close'),
      columnsList: $('wcib-columns-list'),
      columnsReset: $('wcib-columns-reset'),
      columnsApply: $('wcib-columns-apply'),
      planModal: $('wcib-plan-modal'),
      planClose: $('wcib-plan-close'),
      planSummary: $('wcib-plan-summary'),
      planSelect: $('wcib-plan-select'),
      planNewWrap: $('wcib-plan-new-wrap'),
      planName: $('wcib-plan-name'),
      planRuns: $('wcib-plan-runs'),
      planCancel: $('wcib-plan-cancel'),
      planConfirm: $('wcib-plan-confirm'),
    };

    await loadSettings();
    await loadAssetSources();
    await loadContext();

    /*
     * Persist the migration - ONCE, and only if one actually happened.
     *
     * readLegacy() deletes the localStorage keys as it reads them, so this
     * can only be true on the first launch after the port; every mount after
     * that skips the write entirely.
     *
     * It runs here rather than in loadSettings() because saveSettings()
     * derives assetSources from state.selection, which is only seeded by
     * loadAssetSources() above.
     */
    if (state.migratedFromLocalStorage) {
      await saveSettings();
      state.migratedFromLocalStorage = false;
    }

    fillSelect(els.marketSet, state.marketSets, (s) => s.id, (s) => s.name, state.marketSetId);
    fillSelect(els.facility, state.facilities, (f) => f.id, (f) => f.name, state.facilityId);

    els.includeT2.checked = state.includeT2;
    els.threshold.value = String(state.threshold);
    els.thresholdRange.value = String(state.threshold);

    renderAssetTree();
    renderFilters();
    renderResults();

    // ---- listeners, all via ctx so a remount cannot duplicate them
    ctx.on(els.calculateBtn, 'click', calculate);
    ctx.on(els.assetsAll, 'click', () => setAllAssetSources(true));
    ctx.on(els.assetsNone, 'click', () => setAllAssetSources(false));
    ctx.on(els.assetsRefresh, 'click', refreshAssets);

    ctx.on(els.marketSet, 'change', async () => {
      state.marketSetId = els.marketSet.value;
      await window.electronAPI.market.setMarketSetForTool('cleanupTool', state.marketSetId)
        .catch((error) => console.error('[wcib] could not save market set:', error));
      markFiltersDirty();
      // A different set may point at a different region, so re-evaluate.
      refreshFreshness();
    });

    ctx.on(els.facility, 'change', () => {
      state.facilityId = els.facility.value;
      saveSettings();
      markFiltersDirty();
    });

    ctx.on(els.charSelect, 'change', () => {
      state.characterId = parseInt(els.charSelect.value, 10) || null;
      saveSettings();
      markFiltersDirty();
    });

    ctx.on(els.includeT2, 'change', () => {
      state.includeT2 = els.includeT2.checked;
      saveSettings();
      markFiltersDirty();
    });

    // The slider and the number box are two views of one value.
    const setThreshold = (raw) => {
      state.threshold = clampThreshold(raw);
      els.threshold.value = String(state.threshold);
      els.thresholdRange.value = String(state.threshold);
      saveSettings();
      markFiltersDirty();
    };
    ctx.on(els.thresholdRange, 'input', () => setThreshold(els.thresholdRange.value));
    ctx.on(els.threshold, 'input', () => setThreshold(els.threshold.value));

    ctx.on(els.search, 'input', () => {
      state.query = els.search.value;
      els.searchClear.hidden = state.query === '';
      applyFilters();
    });
    ctx.on(els.searchClear, 'click', () => {
      state.query = '';
      els.search.value = '';
      els.searchClear.hidden = true;
      els.search.focus();
      applyFilters();
    });
    ctx.on(els.search, 'keydown', (e) => {
      if (e.key === 'Escape') {
        state.query = '';
        els.search.value = '';
        els.searchClear.hidden = true;
        applyFilters();
      }
    });

    ctx.on(els.columnsBtn, 'click', () => {
      renderColumnsModal();
      els.columnsModal.hidden = false;
    });
    ctx.on(els.columnsClose, 'click', () => { els.columnsModal.hidden = true; });
    ctx.on(els.columnsApply, 'click', () => { els.columnsModal.hidden = true; });
    ctx.on(els.columnsReset, 'click', resetColumns);

    ctx.on(els.addToPlan, 'click', openPlanModal);
    ctx.on(els.planClose, 'click', closePlanModal);
    ctx.on(els.planCancel, 'click', closePlanModal);
    ctx.on(els.planConfirm, 'click', confirmPlan);
    ctx.on(els.planSelect, 'change', () => {
      els.planNewWrap.hidden = els.planSelect.value !== '__new__';
    });

    // Backdrop click and Escape close through the same path as the X.
    [els.columnsModal, els.planModal].forEach((modal) => {
      ctx.on(modal, 'click', (e) => {
        if (e.target === modal) modal.hidden = true;
      });
    });
    ctx.on(document, 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!els.columnsModal.hidden) els.columnsModal.hidden = true;
      else if (!els.planModal.hidden) closePlanModal();
    });

    refreshFreshness();

    return {
      destroy() {
        // The freshness subscription owns bus listeners AND an interval, so
        // leaving it attached would keep re-reading the dashboard forever.
        // (The progress handler is disposed in calculate()'s finally block.)
        if (freshnessDispose) {
          freshnessDispose();
          freshnessDispose = null;
        }
      },

      /**
       * State to carry into a popped-out window.
       *
       * Only the RESULTS and how they are being viewed. A sweep takes seconds
       * over hundreds of blueprints, so recomputing it just to move a window
       * is not acceptable - but everything else (asset sources, facilities,
       * market sets) is loaded cheaply from settings on mount, and re-reading
       * it keeps the new window honest if something changed meanwhile.
       *
       * Returns null with no results, so an unrun view pops out clean rather
       * than parking an empty payload.
       */
      getHandoff() {
        if (!state.calculated || state.results.length === 0) return null;
        return {
          results: state.results,
          threshold: state.threshold,
          query: state.query,
          sortColumn: state.sortColumn,
          sortDirection: state.sortDirection,
          selected: state.selected,
        };
      },

      /** Adopt a popped-out window's results and re-render, skipping calculate(). */
      applyHandoff(payload) {
        if (!payload || !Array.isArray(payload.results)) return;

        state.results = payload.results;
        state.calculated = true;
        // The config that produced these rows came with them, so the filter
        // bar is NOT dirty - the results match what the controls show.
        state.filtersDirty = false;

        if (typeof payload.threshold === 'number') state.threshold = payload.threshold;
        if (typeof payload.query === 'string') state.query = payload.query;
        if (payload.sortColumn) state.sortColumn = payload.sortColumn;
        if (payload.sortDirection) state.sortDirection = payload.sortDirection;
        if (payload.selected) state.selected = payload.selected;

        // Sync the controls, not just state: these read from the DOM, so a
        // stale input would disagree with the results and feed a wrong value
        // into the next calculation.
        if (els.search) els.search.value = state.query;
        // Both halves: the number input and the slider mirror each other, so
        // updating one alone leaves them visibly disagreeing.
        if (els.threshold) els.threshold.value = String(state.threshold);
        if (els.thresholdRange) els.thresholdRange.value = String(state.threshold);

        applyFilters();
      },
    };
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('what-can-i-build', {
      title: 'What Can I Build?',
      mount,
    });
  }
})();
