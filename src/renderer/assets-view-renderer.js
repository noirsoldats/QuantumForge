/**
 * Asset Manager — native shell view.
 *
 * Ported from "Character Assets (1a).dc.html". Replaces the card list in
 * assets-renderer.js with a sortable/groupable table, faceted filtering, and
 * real ISK valuation.
 *
 * Behaviours carried over from the old screen (all still here):
 *   - character + corporation tabs, corp tab only when the character has a corp
 *   - search by item name
 *   - "Refresh from API" with a spinner and a disabled button while in flight
 *   - cache-expiry countdown, refreshed on a timer
 *   - blueprint-copy marking
 *   - full location path (station - container - container)
 *
 * Deliberately NOT carried over: the three "show blueprints / ships / modules"
 * checkboxes. They never worked - the old applyFilters() returned true for any
 * asset whenever ships or modules was checked (a `// Placeholder` in the
 * source), so the filter silently did nothing. Real SDE-backed category facets
 * replace them.
 *
 * ESI DISCIPLINE: every per-asset lookup is batched. Locations go through
 * location.resolveMany and prices through market.calculatePrices, both deduped
 * in main. A per-item loop here is what made this screen exhaust ESI's
 * application-wide error budget and take the background refresh cycle down.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------- state

  const state = {
    characterId: null,
    character: null,
    tab: 'character',
    assets: { character: [], corporation: [] },
    priced: false,
    loading: true,

    query: '',
    cats: {},
    locs: {},
    bp: {},
    groupBy: 'location',
    aggregate: false,
    sortCol: 'value',
    sortDir: 'desc',
    selected: {},
    collapsed: {},

    hiddenCols: {},
    colOrder: null,
    dragCol: null,
    dropCol: null,

    marketSetId: null,
    marketSets: [],

    /** Persisted view presets: [{ id, name, config }] */
    savedViews: [],
    /** id of the applied saved view, or null for the default "All Assets". */
    activeViewId: null,
  };

  let els = {};
  let viewCtx = null;

  // --------------------------------------------------------------- columns

  const ALL_COLUMNS = [
    { id: 'name', label: 'Item', numeric: false, def: true },
    { id: 'qty', label: 'Qty', numeric: true, def: true },
    { id: 'category', label: 'Category', numeric: false, def: true },
    { id: 'location', label: 'Location', numeric: false, def: true },
    { id: 'flag', label: 'Flag', numeric: false, def: true },
    { id: 'volume', label: 'Volume', numeric: true, def: true },
    { id: 'value', label: 'Est. Value', numeric: true, def: true },
  ];

  function isColumnVisible(col) {
    return state.hiddenCols[col.id] !== undefined ? !state.hiddenCols[col.id] : col.def;
  }

  function orderedColumns() {
    const order = state.colOrder || ALL_COLUMNS.map((c) => c.id);
    return order.map((id) => ALL_COLUMNS.find((c) => c.id === id)).filter(Boolean);
  }

  function visibleColumns() {
    return orderedColumns().filter(isColumnVisible);
  }

  // ------------------------------------------------------------ formatting

  function fmtNumber(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
  }

  function fmtVolume(v) {
    const n = Number(v) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M m³`;
    if (abs >= 1000) return `${(n / 1000).toFixed(1)}K m³`;
    return `${(Math.round(n * 100) / 100).toLocaleString('en-US')} m³`;
  }

  function fmtISK(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
    return fmtNumber(v);
  }

  function fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (s < 60) return `${s}s`;
    const minutes = Math.floor(s / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  // --------------------------------------------------------------- helpers

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function svg(paths, size, extraClass) {
    const ns = 'http://www.w3.org/2000/svg';
    const node = document.createElementNS(ns, 'svg');
    node.setAttribute('width', size);
    node.setAttribute('height', size);
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '2');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    if (extraClass) node.setAttribute('class', extraClass);
    paths.forEach((d) => {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      node.appendChild(p);
    });
    return node;
  }

  function checkbox(checked) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    // The row's own click handler owns the toggle; without this the click
    // lands twice and the state flips back.
    input.style.pointerEvents = 'none';
    input.tabIndex = -1;
    return input;
  }

  /**
   * Show a toast.
   *
   * QFToast exposes show(message, type) - there is NO QFToast.info()/.success()
   * per-type method. Calling one was a silent TypeError, so every toast on this
   * screen did nothing at all.
   */
  function toast(message, type = 'info') {
    if (window.QFToast && typeof window.QFToast.show === 'function') {
      window.QFToast.show(message, type);
    } else {
      console.log(`[assets] ${message}`);
    }
  }

  /**
   * Full location breadcrumb for one item: "Cargo → Golem → Sotiyo".
   *
   * Resolved locations are cached per location id and shared by every item
   * there, but `location_flag` belongs to the ITEM ("Cargo", "MedSlot6"), so
   * the innermost hop can only be completed here.
   *
   * Reads innermost-first: the item's own flag, then each container from inner
   * to outer, then the place - "Cargo → Golem → Sotiyo".
   *
   * Only the ITEM's flag appears. Naming the containers already says where the
   * item is, and interleaving their own flags produced confusing repetition on
   * nested chains ("Cargo → Station Container → Cargo → Golem" - both flags
   * really are "Cargo", which reads as a rendering fault).
   *
   * Items sitting directly in a station have no containers, so the label is
   * just the station - no misleading "Hangar → " prefix.
   *
   * Mirrors buildChainLabel() in location-resolver.js; keep the two in step.
   */
  function buildChainLabel(locationInfo, itemFlag) {
    if (!locationInfo) return 'Unknown';

    const place = locationInfo.stationName || locationInfo.systemName || 'Unknown';
    const path = locationInfo.containerPath || [];
    if (path.length === 0) return place;

    // containerNames is outermost-first; read it inner-to-outer.
    const innerNames = [...(locationInfo.containerNames || [])].reverse();

    const segments = [];
    if (itemFlag) segments.push(itemFlag);
    innerNames.forEach((name, i) => segments.push(name || `Container ${i + 1}`));
    segments.push(place);

    return segments.join(' → ');
  }

  // ------------------------------------------------------------ categories

  /**
   * Map an SDE category/group to a facet bucket.
   *
   * Keyed on categoryID/groupID, never categoryName: the SDE returns
   * "Material" as the category name for a great many unrelated things, which
   * is what made an earlier attempt at this classify everything identically.
   */
  const CATEGORY_IDS = {
    SHIP: 6,
    MODULE: 7,
    CHARGE: 8,
    BLUEPRINT: 9,
    MATERIAL: 4,
    DRONE: 18,
    IMPLANT: 20,
    COMMODITY: 17,
    STRUCTURE: 65,
    STRUCTURE_MODULE: 66,
  };

  /** Mineral groups inside the Material category. */
  const MINERAL_GROUP_IDS = new Set([18 /* Mineral */, 427 /* Moon Materials */]);

  const BUCKET_LABELS = {
    ship: 'Ships',
    module: 'Modules',
    charge: 'Charges',
    blueprint: 'Blueprints',
    mineral: 'Minerals',
    component: 'Components',
    drone: 'Drones',
    implant: 'Implants',
    structure: 'Structures',
    other: 'Other',
  };

  function bucketFor(info) {
    if (!info) return 'other';
    const cat = Number(info.categoryID);
    const group = Number(info.groupID);

    switch (cat) {
      case CATEGORY_IDS.SHIP: return 'ship';
      case CATEGORY_IDS.MODULE: return 'module';
      case CATEGORY_IDS.CHARGE: return 'charge';
      case CATEGORY_IDS.BLUEPRINT: return 'blueprint';
      case CATEGORY_IDS.DRONE: return 'drone';
      case CATEGORY_IDS.IMPLANT: return 'implant';
      case CATEGORY_IDS.STRUCTURE:
      case CATEGORY_IDS.STRUCTURE_MODULE: return 'structure';
      case CATEGORY_IDS.MATERIAL:
        return MINERAL_GROUP_IDS.has(group) ? 'mineral' : 'component';
      case CATEGORY_IDS.COMMODITY: return 'component';
      default: return 'other';
    }
  }

  // ------------------------------------------------------------ data load

  async function loadAssets() {
    state.loading = true;
    render();

    const characterId = state.characterId;

    const [charAssets, corpAssets] = await Promise.all([
      window.electronAPI.assets.get(characterId, false).catch((error) => {
        console.error('[assets] Could not load character assets:', error);
        return [];
      }),
      state.character && state.character.corporationId
        ? window.electronAPI.assets.get(characterId, true).catch((error) => {
            console.error('[assets] Could not load corporation assets:', error);
            return [];
          })
        : Promise.resolve([]),
    ]);

    state.assets.character = Array.isArray(charAssets) ? charAssets : [];
    state.assets.corporation = Array.isArray(corpAssets) ? corpAssets : [];

    const all = [...state.assets.character, ...state.assets.corporation];
    const typeIds = [...new Set(all.map((a) => a.typeId))];

    // Names, categories and volumes: three batched SDE reads for the whole set.
    const [names, categories, volumes] = await Promise.all([
      window.electronAPI.sde.getTypeNames(typeIds).catch(() => ({})),
      window.electronAPI.sde.getTypeCategoryInfo(typeIds).catch(() => ({})),
      window.electronAPI.sde.getItemVolumes(typeIds).catch(() => ({})),
    ]);

    // Locations: ONE call per ownership scope, deduped by location id in main.
    // Previously this awaited once per asset - a thousand round-trips, each
    // able to fire a structure lookup whose 403s spent the ESI error budget.
    const [charLocations, corpLocations] = await Promise.all([
      window.electronAPI.location.resolveMany(
        state.assets.character.map((a) => a.locationId), characterId, false
      ).catch((error) => {
        console.error('[assets] Could not resolve character locations:', error);
        return {};
      }),
      state.assets.corporation.length
        ? window.electronAPI.location.resolveMany(
            state.assets.corporation.map((a) => a.locationId), characterId, true
          ).catch((error) => {
            console.error('[assets] Could not resolve corporation locations:', error);
            return {};
          })
        : Promise.resolve({}),
    ]);

    const UNKNOWN_LOCATION = {
      systemName: 'Unknown', stationName: 'Unknown',
      containerNames: [], fullPath: 'Unknown', locationType: 'error',
    };

    const decorate = (asset, locations) => {
      const info = categories[asset.typeId] || null;
      asset.name = names[asset.typeId] || `Unknown Type ${asset.typeId}`;
      asset.locationInfo = locations[asset.locationId] || UNKNOWN_LOCATION;
      // Full breadcrumb for the tooltip: "Cargo → Golem → UALX-3 Mothership
      // Bellicose". Built per ITEM because location_flag belongs to the item,
      // while locationInfo is cached per location and shared by everything
      // sitting there.
      asset.chainLabel = buildChainLabel(asset.locationInfo, asset.locationFlag);
      asset.categoryInfo = info;
      asset.bucket = bucketFor(info);
      asset.unitVolume = Number(volumes[asset.typeId]) || 0;
      asset.totalVolume = asset.unitVolume * (Number(asset.quantity) || 0);
      // BPO vs BPC only means anything for actual blueprints.
      asset.bpKind = asset.bucket === 'blueprint'
        ? (asset.isBlueprintCopy ? 'bpc' : 'bpo')
        : null;
      asset.unitPrice = 0;
      asset.value = 0;
    };

    state.assets.character.forEach((a) => decorate(a, charLocations));
    state.assets.corporation.forEach((a) => decorate(a, corpLocations));

    state.loading = false;
    render();

    // Prices last and non-blocking: the table is useful without them, and this
    // is the slowest step. One batched call for every distinct type.
    priceAssets(typeIds).catch((error) => {
      console.error('[assets] Could not price assets:', error);
    });
  }

  async function priceAssets(typeIds) {
    if (!typeIds.length) return;

    const prices = await window.electronAPI.market.calculatePrices(typeIds, {
      marketSetId: state.marketSetId,
      priceType: 'sell',
      settingsScope: 'input',
      // Order book only. Market history is fetched one type at a time and
      // expires daily at 11:05 UTC, so a hangar of ~1,300 types means ~1,300
      // sequential ESI calls before anything renders - every day. History only
      // sanity-checks the order-book price here; for "what is this worth" the
      // order book is enough. Manufacturing decisions keep the check.
      skipHistory: true,
    }).catch((error) => {
      console.error('[assets] Bulk pricing failed:', error);
      return {};
    });

    const apply = (asset) => {
      const entry = prices[asset.typeId];
      asset.unitPrice = entry && Number(entry.price) ? Number(entry.price) : 0;
      asset.value = asset.unitPrice * (Number(asset.quantity) || 0);
    };

    state.assets.character.forEach(apply);
    state.assets.corporation.forEach(apply);
    state.priced = true;

    render();
  }

  // ---------------------------------------------------------- filter/sort

  function currentAssets() {
    return state.assets[state.tab] || [];
  }

  function anyActive(map) {
    return Object.values(map).some(Boolean);
  }

  function passesFilters(asset) {
    const q = state.query.trim().toLowerCase();
    if (q && !asset.name.toLowerCase().includes(q)) return false;
    if (anyActive(state.cats) && !state.cats[asset.bucket]) return false;
    if (anyActive(state.locs) && !state.locs[asset.locationInfo.fullPath]) return false;

    if (anyActive(state.bp)) {
      const isBlueprint = asset.bucket === 'blueprint';
      if (state.bp.any && isBlueprint) return true;
      if (state.bp.bpo && asset.bpKind === 'bpo') return true;
      if (state.bp.bpc && asset.bpKind === 'bpc') return true;
      return false;
    }

    return true;
  }

  /** Filtered rows, with duplicates merged when Aggregate is on. */
  function computeRows() {
    let rows = currentAssets().filter(passesFilters);

    if (state.aggregate) {
      const merged = {};
      rows.forEach((a) => {
        const existing = merged[a.typeId];
        if (!existing) {
          merged[a.typeId] = {
            ...a,
            _locations: new Set([a.locationInfo.fullPath]),
            // Every distinct chain this type was found in, with its quantity.
            // A merged row collapses many places into "3 locations", so without
            // this the breadcrumb - the only way to see WHERE - is lost.
            _chains: new Map([[a.chainLabel, Number(a.quantity) || 0]]),
          };
          return;
        }
        existing.quantity += a.quantity;
        existing.value += a.value;
        existing.totalVolume += a.totalVolume;
        existing._locations.add(a.locationInfo.fullPath);
        existing._chains.set(
          a.chainLabel,
          (existing._chains.get(a.chainLabel) || 0) + (Number(a.quantity) || 0)
        );
      });

      rows = Object.values(merged).map((g) => {
        const count = g._locations.size;
        const multi = count > 1;

        // Largest stack first: when a type is spread across many places, the
        // one holding most of it is what you usually want to know.
        const chains = [...g._chains.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([label, qty]) => `${fmtNumber(qty)} × ${label}`);

        return {
          ...g,
          locationInfo: {
            ...g.locationInfo,
            fullPath: multi ? `${count} locations` : [...g._locations][0],
          },
          locationFlag: multi ? '—' : g.locationFlag,
          // Multi-line so each place is readable on its own row in the tooltip.
          chainLabel: chains.join('\n'),
          aggregatedChains: chains,
        };
      });
    }

    const dir = state.sortDir === 'asc' ? 1 : -1;
    const sortValue = (a) => {
      switch (state.sortCol) {
        case 'name': return a.name;
        case 'category': return BUCKET_LABELS[a.bucket] || a.bucket;
        case 'location': return a.locationInfo.fullPath;
        case 'flag': return a.locationFlag || '';
        case 'qty': return Number(a.quantity) || 0;
        case 'volume': return a.totalVolume;
        default: return a.value;
      }
    };

    return rows.slice().sort((x, y) => {
      const a = sortValue(x);
      const b = sortValue(y);
      return typeof a === 'string' ? a.localeCompare(b) * dir : (a - b) * dir;
    });
  }

  function rowKey(asset, index) {
    return `${asset.typeId}:${asset.itemId != null ? asset.itemId : index}`;
  }

  // ------------------------------------------------------------- rendering

  function render() {
    if (!els.root) return;
    try {
      renderHeader();
      renderSummary();
      renderTabs();
      renderSavedViews();
      renderFacets();
      renderTable();
      renderStatusLine();
      renderSelectionBar();
    } catch (error) {
      // Renderer failures are swallowed into console.error by default, which is
      // how a whole view can silently blank. Surfacing it keeps that visible.
      console.error('[assets] Render failed:', error);
    }
  }

  function renderHeader() {
    const character = state.character;
    if (!character) return;
    if (els.portrait && character.portrait) {
      els.portrait.src = `${character.portrait}?size=128`;
      els.portrait.alt = character.characterName || '';
    }
    if (els.name) els.name.textContent = character.characterName || 'Unknown Character';
  }

  function renderSummary() {
    const rows = computeRows();
    const totalValue = rows.reduce((s, a) => s + a.value, 0);
    const totalVolume = rows.reduce((s, a) => s + a.totalVolume, 0);
    const locations = new Set(rows.map((a) => a.locationInfo.fullPath));
    const uniqueTypes = new Set(rows.map((a) => a.typeId));

    const stats = [
      { label: 'Total Value', value: state.priced ? `${fmtISK(totalValue)} ISK` : '—', accent: true },
      { label: 'Total Volume', value: fmtVolume(totalVolume) },
      { label: 'Locations', value: fmtNumber(locations.size) },
      { label: 'Unique Types', value: fmtNumber(uniqueTypes.size) },
      { label: 'Items', value: fmtNumber(rows.length) },
    ];

    els.summary.replaceChildren(...stats.map((s) => {
      const wrap = el('div', 'as-stat');
      wrap.appendChild(el('div', 'as-stat-label', s.label));
      wrap.appendChild(el('div', `as-stat-value${s.accent ? ' is-accent' : ''}`, s.value));
      return wrap;
    }));
  }

  function renderTabs() {
    const tabs = [['character', 'Character Assets']];
    // Only offer the corp tab when the character actually has a corporation -
    // the old screen did the same.
    if (state.character && state.character.corporationId) {
      tabs.push(['corporation', 'Corporation Assets']);
    }

    els.tabs.replaceChildren(...tabs.map(([id, label]) => {
      const active = state.tab === id;
      const btn = el('button', `as-tab${active ? ' is-active' : ''}`);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.appendChild(document.createTextNode(label));
      btn.appendChild(el('span', 'as-tab-count', fmtNumber((state.assets[id] || []).length)));
      btn.addEventListener('click', () => {
        if (state.tab === id) return;
        state.tab = id;
        state.selected = {};
        // Location facets are per-tab; keeping them would filter everything out.
        state.locs = {};
        render();
      });
      return btn;
    }));
  }

  function facetRow(label, count, on, isEmpty, onToggle) {
    const row = el('div', `as-facet${on ? ' is-on' : ''}${isEmpty ? ' is-empty' : ''}`);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.appendChild(checkbox(on));
    row.appendChild(el('span', 'as-facet-label', label));
    row.appendChild(el('span', 'as-facet-count', fmtNumber(count)));
    row.addEventListener('click', onToggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
    });
    return row;
  }

  function renderFacets() {
    const assets = currentAssets();

    const countBy = (keyFn) => {
      const map = {};
      assets.forEach((a) => {
        const k = keyFn(a);
        map[k] = (map[k] || 0) + 1;
      });
      return map;
    };

    // Category facets: always show every bucket that exists in the data.
    const catCounts = countBy((a) => a.bucket);
    const catKeys = Object.keys(BUCKET_LABELS).filter((k) => catCounts[k]);
    els.catFacets.replaceChildren(...catKeys.map((k) => facetRow(
      BUCKET_LABELS[k], catCounts[k] || 0, !!state.cats[k], false,
      () => { state.cats[k] = !state.cats[k]; state.activeViewId = null; render(); }
    )));
    els.clearCats.hidden = !anyActive(state.cats);

    // Location facets, most populated first - a hangar with 900 items is more
    // useful at the top than an alphabetical accident.
    const locCounts = countBy((a) => a.locationInfo.fullPath);
    const locKeys = Object.keys(locCounts).sort((a, b) => locCounts[b] - locCounts[a]);
    els.locFacets.replaceChildren(...locKeys.map((k) => facetRow(
      k, locCounts[k], !!state.locs[k], false,
      () => { state.locs[k] = !state.locs[k]; state.activeViewId = null; render(); }
    )));
    els.clearLocs.hidden = !anyActive(state.locs);

    const bpCounts = {
      any: assets.filter((a) => a.bucket === 'blueprint').length,
      bpo: assets.filter((a) => a.bpKind === 'bpo').length,
      bpc: assets.filter((a) => a.bpKind === 'bpc').length,
    };
    const bpLabels = { any: 'All Blueprints', bpo: 'Originals (BPO)', bpc: 'Copies (BPC)' };
    els.bpFacets.replaceChildren(...Object.keys(bpLabels).map((k) => facetRow(
      bpLabels[k], bpCounts[k], !!state.bp[k], !bpCounts[k],
      () => { state.bp[k] = !state.bp[k]; state.activeViewId = null; render(); }
    )));
    els.clearBp.hidden = !anyActive(state.bp);

    const filtersActive = !!(
      state.query || anyActive(state.cats) || anyActive(state.locs) || anyActive(state.bp)
      || state.aggregate || state.groupBy !== 'location'
      || state.sortCol !== 'value' || state.sortDir !== 'desc'
    );
    els.resetBadge.hidden = !filtersActive;

    // "All Assets (default)" is the active row whenever no saved view is
    // applied - so exactly one row in this list is ever highlighted.
    els.resetView.classList.toggle('is-active', state.activeViewId === null);
  }

  function cellFor(columnId, asset) {
    switch (columnId) {
      case 'name': {
        const wrap = el('span', 'as-item-name');
        const img = document.createElement('img');
        img.className = 'as-item-icon';
        img.loading = 'lazy';
        img.alt = '';
        img.src = `https://images.evetech.net/types/${asset.typeId}/`
          + `${asset.bucket === 'blueprint' ? 'bp' : 'icon'}?size=64`;
        wrap.appendChild(img);
        wrap.appendChild(el('span', null, asset.name));
        if (asset.bpKind) {
          wrap.appendChild(el(
            'span', `as-bp-badge is-${asset.bpKind}`, asset.bpKind.toUpperCase()
          ));
        }
        return wrap;
      }
      case 'qty': return el('span', 'as-mono', fmtNumber(asset.quantity));
      case 'category': return el('span', 'as-muted', BUCKET_LABELS[asset.bucket] || 'Other');
      case 'location': {
        // The cell shows the STATION so rows group and sort by real place; the
        // tooltip carries the full chain down to the item.
        const node = el('span', 'as-muted', asset.locationInfo.fullPath);

        // Something worth hovering for: a nested chain, or an aggregated row
        // collapsing several places into "N locations".
        const nested = (asset.locationInfo.containerPath || []).length > 0;
        const aggregated = (asset.aggregatedChains || []).length > 1;

        node.title = asset.chainLabel || asset.locationInfo.fullPath;
        if (nested || aggregated) {
          node.classList.add('as-has-chain');
          // The chain is otherwise mouse-only; expose it to assistive tech and
          // make it reachable by keyboard.
          node.setAttribute('aria-label', asset.chainLabel);
          node.tabIndex = 0;
        }
        return node;
      }
      case 'flag': {
        const node = el('span', 'as-faint', asset.locationFlag || '—');
        if (asset.chainLabel) node.title = asset.chainLabel;
        return node;
      }
      case 'volume': return el('span', 'as-faint', fmtVolume(asset.totalVolume));
      case 'value':
        return el('span', 'as-value', state.priced ? `${fmtISK(asset.value)} ISK` : '—');
      default: return el('span', null, '');
    }
  }

  function renderTable() {
    const columns = visibleColumns();
    const rows = computeRows();

    els.loading.hidden = !state.loading;
    if (state.loading) {
      els.table.hidden = true;
      els.empty.hidden = true;
      return;
    }

    if (rows.length === 0) {
      els.table.hidden = true;
      els.empty.hidden = false;
      els.emptyText.textContent =
        `Adjust your search or filters, or click "Refresh from API" to fetch ${state.tab} assets.`;
      return;
    }

    els.table.hidden = false;
    els.empty.hidden = true;

    // ---- header
    const headerCells = [];
    const checkTh = el('th', 'as-th is-check');
    const allSelected = rows.length > 0 && rows.every((a, i) => state.selected[rowKey(a, i)]);
    const selectAll = checkbox(allSelected);
    selectAll.style.pointerEvents = 'auto';
    selectAll.tabIndex = 0;
    selectAll.setAttribute('aria-label', 'Select all rows');
    selectAll.addEventListener('change', () => {
      const next = { ...state.selected };
      rows.forEach((a, i) => { next[rowKey(a, i)] = !allSelected; });
      state.selected = next;
      render();
    });
    checkTh.appendChild(selectAll);
    headerCells.push(checkTh);

    columns.forEach((col) => {
      const sorted = state.sortCol === col.id;
      const th = el('th', `as-th${col.numeric ? ' is-numeric' : ''}${sorted ? ' is-sorted' : ''}`);
      th.setAttribute('scope', 'col');
      th.setAttribute('aria-sort', sorted ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      th.textContent = `${col.label} ${sorted ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕'}`;
      th.addEventListener('click', () => {
        if (state.sortCol === col.id) {
          state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          state.sortCol = col.id;
          state.sortDir = 'desc';
        }
        render();
      });
      headerCells.push(th);
    });
    els.theadRow.replaceChildren(...headerCells);

    // ---- body
    const body = [];
    const makeItemRow = (asset, index) => {
      const key = rowKey(asset, index);
      const selected = !!state.selected[key];
      const tr = el('tr', `as-row${selected ? ' is-selected' : ''}`);

      const checkTd = el('td', 'as-td is-check');
      const box = checkbox(selected);
      checkTd.appendChild(box);
      checkTd.addEventListener('click', () => {
        state.selected = { ...state.selected, [key]: !state.selected[key] };
        render();
      });
      tr.appendChild(checkTd);

      columns.forEach((col) => {
        const td = el('td', `as-td${col.numeric ? ' is-numeric' : ''}`);
        td.appendChild(cellFor(col.id, asset));
        tr.appendChild(td);
      });
      return tr;
    };

    // Grouping by location is meaningless once duplicates are merged across
    // locations, so aggregate implicitly flattens it.
    const groupBy = state.aggregate && state.groupBy === 'location' ? 'none' : state.groupBy;

    if (groupBy === 'none') {
      rows.forEach((a, i) => body.push(makeItemRow(a, i)));
    } else {
      const keyFn = groupBy === 'category'
        ? (a) => BUCKET_LABELS[a.bucket] || 'Other'
        : (a) => a.locationInfo.fullPath;

      const groups = new Map();
      rows.forEach((a, i) => {
        const g = keyFn(a);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push({ asset: a, index: i });
      });

      groups.forEach((entries, name) => {
        const groupKey = `${groupBy}:${name}`;
        const open = !state.collapsed[groupKey];
        const groupValue = entries.reduce((s, e) => s + e.asset.value, 0);

        const tr = document.createElement('tr');
        const td = el('td', 'as-group-cell');
        td.colSpan = columns.length + 1;

        const head = el('div', `as-group${open ? ' is-open' : ''}`);
        head.setAttribute('role', 'button');
        head.tabIndex = 0;
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        head.appendChild(svg(['M9 18l6-6-6-6'], 12, 'as-group-chevron'));
        head.appendChild(el('span', 'as-group-label', name));
        head.appendChild(el('span', 'as-group-count', `${entries.length} items`));
        head.appendChild(el(
          'span', 'as-group-value', state.priced ? `${fmtISK(groupValue)} ISK` : '—'
        ));

        const toggle = () => {
          state.collapsed = { ...state.collapsed, [groupKey]: !state.collapsed[groupKey] };
          render();
        };
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });

        td.appendChild(head);
        tr.appendChild(td);
        body.push(tr);

        if (open) entries.forEach((e) => body.push(makeItemRow(e.asset, e.index)));
      });
    }

    els.tbody.replaceChildren(...body);
  }

  function renderSelectionBar() {
    const rows = computeRows();
    const selected = rows.filter((a, i) => state.selected[rowKey(a, i)]);

    els.selectionBar.hidden = selected.length === 0;
    if (selected.length === 0) return;

    const value = selected.reduce((s, a) => s + a.value, 0);
    els.selectedCount.textContent = `${fmtNumber(selected.length)} selected`;
    els.selectedValue.textContent = state.priced ? `${fmtISK(value)} ISK` : '';
  }

  function renderStatusLine() {
    const rows = computeRows();
    els.shownCount.textContent = `${fmtNumber(rows.length)} shown`;
  }

  // -------------------------------------------------------- cache status

  async function updateCacheStatus() {
    if (!state.characterId) return;
    try {
      const [charStatus, corpStatus] = await Promise.all([
        window.electronAPI.assets.getCacheStatus(state.characterId, false).catch(() => null),
        window.electronAPI.assets.getCacheStatus(state.characterId, true).catch(() => null),
      ]);

      const remaining = Math.max(
        (charStatus && charStatus.remainingSeconds) || 0,
        (corpStatus && corpStatus.remainingSeconds) || 0
      );

      if (remaining > 0) {
        const label = `Cache expires in ${fmtDuration(remaining)}`;
        els.cacheStatus.textContent = label;
        if (els.refreshBtn) els.refreshBtn.title = label;
      } else {
        els.cacheStatus.textContent = 'Cache expired';
        if (els.refreshBtn) els.refreshBtn.title = 'Fetch the latest assets from ESI';
      }
    } catch (error) {
      console.error('[assets] Could not read cache status:', error);
    }
  }

  // --------------------------------------------------------------- actions

  async function handleRefresh() {
    if (!els.refreshBtn || els.refreshBtn.disabled) return;

    els.refreshBtn.disabled = true;
    els.refreshLabel.textContent = 'Refreshing…';

    try {
      const result = await window.electronAPI.assets.fetch(state.characterId);

      // Gated: ESI was never asked, so the stored assets are unchanged and
      // still correct. Claiming a refresh would be a lie.
      if (result && result.skipped) {
        toast(result.reason || 'Assets are already up to date', 'info');
        return;
      }

      await loadAssets();
      await updateCacheStatus();
      toast('Assets refreshed', 'success');
    } catch (error) {
      console.error('[assets] Refresh failed:', error);
      // The old screen used alert(), which under the shell freezes the whole
      // window behind a modal dialog.
      toast(`Failed to refresh assets: ${error.message}`, 'error');
    } finally {
      els.refreshBtn.disabled = false;
      els.refreshLabel.textContent = 'Refresh from API';
    }
  }

  function exportCsv() {
    const columns = visibleColumns();
    const rows = computeRows();
    if (rows.length === 0) {
      toast('Nothing to export', 'warning');
      return;
    }

    const plain = (columnId, asset) => {
      switch (columnId) {
        case 'name': return asset.name;
        case 'qty': return asset.quantity;
        case 'category': return BUCKET_LABELS[asset.bucket] || 'Other';
        // Export the FULL chain: a spreadsheet has no tooltip, and "Sotiyo"
        // alone loses which ship or container the item was actually in.
        case 'location': return asset.chainLabel || asset.locationInfo.fullPath;
        case 'flag': return asset.locationFlag || '';
        case 'volume': return Math.round(asset.totalVolume * 100) / 100;
        case 'value': return Math.round(asset.value);
        default: return '';
      }
    };

    const escape = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = [columns.map((c) => escape(c.label)).join(',')];
    rows.forEach((a) => lines.push(columns.map((c) => escape(plain(c.id, a))).join(',')));

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `assets-${state.tab}-${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);

    toast(`Exported ${fmtNumber(rows.length)} rows`, 'success');
  }

  /** Clear the search box and return focus to it, ready for the next query. */
  function clearSearch() {
    state.query = '';
    els.search.value = '';
    els.searchClear.hidden = true;
    els.search.focus();
    render();
  }

  function resetAll() {
    state.query = '';
    state.cats = {};
    state.locs = {};
    state.bp = {};
    state.groupBy = 'location';
    state.aggregate = false;
    state.sortCol = 'value';
    state.sortDir = 'desc';
    state.selected = {};
    state.activeViewId = null;
    if (els.search) els.search.value = '';
    if (els.searchClear) els.searchClear.hidden = true;
    if (els.groupBy) els.groupBy.value = 'location';
    if (els.aggregate) els.aggregate.checked = false;
    els.aggregateWrap.classList.remove('is-on');
    render();
  }

  // ---------------------------------------------------------- saved views

  /**
   * The filter configuration a saved view captures.
   *
   * Deliberately NOT included:
   *   query    - a search string is a transient "find this now", not a view
   *   selected - selection is per-session
   *   sortCol  - ordering is a glance-level preference, changed constantly
   *   columns  - column layout is global to the screen, not per view
   */
  function currentViewConfig() {
    return {
      cats: { ...state.cats },
      locs: { ...state.locs },
      bp: { ...state.bp },
      groupBy: state.groupBy,
      aggregate: state.aggregate,
    };
  }

  /** Human-readable summary of a config, for the save dialog and tooltips. */
  function describeConfig(config) {
    const parts = [];
    const on = (map) => Object.keys(map || {}).filter((k) => map[k]);

    const cats = on(config.cats).map((k) => BUCKET_LABELS[k] || k);
    if (cats.length) parts.push(`Categories: ${cats.join(', ')}`);

    const locs = on(config.locs);
    if (locs.length) parts.push(`Locations: ${locs.join(', ')}`);

    const bpLabels = { any: 'All Blueprints', bpo: 'Originals', bpc: 'Copies' };
    const bp = on(config.bp).map((k) => bpLabels[k] || k);
    if (bp.length) parts.push(`Blueprints: ${bp.join(', ')}`);

    parts.push(`Group by: ${config.groupBy === 'none' ? 'None' : config.groupBy}`);
    if (config.aggregate) parts.push('Aggregate duplicates: on');

    return parts;
  }

  async function loadSavedViews() {
    try {
      const views = await window.electronAPI.settings.get('assets', 'savedViews');
      state.savedViews = Array.isArray(views) ? views : [];
    } catch (error) {
      console.error('[assets] Could not load saved views:', error);
      state.savedViews = [];
    }
  }

  async function persistSavedViews() {
    try {
      await window.electronAPI.settings.update('assets', { savedViews: state.savedViews });
    } catch (error) {
      console.error('[assets] Could not save views:', error);
      toast('Could not save the view', 'error');
    }
  }

  function applySavedView(view) {
    if (!view || !view.config) return;
    const config = view.config;

    state.cats = { ...(config.cats || {}) };
    state.locs = { ...(config.locs || {}) };
    state.bp = { ...(config.bp || {}) };
    state.groupBy = config.groupBy || 'location';
    state.aggregate = !!config.aggregate;
    state.activeViewId = view.id;
    // A saved view replaces the filter set, so a stale selection would refer to
    // rows that are no longer shown.
    state.selected = {};

    if (els.groupBy) els.groupBy.value = state.groupBy;
    if (els.aggregate) els.aggregate.checked = state.aggregate;
    els.aggregateWrap.classList.toggle('is-on', state.aggregate);

    render();
  }

  async function deleteSavedView(view) {
    state.savedViews = state.savedViews.filter((v) => v.id !== view.id);
    if (state.activeViewId === view.id) state.activeViewId = null;
    await persistSavedViews();
    render();
    toast(`Deleted "${view.name}"`, 'info');
  }

  function renderSavedViews() {
    if (!els.savedViews) return;

    els.savedViews.replaceChildren(...state.savedViews.map((view) => {
      const active = state.activeViewId === view.id;
      const row = el('div', `as-preset as-saved-view${active ? ' is-active' : ''}`);
      row.setAttribute('role', 'button');
      row.tabIndex = 0;

      const summary = describeConfig(view.config || {}).join(' · ');
      row.title = summary;

      row.appendChild(svg(
        ['M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'], 12
      ));
      row.appendChild(el('span', 'as-preset-name', view.name));

      const remove = el('button', 'as-view-delete', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Delete view ${view.name}`);
      remove.title = 'Delete this view';
      remove.addEventListener('click', (e) => {
        // Without this the row's own handler also fires and applies the view
        // we are deleting.
        e.stopPropagation();
        deleteSavedView(view);
      });
      row.appendChild(remove);

      row.addEventListener('click', () => applySavedView(view));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          applySavedView(view);
        }
      });

      return row;
    }));
  }

  function openSaveModal() {
    els.saveName.value = '';

    const parts = describeConfig(currentViewConfig());
    els.saveSummary.replaceChildren(...(
      parts.length
        ? parts.map((p) => el('div', null, p))
        : [el('div', 'as-save-empty', 'No filters set - this saves the default view.')]
    ));

    els.saveModal.hidden = false;
    els.saveName.focus();
  }

  function closeSaveModal() {
    els.saveModal.hidden = true;
  }

  async function confirmSaveView() {
    const name = els.saveName.value.trim();
    if (!name) {
      toast('Give the view a name', 'warning');
      els.saveName.focus();
      return;
    }

    const existing = state.savedViews.find(
      (v) => v.name.toLowerCase() === name.toLowerCase()
    );

    if (existing) {
      // Overwrite rather than silently creating a duplicate name.
      existing.config = currentViewConfig();
      state.activeViewId = existing.id;
    } else {
      const view = {
        id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        config: currentViewConfig(),
      };
      state.savedViews.push(view);
      state.activeViewId = view.id;
    }

    await persistSavedViews();
    closeSaveModal();
    render();
    toast(existing ? `Updated "${name}"` : `Saved "${name}"`, 'success');
  }

  // --------------------------------------------------------- columns modal

  function renderColumnsModal() {
    const rows = orderedColumns().map((col) => {
      const row = el('div', 'as-column-row');
      row.draggable = true;
      if (state.dragCol === col.id) row.classList.add('is-dragging');
      if (state.dropCol === col.id && state.dragCol && state.dragCol !== col.id) {
        row.classList.add('is-drop-target');
      }

      row.appendChild(el('span', 'as-column-grip', '⋮⋮'));

      const box = checkbox(isColumnVisible(col));
      box.style.pointerEvents = 'auto';
      box.addEventListener('change', () => {
        state.hiddenCols = { ...state.hiddenCols, [col.id]: !box.checked };
        render();
        renderColumnsModal();
      });
      row.appendChild(box);

      const label = el('span', 'as-column-label', col.label);
      label.addEventListener('click', () => {
        box.checked = !box.checked;
        box.dispatchEvent(new Event('change'));
      });
      row.appendChild(label);

      row.addEventListener('dragstart', () => {
        state.dragCol = col.id;
        renderColumnsModal();
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (state.dropCol !== col.id) {
          state.dropCol = col.id;
          renderColumnsModal();
        }
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (state.dragCol && state.dragCol !== col.id) {
          const order = (state.colOrder || ALL_COLUMNS.map((c) => c.id)).slice();
          const from = order.indexOf(state.dragCol);
          const to = order.indexOf(col.id);
          if (from >= 0 && to >= 0) {
            order.splice(to, 0, order.splice(from, 1)[0]);
            state.colOrder = order;
          }
        }
        state.dragCol = null;
        state.dropCol = null;
        render();
        renderColumnsModal();
      });
      row.addEventListener('dragend', () => {
        state.dragCol = null;
        state.dropCol = null;
        renderColumnsModal();
      });

      return row;
    });

    els.columnsList.replaceChildren(...rows);
  }

  function openColumnsModal() {
    renderColumnsModal();
    els.columnsModal.hidden = false;
  }

  function closeColumnsModal() {
    els.columnsModal.hidden = true;
  }

  // ----------------------------------------------------------- market set

  async function initMarketSet() {
    try {
      const sets = await window.electronAPI.market.getMarketSets();
      state.marketSets = Array.isArray(sets) ? sets : [];
      const def = state.marketSets.find((s) => s.isDefault) || state.marketSets[0];
      state.marketSetId = def ? def.id : null;

      if (!els.marketSet) return;

      // A plain <select>: market sets are a short fixed list, which binding
      // rule 5 keeps out of the searchable component.
      els.marketSet.replaceChildren(...state.marketSets.map((s) => {
        const option = document.createElement('option');
        option.value = String(s.id);
        option.textContent = s.name;
        return option;
      }));
      if (state.marketSetId != null) els.marketSet.value = String(state.marketSetId);
    } catch (error) {
      console.error('[assets] Could not load market sets:', error);
    }
  }

  // ----------------------------------------------------------------- mount

  /**
   * @param {HTMLElement} container
   * @param {Object} params - { characterId }
   * @param {Object} ctx - ViewContext; every subscription goes through it so a
   *   remount cannot leave a duplicate behind.
   */
  async function mount(container, params, ctx) {
    viewCtx = ctx;

    // `state` is module-level and survives unmount, so a remount - especially
    // for a DIFFERENT character - would otherwise inherit the previous one's
    // assets, facets and selection. Reset everything that is per-mount.
    state.character = null;
    state.assets = { character: [], corporation: [] };
    state.priced = false;
    state.loading = true;
    state.tab = 'character';
    state.query = '';
    state.cats = {};
    state.locs = {};
    state.bp = {};
    state.selected = {};
    state.collapsed = {};
    state.groupBy = 'location';
    state.aggregate = false;
    state.sortCol = 'value';
    state.sortDir = 'desc';
    state.savedViews = [];
    state.activeViewId = null;

    const response = await fetch('assets.view.html');
    container.innerHTML = await response.text();

    els = {
      root: container.querySelector('#assets-view'),
      portrait: container.querySelector('#as-portrait'),
      name: container.querySelector('#as-character-name'),
      marketSet: container.querySelector('#as-market-set'),
      exportBtn: container.querySelector('#as-export-btn'),
      refreshBtn: container.querySelector('#as-refresh-btn'),
      refreshLabel: container.querySelector('#as-refresh-label'),
      summary: container.querySelector('#as-summary'),
      tabs: container.querySelector('#as-tabs'),
      groupBy: container.querySelector('#as-group-by'),
      aggregate: container.querySelector('#as-aggregate'),
      aggregateWrap: container.querySelector('#as-aggregate-wrap'),
      columnsBtn: container.querySelector('#as-columns-btn'),
      search: container.querySelector('#as-search'),
      searchClear: container.querySelector('#as-search-clear'),
      resetView: container.querySelector('#as-reset-view'),
      resetBadge: container.querySelector('#as-reset-badge'),
      saveView: container.querySelector('#as-save-view'),
      savedViews: container.querySelector('#as-saved-views'),
      saveModal: container.querySelector('#as-save-modal'),
      saveName: container.querySelector('#as-save-name'),
      saveSummary: container.querySelector('#as-save-summary'),
      saveClose: container.querySelector('#as-save-close'),
      saveCancel: container.querySelector('#as-save-cancel'),
      saveConfirm: container.querySelector('#as-save-confirm'),
      catFacets: container.querySelector('#as-cat-facets'),
      locFacets: container.querySelector('#as-loc-facets'),
      bpFacets: container.querySelector('#as-bp-facets'),
      clearCats: container.querySelector('#as-clear-cats'),
      clearLocs: container.querySelector('#as-clear-locs'),
      clearBp: container.querySelector('#as-clear-bp'),
      selectionBar: container.querySelector('#as-selection-bar'),
      selectedCount: container.querySelector('#as-selected-count'),
      selectedValue: container.querySelector('#as-selected-value'),
      clearSelection: container.querySelector('#as-clear-selection'),
      loading: container.querySelector('#as-loading'),
      table: container.querySelector('#as-table'),
      theadRow: container.querySelector('#as-thead-row'),
      tbody: container.querySelector('#as-tbody'),
      empty: container.querySelector('#as-empty'),
      emptyText: container.querySelector('#as-empty-text'),
      shownCount: container.querySelector('#as-shown-count'),
      cacheStatus: container.querySelector('#as-cache-status'),
      columnsModal: container.querySelector('#as-columns-modal'),
      columnsList: container.querySelector('#as-columns-list'),
      columnsClose: container.querySelector('#as-columns-close'),
      columnsDone: container.querySelector('#as-columns-done'),
    };

    // Character id comes from the mount params, so this view is window-agnostic:
    // it works mounted in the main window or popped out, with no code change.
    state.characterId = params && params.characterId
      ? params.characterId
      : await window.electronAPI.esi.getDefaultCharacter().then(
        (c) => (c ? c.characterId : null)
      ).catch(() => null);

    if (!state.characterId) {
      state.loading = false;
      els.loading.hidden = true;
      els.empty.hidden = false;
      els.emptyText.textContent = 'No character selected.';
      return {};
    }

    state.character = await window.electronAPI.esi.getCharacter(state.characterId)
      .catch((error) => {
        console.error('[assets] Could not load character:', error);
        return null;
      });

    // ---- listeners, all via ctx so remount cannot duplicate them
    ctx.on(els.search, 'input', () => {
      state.query = els.search.value;
      els.searchClear.hidden = state.query === '';
      render();
    });

    // Escape clears the search rather than bubbling to the modal handler -
    // that handler only acts when a modal is open, so the two never collide.
    ctx.on(els.search, 'keydown', (e) => {
      if (e.key === 'Escape' && els.search.value !== '') {
        e.stopPropagation();
        clearSearch();
      }
    });

    ctx.on(els.searchClear, 'click', clearSearch);

    ctx.on(els.groupBy, 'change', () => {
      state.groupBy = els.groupBy.value;
      state.activeViewId = null;
      render();
    });

    ctx.on(els.marketSet, 'change', () => {
      state.marketSetId = els.marketSet.value;
      // Prices belong to a market set, so they are stale the moment it changes.
      state.priced = false;
      render();
      const typeIds = [...new Set(
        [...state.assets.character, ...state.assets.corporation].map((a) => a.typeId)
      )];
      priceAssets(typeIds).catch((error) => {
        console.error('[assets] Re-pricing failed:', error);
      });
    });

    ctx.on(els.aggregate, 'change', () => {
      state.aggregate = els.aggregate.checked;
      state.activeViewId = null;
      els.aggregateWrap.classList.toggle('is-on', state.aggregate);
      render();
    });

    ctx.on(els.refreshBtn, 'click', handleRefresh);
    ctx.on(els.exportBtn, 'click', exportCsv);
    ctx.on(els.resetView, 'click', resetAll);
    ctx.on(els.clearCats, 'click', () => { state.cats = {}; render(); });
    ctx.on(els.clearLocs, 'click', () => { state.locs = {}; render(); });
    ctx.on(els.clearBp, 'click', () => { state.bp = {}; render(); });
    ctx.on(els.clearSelection, 'click', () => { state.selected = {}; render(); });

    ctx.on(els.columnsBtn, 'click', openColumnsModal);
    ctx.on(els.columnsClose, 'click', closeColumnsModal);
    ctx.on(els.columnsDone, 'click', closeColumnsModal);
    ctx.on(els.columnsModal, 'click', (e) => {
      if (e.target === els.columnsModal) closeColumnsModal();
    });

    // Saved views
    ctx.on(els.saveView, 'click', openSaveModal);
    ctx.on(els.saveView, 'keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSaveModal(); }
    });
    ctx.on(els.saveClose, 'click', closeSaveModal);
    ctx.on(els.saveCancel, 'click', closeSaveModal);
    ctx.on(els.saveConfirm, 'click', confirmSaveView);
    ctx.on(els.saveModal, 'click', (e) => {
      if (e.target === els.saveModal) closeSaveModal();
    });
    ctx.on(els.saveName, 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmSaveView(); }
    });

    // One Escape handler for both modals. Every close path - X, Cancel,
    // backdrop, Escape - goes through the same teardown.
    ctx.on(document, 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!els.saveModal.hidden) closeSaveModal();
      else if (!els.columnsModal.hidden) closeColumnsModal();
    });

    await loadSavedViews();
    await initMarketSet();
    await loadAssets();
    await updateCacheStatus();

    // Replaces the old 30s setInterval. ctx.setInterval is cleared on unmount;
    // the raw setInterval it replaces leaked on every remount.
    ctx.setInterval(updateCacheStatus, 30000);

    // Live updates: refresh when the background cycle lands new asset data,
    // rather than polling for it.
    const api = window.electronAPI.data;
    if (api && api.onChanged) {
      ctx.track(api.onChanged((info) => {
        const type = String(info && info.endpointType || '');
        if (type === 'assets' || type === 'corporation_assets') {
          loadAssets().catch((error) => console.error('[assets] Live reload failed:', error));
        }
      }));
    }

    return {};
  }

  function destroy() {
    // Nothing to tear down beyond the ViewContext: every listener goes through
    // ctx.on/ctx.track, and this view owns no component with a document-level
    // listener or a popover attached to <body>.
    els = {};
    viewCtx = null;
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('assets', {
      title: 'Asset Manager',
      mount,
      destroy,
    });
  }
})();
