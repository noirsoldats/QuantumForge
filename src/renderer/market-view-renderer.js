// Market Manager — a native shell view.
//
// Four tabs against the existing IPC surface:
//   Pricing     item table for the selected market set, with an inspector
//   Overview    freshness/coverage card per market set
//   Overrides   manual prices that replace market data
//   Watchlists  tracked item lists with price alerts
//
// Watchlist schema lives in market-schema-migrations.js (001_market_watchlists,
// in market-data.db); CRUD and the alert engine are in market-watchlists.js.
//
// Alert display here is presentation only. Main owns whether an alert actually
// FIRES (it holds the per-side debounce); sideAlertState() just shows the user
// where each rule currently stands.
//
// This view fully replaces the former `public/market.html` page, which was
// deleted along with its CSS and renderer once this was verified in the app.

(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SIDES = ['buy', 'sell'];

  const ICONS = {
    star: [['path', { d: 'M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z' }]],
    trash: [
      ['polyline', { points: '3 6 5 6 21 6' }],
      ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ],
    bell: [
      ['path', { d: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9' }],
      ['path', { d: 'M13.73 21a2 2 0 0 1-3.46 0' }],
    ],
    clock: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['polyline', { points: '12 6 12 12 16 14' }],
    ],
    pencil: [
      ['path', { d: 'M12 20h9' }],
      ['path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' }],
    ],
    refresh: [
      ['path', { d: 'M21 2v6h-6' }],
      ['path', { d: 'M3 12a9 9 0 0 1 15-6.7L21 8' }],
      ['path', { d: 'M3 22v-6h6' }],
      ['path', { d: 'M21 12a9 9 0 0 1-15 6.7L3 16' }],
    ],
    bars: [
      ['line', { x1: '18', y1: '20', x2: '18', y2: '10' }],
      ['line', { x1: '12', y1: '20', x2: '12', y2: '4' }],
      ['line', { x1: '6', y1: '20', x2: '6', y2: '14' }],
    ],
    chevronRight: [['path', { d: 'M9 18l6-6-6-6' }]],
    lock: [
      ['rect', { x: '4', y: '11', width: '16', height: '10', rx: '2' }],
      ['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }],
    ],
  };

  /**
   * Transient message, via the shared QFToast.
   *
   * Toasts raised while the market-data drawer is open move to the LEFT: the
   * drawer occupies 760px on the right and would otherwise cover them. That is
   * a property of the moment, not the screen, hence the per-call override.
   */
  function toast(message, type = 'info', options = {}) {
    const drawer = document.getElementById('mk-drawer');
    const drawerOpen = drawer && !drawer.hidden;
    return window.QFToast.show(message, type, {
      position: drawerOpen ? 'top-left' : undefined,
      ...options,
    });
  }

  function icon(name, size, opts = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', opts.fill || 'none');
    svg.setAttribute('stroke', opts.stroke || 'currentColor');
    svg.setAttribute('stroke-width', opts.strokeWidth || 1.8);
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(([tag, attrs]) => {
      const node = document.createElementNS(SVG_NS, tag);
      Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
      svg.appendChild(node);
    });
    return svg;
  }

  /* ---------------------------------------------------------- formatting */

  /** ISK with thousands separators; compact for large values. */
  function isk(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '--';
    if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (Math.abs(n) >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-US') : '--';
  }

  /* -------------------------------------------------------------- state */

  const state = {
    sets: [],
    activeSetId: null,
    overrides: [],
    characters: [],
    defaultCharacterId: null,
    dashboard: [],
    lastFetch: null,
    query: '',
    selectedTypeId: null,
    favourites: new Set(),
    tab: 'pricing',

    // Watchlists
    watchlists: [],
    activeWatchlistId: null,
    watchItems: [],
    /** typeId -> {buy, sell} for the active watchlist's items. */
    watchPrices: new Map(),
    /** Item ids currently in a triggered alert state. */
    triggered: new Set(),
    /** Market set ids with a refresh in flight (drives the Overview bar). */
    refreshingSets: new Set(),
    /**
     * Live ESI page progress, keyed `region:<id>` or `structure:<id>`.
     *
     * Structures are keyed SEPARATELY from their region on purpose. A player
     * structure is fetched by its own paginated endpoint, and a set pinned to
     * one must not light up from the region-wide fetch that happens to cover
     * the same space - that reported progress the structure had not made.
     */
    fetchProgress: new Map(),
    /** regionId -> regionName, loaded once from the SDE. */
    regionNames: new Map(),
    /** typeId -> typeName, shared by the Pricing, Overrides and Watchlist tabs. */
    typeNames: new Map(),
    /** Region-scoped search hits for the Pricing filter. */
    searchResults: [],
    /** typeId -> {buy, sell, volume} straight from the region's order book. */
    orderBook: new Map(),
    /** Guards out-of-order search responses. */
    searchToken: 0,
    /** Seeded trade hubs for the set editor's location picker. */
    marketLocations: [],
    /** Type currently shown in the full market data drawer, if any. */
    drawerTypeId: null,
    /** typeId -> plans using it. Avoids refetching on every table repaint. */
    planCache: new Map(),
    /** owner -> live QFSearchSelect instances, destroyed when that form rebuilds. */
    searchSelects: {},
    /**
     * Every type on ANY watchlist. The Pricing tab lists them all, priced
     * against the left-pane set - unlike the Watchlists tab, where each list
     * is priced against the market it is bound to.
     */
    allWatchTypeIds: new Set(),
  };

  /**
   * Add Item modal state. The search itself is a shared QFSearchSelect, which
   * owns the query, results, highlight and debounce - only the chosen item and
   * the alert rule live here.
   */
  const addItem = {
    pick: null,
    /** The item being edited, or null when adding. Editing keeps the baseline. */
    editing: null,
    buy: { type: 'none', direction: 'above', value: null },
    sell: { type: 'none', direction: 'above', value: null },
  };

  /** New/Edit watchlist modal mode. */
  let wlFormMode = 'create';

  /* ------------------------------------------------------- pending work */

  /**
   * Async work started by a DOM event handler.
   *
   * A click handler cannot be awaited by its caller - the browser discards
   * whatever an event listener returns - so an `async` handler leaves work in
   * flight that nothing holds a reference to. Tests used to cope by draining
   * the macrotask queue a fixed number of times and hoping that was enough,
   * which is both slow and only probabilistically correct.
   *
   * Registering the promise here gives that work a handle, so a test can await
   * exactly the thing it triggered instead of guessing at a number of rounds.
   */
  const pending = new Set();

  /**
   * Record a handler's promise, if it returned one.
   * @param {*} result - a handler's return value; ignored unless thenable
   * @returns {*} the result, unchanged
   */
  function trackPending(result) {
    if (!result || typeof result.then !== 'function') return result;
    pending.add(result);
    // Settle-or-fail both count as finished; errors are the handler's own
    // problem and are already reported where they happen.
    result.then(() => pending.delete(result), () => pending.delete(result));
    return result;
  }

  /**
   * Resolve once every tracked handler has finished.
   *
   * Loops because one handler can start another (a save that triggers a
   * reload). Exposed on the view definition for tests.
   */
  async function whenSettled() {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  async function loadTemplate() {
    const inline = document.getElementById('market-view-template');
    if (inline) return inline.content.cloneNode(true);

    try {
      // Cached on the DOCUMENT by QFUI, not in this module: a module-scoped
      // cache is wiped by jest.resetModules() in the suites' beforeEach, so
      // the view was re-parsed on every test.
      const fragment = await QFUI.loadViewFragment(
        'market.view.html',
        'market-view-template'
      );
      if (!fragment) {
        console.error('[market] template not found');
        return null;
      }
      return fragment;
    } catch (error) {
      console.error('[market] failed to load template:', error);
      return null;
    }
  }

  /* ------------------------------------------------------------ context */

  function renderCharacters() {
    const host = document.getElementById('mk-characters');
    if (!host) return;
    host.textContent = '';

    state.characters.forEach((c) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mk-context-row';

      const img = document.createElement('img');
      img.className = 'mk-ctx-portrait' + (c.characterId === state.defaultCharacterId ? ' is-default' : '');
      img.src = `${c.portrait}?size=64`;
      img.alt = '';
      img.setAttribute('data-fallback', 'portrait');
      row.appendChild(img);

      const text = document.createElement('span');
      text.className = 'mk-ctx-text';
      const name = document.createElement('div');
      name.className = 'mk-ctx-name';
      name.textContent = c.characterName;
      text.appendChild(name);
      row.appendChild(text);

      if (c.characterId === state.defaultCharacterId) {
        const star = icon('star', 12, { fill: 'var(--qf-gold)', stroke: 'none' });
        row.appendChild(star);
      }

      row.addEventListener('click', () =>
        window.electronAPI.window.openView('assets', { characterId: c.characterId }));
      host.appendChild(row);
    });

    QFUI.attachPortraitFallbacks(host);
  }

  /**
   * Location settings for a market set.
   *
   * A market set has NO top-level regionId/locationId — location lives inside
   * its `inputMaterials` / `outputProducts` scopes, and the two can point at
   * different markets. Reading `set.regionId` yields undefined.
   *
   * @param {object} set
   * @param {'input'|'output'} scope
   * @returns {{regionId: number|null, locationId: number|null, locationType: string|null}}
   */
  function setLocation(set, scope) {
    const cfg = (set && (scope === 'output' ? set.outputProducts : set.inputMaterials)) || {};
    return {
      regionId: cfg.regionId || null,
      locationId: cfg.locationId || null,
      locationType: cfg.locationType || null,
      structureId: cfg.structureId || null,
      structureName: cfg.structureName || null,
    };
  }

  /** Every player structure a set prices against, across both scopes. */
  function setStructureIds(set) {
    const ids = new Set();
    const input = setLocation(set, 'input');
    const output = setLocation(set, 'output');
    if (input.structureId) ids.add(input.structureId);
    if (output.structureId) ids.add(output.structureId);
    return ids;
  }

  /**
   * Human-readable region for a set's card. Shows both when the input and
   * output scopes price against different regions.
   */
  function setRegionLabel(set) {
    const names = [...setRegionIds(set)]
      .map((id) => state.regionNames.get(id) || `Region ${id}`);
    if (names.length === 0) return 'No region configured';
    return names.join(' · ');
  }

  /** Every region a set touches, across both pricing scopes. */
  function setRegionIds(set) {
    const ids = new Set();
    const input = setLocation(set, 'input');
    const output = setLocation(set, 'output');
    if (input.regionId) ids.add(input.regionId);
    if (output.regionId) ids.add(output.regionId);
    return ids;
  }

  /**
   * Where ONE scope reads its prices from, as shown in the Source column.
   *
   * Returns null when the scope prices region-wide: the region is already on
   * the card's sub-line, so naming it again here would just repeat it. The
   * caller turns a null into the word "Region".
   */
  function scopeSourceName(loc) {
    // A player structure carries its own name - it is not in market_locations,
    // which only holds NPC hubs.
    if (loc.structureName) return loc.structureName;
    if (loc.structureId) return `Structure ${loc.structureId}`;

    if (loc.locationType === 'region') return null;

    if (loc.locationId) {
      const hub = state.marketLocations.find(
        (l) => String(l.locationId) === String(loc.locationId)
      );
      if (hub) return hub.locationName;
      return `Station ${loc.locationId}`;
    }

    return null;
  }

  /** True when a scope has no location configured at all. */
  function scopeIsUnset(loc) {
    return !loc.regionId && !loc.locationId && !loc.structureId;
  }

  /**
   * Human-readable price source for a set's card. Shows both stations when the
   * input and output scopes price against different ones, and the bare word
   * "Region" when the set is region-wide (the region itself is on the
   * sub-line, so repeating it here would say nothing new).
   */
  function setSourceLabel(set) {
    const inLoc = setLocation(set, 'input');
    const outLoc = setLocation(set, 'output');

    // Nothing configured at all. Without this an unset set would read
    // "Region", claiming a scope it does not have.
    if (scopeIsUnset(inLoc) && scopeIsUnset(outLoc)) return 'Not configured';

    const input = scopeSourceName(inLoc);
    const output = scopeSourceName(outLoc);

    // Region-wide on both sides.
    if (!input && !output) return 'Region';

    // One side is a station and the other is region-wide - a real, easily
    // forgotten asymmetry, so it is spelled out rather than collapsed.
    if (input && !output) return `${input} · Region`;
    if (!input && output) return `Region · ${output}`;

    // Both stations. Identical is by far the common case - collapse it, or
    // every card would read the same name twice.
    if (input === output) return input;
    return `${input} · ${output}`;
  }

  /* ------------------------------------------------- refresh progress modal */

  /**
   * Progress for a whole market refresh.
   *
   * Held outside `state` because it is transient operation status, not view
   * data: nothing re-renders from it except the dialog, and it must survive a
   * `loadAll()` that replaces everything else.
   */
  const refreshProgress = {
    open: false,
    phase: null,
    current: 0,
    total: 0,
    label: '',
    /** ESI page counts within the current location, or null. */
    pages: null,
    /** Phases already finished, for the checklist. */
    completed: [],
  };

  /** Ordered phases, with the wording shown to the user. */
  const REFRESH_PHASES = [
    ['regions', 'Region market orders'],
    ['structures', 'Private structure orders'],
    ['adjusted-prices', 'Adjusted prices'],
    ['cost-indices', 'Industry cost indices'],
  ];

  /** Adopt a stage announcement from main and repaint. */
  function applyRefreshStage(stage) {
    if (stage.phase === 'done') {
      closeRefreshModal();
      return;
    }

    if (!refreshProgress.open) {
      refreshProgress.open = true;
      refreshProgress.completed = [];
    }

    // A new phase means the previous one finished. Recorded rather than
    // inferred at render time, so a phase with zero work (no structures
    // configured, say) still shows as done rather than being skipped silently.
    if (refreshProgress.phase && refreshProgress.phase !== stage.phase) {
      if (!refreshProgress.completed.includes(refreshProgress.phase)) {
        refreshProgress.completed.push(refreshProgress.phase);
      }
    }

    refreshProgress.phase = stage.phase;
    refreshProgress.current = stage.current || 0;
    refreshProgress.total = stage.total || 0;
    refreshProgress.label = stage.label || '';
    // Page counts belong to one location; a new stage invalidates them.
    refreshProgress.pages = null;

    renderRefreshModal();
  }

  /**
   * Tell the user what the refresh actually did.
   *
   * A refresh that skipped everything because the data was already inside its
   * cache window returns fast and successfully - indistinguishable from one
   * that fetched, which is what made a 20-minute-old region look freshly
   * updated. So a skip is stated rather than implied.
   */
  function reportRefreshOutcome(result) {
    if (!result) return;

    const skipped = result.skipped || { regions: 0, structures: 0 };
    const done = result.refreshed || { regions: 0, structures: 0 };
    const skippedTotal = skipped.regions + skipped.structures;
    const doneTotal = done.regions + done.structures;

    if (result.errors && result.errors.length) {
      toast(`Market refresh completed with ${result.errors.length} error(s)`, 'warning');
      return;
    }

    if (skippedTotal > 0 && doneTotal === 0) {
      // Nothing was fetched. The most misleading case, so it is the most
      // explicit: without this the UI simply says nothing and the freshness
      // pill keeps showing the OLD age, which reads as a failed refresh.
      toast(
        `Already up to date — ${skippedTotal} location(s) were refreshed within the last few minutes`,
        'info'
      );
      return;
    }

    if (skippedTotal > 0) {
      toast(
        `Refreshed ${doneTotal} location(s); ${skippedTotal} already current`,
        'success'
      );
      return;
    }

    toast(`Refreshed ${doneTotal} location(s)`, 'success');
  }

  function openRefreshModal() {
    refreshProgress.open = true;
    refreshProgress.phase = 'starting';
    refreshProgress.current = 0;
    refreshProgress.total = 0;
    refreshProgress.label = '';
    refreshProgress.pages = null;
    refreshProgress.completed = [];
    renderRefreshModal();
  }

  function closeRefreshModal() {
    refreshProgress.open = false;
    refreshProgress.pages = null;
    const modal = document.getElementById('mk-refresh-modal');
    if (modal) modal.hidden = true;
  }

  function renderRefreshModal() {
    const modal = document.getElementById('mk-refresh-modal');
    if (!modal) return;

    modal.hidden = !refreshProgress.open;
    if (!refreshProgress.open) return;

    const phaseLabel =
      (REFRESH_PHASES.find(([id]) => id === refreshProgress.phase) || [])[1] || 'Starting…';
    const phaseEl = document.getElementById('mk-refresh-phase');
    if (phaseEl) phaseEl.textContent = phaseLabel;

    // "Region 3 of 12", or the structure's name when there is one.
    const stepEl = document.getElementById('mk-refresh-step');
    if (stepEl) {
      if (refreshProgress.label) {
        stepEl.textContent = refreshProgress.total > 1
          ? `${refreshProgress.label} (${refreshProgress.current} of ${refreshProgress.total})`
          : refreshProgress.label;
      } else if (refreshProgress.total > 0 && refreshProgress.current > 0) {
        stepEl.textContent = `${refreshProgress.current} of ${refreshProgress.total}`;
      } else {
        stepEl.textContent = '';
      }
    }

    const pagesEl = document.getElementById('mk-refresh-pages');
    if (pagesEl) {
      // "5 of 9 pages", not "page 5 of 9" - `current` is the COUNT of pages
      // fetched so far, and pages arrive out of order, so it does not identify
      // any particular page.
      pagesEl.textContent = refreshProgress.pages
        ? `${refreshProgress.pages.current} of ${refreshProgress.pages.total} pages`
        : '';
    }

    // Overall bar: whole phases completed, plus fractional progress within the
    // current one.
    //
    // Page counts DO feed this now. They used to be excluded because they were
    // the number of the last page to finish, which arrives out of order under
    // parallel pagination and made the bar jump backwards. It is now a COUNT of
    // pages fetched, so it only ever increases and it smooths the current
    // item's share instead of the bar sitting still through a 20-page fetch.
    //
    // A page that fails out is never counted, so a partial fetch stops short of
    // its total - that is intended, and the error is reported separately.
    const fill = document.getElementById('mk-refresh-fill');
    if (fill) {
      const total = REFRESH_PHASES.length;
      const doneCount = refreshProgress.completed.length;
      // `current` counts items STARTED, so the current item's share is already
      // included. Page counts refine that last item's share - but only when we
      // actually have them: `pages` is null for a single-page item and between
      // stages, and subtracting a whole item there would walk the bar backwards.
      const pages = refreshProgress.pages;
      const items = refreshProgress.current;
      const itemsDone = pages && pages.total > 0
        ? Math.max(items - 1, 0) + Math.min(pages.current / pages.total, 1)
        : items;
      const within = refreshProgress.total > 0
        ? Math.min(itemsDone / refreshProgress.total, 1)
        : 0;
      const ratio = Math.min((doneCount + within) / total, 1);
      fill.style.width = `${Math.round(ratio * 100)}%`;
    }

    const list = document.getElementById('mk-refresh-steps');
    if (list) {
      list.textContent = '';
      REFRESH_PHASES.forEach(([id, label]) => {
        const li = document.createElement('li');
        const done = refreshProgress.completed.includes(id);
        const active = refreshProgress.phase === id;
        li.className = `mk-refresh-step${done ? ' is-done' : ''}${active ? ' is-active' : ''}`;
        li.textContent = label;
        list.appendChild(li);
      });
    }
  }

  /**
   * In-flight ESI progress for a set, or null when nothing it prices against is
   * currently being fetched.
   *
   * STRUCTURES ARE CHECKED FIRST. A set pinned to a player structure is served
   * by that structure's own endpoint, so the region-wide fetch covering the
   * same space is not its progress - reporting it showed a Jita 4-4 card
   * advancing on work done for The Forge.
   *
   * A set can span two locations (input and output priced in different places),
   * fetched one after another, so the first with live progress is the one to
   * report.
   */
  function setProgress(set) {
    for (const structureId of setStructureIds(set)) {
      const p = state.fetchProgress.get(`structure:${structureId}`);
      if (p) return { ...p, label: structureLabel(set, structureId) };
    }

    // Only fall back to the region when this set is NOT pinned to a structure.
    // Otherwise a structure-scoped set borrows its region's progress again.
    if (setStructureIds(set).size === 0) {
      for (const regionId of setRegionIds(set)) {
        const p = state.fetchProgress.get(`region:${regionId}`);
        if (p) return { ...p, label: state.regionNames.get(regionId) || `Region ${regionId}` };
      }
    }

    return null;
  }

  /** Display name for a structure a set prices against. */
  function structureLabel(set, structureId) {
    const input = setLocation(set, 'input');
    const output = setLocation(set, 'output');
    if (String(input.structureId) === String(structureId) && input.structureName) {
      return input.structureName;
    }
    if (String(output.structureId) === String(structureId) && output.structureName) {
      return output.structureName;
    }
    return `Structure ${structureId}`;
  }

  /** Freshness level for a market set, using the shared threshold scheme. */
  function setFreshness(set) {
    // Region dashboard carries per-region lastFetch; a set may span several.
    const regionIds = setRegionIds(set);
    const entries = state.dashboard.filter((d) => regionIds.has(d.regionId));
    const oldest = entries.reduce((acc, d) => {
      const t = d.lastFetch || d.lastFetchTime || null;
      if (!t) return acc;
      return acc === null ? t : Math.min(acc, t);
    }, null);
    return QFFreshness.getFreshness(oldest !== null ? oldest : state.lastFetch);
  }

  function renderSetList() {
    const host = document.getElementById('mk-set-list');
    if (!host) return;
    host.textContent = '';

    if (state.sets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mk-ctx-sub';
      empty.style.padding = '4px 8px';
      empty.textContent = 'No market sets';
      host.appendChild(empty);
      return;
    }

    state.sets.forEach((set) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mk-context-row' + (set.id === state.activeSetId ? ' is-active' : '');

      const fresh = setFreshness(set);
      const dot = document.createElement('span');
      dot.className = 'mk-ctx-dot is-' + (fresh.level === 'fresh' ? 'fresh' : fresh.level === 'warn' ? 'warn' : 'stale');
      row.appendChild(dot);

      const text = document.createElement('span');
      text.className = 'mk-ctx-text';
      const name = document.createElement('div');
      name.className = 'mk-ctx-name';
      name.textContent = set.name || 'Unnamed set';
      text.appendChild(name);
      const sub = document.createElement('div');
      sub.className = 'mk-ctx-sub';
      sub.textContent = set.isDefault ? `Default · ${fresh.label}` : fresh.label;
      text.appendChild(sub);
      row.appendChild(text);

      row.addEventListener('click', () => selectMarketSet(set.id));
      host.appendChild(row);
    });
  }

  /**
   * Switch the active market set.
   *
   * Everything priced is set-scoped: the order book and the filter results are
   * queried per REGION, and the inspector's prices, drift and re-lock values
   * all derive from them. Re-rendering alone would keep showing the previous
   * set's numbers under the new set's name, so the data is reloaded first.
   *
   * @param {number|string} setId
   */
  async function selectMarketSet(setId) {
    if (state.activeSetId === setId) return;
    state.activeSetId = setId;

    // Repaint the context pane immediately so the selection feels instant,
    // then refresh the data that depends on it.
    renderSetList();

    // An active filter is region-scoped, so re-run it against the new set
    // (this also refreshes the order book for whatever it returns).
    // renderPricing refreshes the inspector as part of its repaint, so the
    // price card, plan drift and re-lock values follow the new set too.
    if (state.query.trim().length >= 2) {
      await runPricingSearch();
    } else {
      await loadSafely('orderBook', loadOrderBook);
      renderSafely('pricing', renderPricing);
    }

    // Watchlist prices are NOT refreshed here: a watchlist is bound to its own
    // market set, so changing the left-pane selection must not move it. Only
    // the Pricing tab and inspector follow that selection.
  }

  /* ------------------------------------------------------------ pricing */

  /**
   * The market set selected in the left pane. Drives the Pricing tab and the
   * inspector - NOT watchlist pricing, which follows its own bound set.
   */
  function activeSet() {
    return findMarketSet(state.activeSetId)
      || defaultMarketSet();
  }

  /** The configured default set, independent of the left-pane selection. */
  function defaultMarketSet() {
    return state.sets.find((s) => s.isDefault) || state.sets[0] || null;
  }

  function renderSummary() {
    const host = document.getElementById('mk-summary');
    if (!host) return;
    host.textContent = '';

    const set = activeSet();
    if (!set) return;

    const fresh = setFreshness(set);
    const cells = [
      { label: 'Market Set', value: set.name || 'Unnamed' },
      {
        label: 'Data Age',
        value: fresh.label,
        tone: fresh.level === 'fresh' ? 'fresh' : fresh.level === 'warn' ? 'warning' : 'error',
      },
      { label: 'Overrides', value: num(state.overrides.length) },
      { label: 'Market Sets', value: num(state.sets.length) },
    ];

    cells.forEach(({ label, value, tone }) => {
      const cell = document.createElement('div');
      cell.className = 'mk-summary-cell';
      const l = document.createElement('div');
      l.className = 'mk-summary-label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'mk-summary-value' + (tone ? ` is-${tone}` : '');
      v.textContent = value;
      cell.appendChild(l);
      cell.appendChild(v);
      host.appendChild(cell);
    });
  }

  /**
   * Items shown on the Pricing tab.
   *
   * A market set has NO item list - inputMaterials/outputProducts are pricing
   * CONFIG objects (location, method, modifiers), not arrays of items. The row
   * universe is therefore the items the user has actually touched: overrides,
   * favourites, and watchlist members.
   *
   * Buy/Sell/Volume are still "--"; the per-item pricing read is outstanding.
   */
  function pricingRows() {
    const set = activeSet();
    if (!set) return [];

    // A market set carries pricing CONFIG (location, method, modifiers) - it
    // has no item list, so there is no per-set universe to enumerate. The rows
    // are therefore the items the user has actually touched: price overrides,
    // favourites, and anything on a watchlist.
    const ids = new Set();
    state.overrides.forEach((o) => ids.add(o.typeId));
    state.favourites.forEach((typeId) => ids.add(typeId));
    // Every watchlist, not just the active one: the Pricing tab is a view of
    // everything you track, priced against the market selected on the left.
    state.allWatchTypeIds.forEach((typeId) => ids.add(typeId));

    // With a query, the rows become the region-scoped search results instead:
    // the user is looking through everything traded in this market, not just
    // the items they have already touched.
    const q = state.query.trim();
    const source = q.length >= 2
      ? state.searchResults.map((r) => r.typeId)
      : [...ids];

    return source
      .map((typeId) => {
        const override = state.overrides.find((o) => o.typeId === typeId);
        const book = state.orderBook.get(typeId) || {};
        return {
          typeId,
          name: state.typeNames.get(typeId) || (override && override.name) || `Type ${typeId}`,
          override: override ? override.price : null,
          notes: override ? override.notes : '',
          buy: book.buy ?? null,
          sell: book.sell ?? null,
          volume: book.volume ?? null,
        };
      })
      .sort((a, b) => {
        const fa = state.favourites.has(a.typeId) ? 0 : 1;
        const fb = state.favourites.has(b.typeId) ? 0 : 1;
        return fa - fb || String(a.name).localeCompare(String(b.name));
      });
  }

  function renderPricing() {
    renderSummary();

    const body = document.getElementById('mk-rows');
    const empty = document.getElementById('mk-rows-empty');
    if (!body) return;
    body.textContent = '';

    const rows = pricingRows();
    if (empty) {
      empty.hidden = rows.length > 0;
      // The filter is region-scoped, so "no results" usually means the region
      // has no cached orders - say so rather than implying the item is unknown.
      const searching = state.query.trim().length >= 2;
      const heading = empty.querySelector('p');
      const sub = empty.querySelector('small');
      if (heading && sub) {
        if (searching) {
          heading.textContent = `Nothing traded here matches "${state.query.trim()}"`;
          sub.textContent = 'Only items with cached orders in this market are searchable. Refresh market data if this looks wrong.';
        } else {
          heading.textContent = 'No items yet';
          sub.textContent = 'Favourite an item, add a price override, or put one on a watchlist to track it here.';
        }
      }
    }

    rows.forEach((row) => {
      const tr = document.createElement('tr');
      if (row.typeId === state.selectedTypeId) tr.classList.add('is-selected');

      // Favourite
      const favTd = document.createElement('td');
      const fav = document.createElement('button');
      fav.type = 'button';
      fav.className = 'mk-fav' + (state.favourites.has(row.typeId) ? ' is-on' : '');
      fav.title = state.favourites.has(row.typeId) ? 'Unfavourite' : 'Favourite';
      fav.appendChild(icon('star', 13, state.favourites.has(row.typeId)
        ? { fill: 'currentColor', stroke: 'none' }
        : {}));
      fav.addEventListener('click', async (e) => {
        e.stopPropagation();
        // Optimistic toggle, reconciled against what the DB actually stored.
        const wasOn = state.favourites.has(row.typeId);
        if (wasOn) state.favourites.delete(row.typeId);
        else state.favourites.add(row.typeId);
        renderPricing();

        try {
          const res = await window.electronAPI.market.favorites.toggle(row.typeId);
          const isOn = res && res.success ? res.isFavorite : wasOn;
          if (isOn) state.favourites.add(row.typeId);
          else state.favourites.delete(row.typeId);
        } catch (error) {
          console.error('[market] favourite toggle failed:', error);
          if (wasOn) state.favourites.add(row.typeId);
          else state.favourites.delete(row.typeId);
        }
        renderPricing();
      });
      favTd.appendChild(fav);
      tr.appendChild(favTd);

      const nameTd = document.createElement('td');
      nameTd.textContent = row.name;
      tr.appendChild(nameTd);

      // Live order-book values. An override replaces the SELL figure wherever
      // the app prices this item, so show it there and mark the row.
      const buyTd = document.createElement('td');
      buyTd.className = 'mk-num mk-buy';
      buyTd.textContent = row.buy !== null ? isk(row.buy) : '--';
      tr.appendChild(buyTd);

      const sellTd = document.createElement('td');
      sellTd.className = 'mk-num mk-sell';
      if (row.override !== null) {
        sellTd.textContent = isk(row.override);
        sellTd.title = row.sell !== null
          ? `Overridden. Market sell is ${isk(row.sell)}.`
          : 'Overridden.';
      } else {
        sellTd.textContent = row.sell !== null ? isk(row.sell) : '--';
      }
      tr.appendChild(sellTd);

      const volTd = document.createElement('td');
      volTd.className = 'mk-num';
      volTd.textContent = row.volume ? num(row.volume) : '--';
      tr.appendChild(volTd);

      const confTd = document.createElement('td');
      const conf = document.createElement('span');
      const hasData = row.buy !== null || row.sell !== null;
      conf.className = 'mk-conf is-' + (row.override !== null ? 'high' : hasData ? 'medium' : 'low');
      conf.textContent = row.override !== null ? 'Override' : hasData ? 'Market' : 'No data';
      confTd.appendChild(conf);
      tr.appendChild(confTd);

      // Per-row shortcut into the full market data drawer.
      const dataTd = document.createElement('td');
      dataTd.className = 'mk-col-actions';
      const dataBtn = document.createElement('button');
      dataBtn.type = 'button';
      dataBtn.className = 'mk-data-btn';
      dataBtn.title = 'View market data';
      dataBtn.appendChild(icon('bars', 12));
      dataBtn.appendChild(document.createTextNode('Data'));
      dataBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.selectedTypeId = row.typeId;
        openMarketDrawer(row.typeId);
      });
      dataTd.appendChild(dataBtn);
      tr.appendChild(dataTd);

      tr.addEventListener('click', () => {
        state.selectedTypeId = row.typeId;
        renderPricing();
      });

      body.appendChild(tr);
    });

    // Keep the inspector in step with the table. Doing this here rather than
    // only in the row click handler means ANY repaint - a market refresh, a
    // market-set change, a filter - refreshes the inspector's prices too,
    // instead of leaving the previously selected item showing stale numbers.
    const selected = rows.find((r) => r.typeId === state.selectedTypeId) || null;
    renderInspector(selected);
  }

  /**
   * Inspector for the selected pricing row, following the mockup:
   *
   *   header        "<item> · Inspector"
   *   price card    live sell (large) + buy
   *   action        View Full Market Data ->
   *   plans         each plan using this item, its locked price and drift
   *
   * The plans section is the reason the inspector exists: it answers "if I
   * re-price this item, which plans are stale?" without leaving the view.
   */
  function renderInspector(row) {
    const emptyEl = document.getElementById('mk-inspector-empty');
    const bodyEl = document.getElementById('mk-inspector-body');
    const titleEl = document.getElementById('mk-inspector-title');
    if (!bodyEl) return;

    if (!row) {
      if (emptyEl) emptyEl.hidden = false;
      if (titleEl) titleEl.textContent = 'Inspector';
      bodyEl.hidden = true;
      return;
    }

    if (emptyEl) emptyEl.hidden = true;
    if (titleEl) titleEl.textContent = `${row.name} · Inspector`;
    bodyEl.hidden = false;
    bodyEl.textContent = '';

    const book = state.orderBook.get(row.typeId) || {};

    // ---- price card ----
    const card = document.createElement('div');
    card.className = 'mk-card';
    const bar = document.createElement('div');
    bar.className = 'mk-card-bar';
    card.appendChild(bar);

    const cardBody = document.createElement('div');
    cardBody.className = 'mk-insp-price';

    const sellWrap = document.createElement('div');
    const sellLabel = document.createElement('div');
    sellLabel.className = 'mk-insp-price-label';
    const setName = (activeSet() || {}).name || 'market';
    sellLabel.textContent = `Live sell (${setName})`;
    const sellValue = document.createElement('div');
    sellValue.className = 'mk-insp-price-value';
    // An override replaces the sell price everywhere the app prices this item.
    sellValue.textContent = row.override !== null
      ? isk(row.override)
      : Number.isFinite(book.sell) ? isk(book.sell) : '--';
    sellWrap.appendChild(sellLabel);
    sellWrap.appendChild(sellValue);
    cardBody.appendChild(sellWrap);

    const buyWrap = document.createElement('div');
    buyWrap.className = 'mk-insp-buy';
    const buyLabel = document.createElement('div');
    buyLabel.className = 'mk-insp-price-label';
    buyLabel.textContent = 'Buy';
    const buyValue = document.createElement('div');
    buyValue.className = 'mk-insp-buy-value';
    buyValue.textContent = Number.isFinite(book.buy) ? isk(book.buy) : '--';
    buyWrap.appendChild(buyLabel);
    buyWrap.appendChild(buyValue);
    cardBody.appendChild(buyWrap);

    card.appendChild(cardBody);
    bodyEl.appendChild(card);

    if (row.override !== null) {
      const note = document.createElement('div');
      note.className = 'mk-insp-override-note';
      note.textContent = Number.isFinite(book.sell)
        ? `Overridden — market sell is ${isk(book.sell)}.`
        : 'Overridden.';
      bodyEl.appendChild(note);
    }

    // ---- View Full Market Data ----
    const viewData = document.createElement('button');
    viewData.type = 'button';
    viewData.className = 'mk-insp-action';
    const viewLeft = document.createElement('span');
    viewLeft.className = 'mk-insp-action-label';
    viewLeft.appendChild(icon('bars', 16));
    viewLeft.appendChild(document.createTextNode('View Full Market Data'));
    viewData.appendChild(viewLeft);
    viewData.appendChild(icon('chevronRight', 16, { strokeWidth: 2 }));
    viewData.addEventListener('click', () => openMarketDrawer(row.typeId));
    bodyEl.appendChild(viewData);

    // ---- plans using this item ----
    const plansHead = document.createElement('div');
    plansHead.className = 'mk-insp-section';
    const plansTitle = document.createElement('span');
    plansTitle.className = 'mk-insp-section-title';
    plansTitle.textContent = `Plans using ${row.name}`;
    const plansCount = document.createElement('span');
    plansCount.className = 'mk-insp-section-count';
    plansCount.id = 'mk-insp-plan-count';
    plansHead.appendChild(plansTitle);
    plansHead.appendChild(plansCount);
    bodyEl.appendChild(plansHead);

    const lockNote = document.createElement('div');
    lockNote.className = 'mk-insp-lock-note';
    lockNote.appendChild(icon('lock', 14, { stroke: 'var(--qf-text-muted)' }));
    const lockText = document.createElement('span');
    lockText.textContent =
      'Plans hold the price you locked. They never auto-update on a market refresh — re-lock to capture the current market.';
    lockNote.appendChild(lockText);
    bodyEl.appendChild(lockNote);

    const plansHost = document.createElement('div');
    plansHost.className = 'mk-insp-plans';
    plansHost.id = 'mk-insp-plans';
    bodyEl.appendChild(plansHost);

    loadInspectorPlans(row);
  }

  /** Fetch and render the plans referencing the inspected item. */
  async function loadInspectorPlans(row, options = {}) {
    const host = document.getElementById('mk-insp-plans');
    const countEl = document.getElementById('mk-insp-plan-count');
    if (!host) return;

    // renderInspector runs on EVERY table repaint (favourite toggle, market
    // refresh, set change), so the plan list is cached per type. Without this
    // a single favourite click would fire two identical IPC round trips.
    // A re-lock passes force to bypass it.
    let plans = state.planCache.get(row.typeId);
    if (!plans || options.force) {
      try {
        const res = await window.electronAPI.market.getPlansUsingType(row.typeId);
        plans = res && res.success ? res.plans : [];
        state.planCache.set(row.typeId, plans);
      } catch (error) {
        console.error('[market] failed to load plans using type:', error);
        plans = [];
      }
    }

    // The row may have changed while this was in flight.
    if (state.selectedTypeId !== row.typeId) return;
    if (countEl) countEl.textContent = String(plans.length);

    host.textContent = '';

    if (plans.length === 0) {
      const none = document.createElement('div');
      none.className = 'mk-insp-noplans';
      none.textContent = `No manufacturing plans reference ${row.name} yet.`;
      host.appendChild(none);
      return;
    }

    const book = state.orderBook.get(row.typeId) || {};
    const marketPrice = Number.isFinite(book.sell) ? book.sell : null;

    plans.forEach((plan) => {
      host.appendChild(buildPlanCard(row, plan, marketPrice));
    });
  }

  /** One plan card: locked price, drift, and a re-lock action. */
  function buildPlanCard(row, plan, marketPrice) {
    const card = document.createElement('div');
    card.className = 'mk-plan-card';

    const head = document.createElement('div');
    head.className = 'mk-plan-head';
    const name = document.createElement('span');
    name.className = 'mk-plan-name';
    name.textContent = plan.planName;
    head.appendChild(name);

    // Drift is measured against the price the last lock captured. While an
    // override is active price_each is the OVERRIDE, so lastMarketPrice is the
    // only honest baseline - see getPlansUsingType.
    const baseline = plan.isOverride ? plan.lastMarketPrice : plan.lockedPrice;
    const drift = document.createElement('span');
    drift.className = 'mk-plan-drift';
    if (marketPrice !== null && Number.isFinite(baseline) && baseline > 0) {
      const pct = ((marketPrice - baseline) / baseline) * 100;
      drift.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% drift`;
      drift.title = plan.isOverride
        ? 'How far the market has moved since this plan last locked market data'
        : 'How far the market has moved since this plan locked its price';
      drift.classList.add(Math.abs(pct) < 1 ? 'is-flat' : pct > 0 ? 'is-up' : 'is-down');
    } else {
      drift.textContent = 'no baseline';
      drift.title = 'No market lock has been recorded for this item yet';
      drift.classList.add('is-flat');
    }
    head.appendChild(drift);
    card.appendChild(head);

    const lockedRow = document.createElement('div');
    lockedRow.className = 'mk-plan-row';
    const lockedLabel = document.createElement('span');
    lockedLabel.textContent = plan.isOverride ? 'Override' : 'Locked';
    const lockedValue = document.createElement('span');
    lockedValue.className = 'mk-plan-value';
    lockedValue.textContent = isk(plan.lockedPrice);
    if (plan.lockedAt) {
      const when = document.createElement('span');
      when.className = 'mk-plan-when';
      when.textContent = ` · ${QFFreshness.formatAge(plan.lockedAt)}`;
      lockedValue.appendChild(when);
    }
    lockedRow.appendChild(lockedLabel);
    lockedRow.appendChild(lockedValue);
    card.appendChild(lockedRow);

    if (plan.isOverride && Number.isFinite(plan.lastMarketPrice)) {
      const lockedMarket = document.createElement('div');
      lockedMarket.className = 'mk-plan-row';
      const l = document.createElement('span');
      l.textContent = 'Locked market';
      const v = document.createElement('span');
      v.className = 'mk-plan-value';
      v.textContent = isk(plan.lastMarketPrice);
      lockedMarket.appendChild(l);
      lockedMarket.appendChild(v);
      card.appendChild(lockedMarket);
    }

    const marketRow = document.createElement('div');
    marketRow.className = 'mk-plan-row';
    const marketLabel = document.createElement('span');
    marketLabel.textContent = 'Market now';
    const marketValue = document.createElement('span');
    marketValue.className = 'mk-plan-value is-accent';
    marketValue.textContent = marketPrice !== null ? isk(marketPrice) : '--';
    marketRow.appendChild(marketLabel);
    marketRow.appendChild(marketValue);
    card.appendChild(marketRow);

    // Two different questions, so both are answered. The drift badge above says
    // "has the market moved since I locked?" (what Re-lock acts on); this says
    // "is my pinned price still realistic?" (what affects plan profitability).
    if (plan.isOverride && marketPrice !== null && marketPrice > 0) {
      const gap = ((plan.lockedPrice - marketPrice) / marketPrice) * 100;
      const note = document.createElement('div');
      note.className = 'mk-plan-override-gap ' + (gap >= 0 ? 'is-above' : 'is-below');
      note.textContent =
        `Override is ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}% vs market`;
      card.appendChild(note);
    }

    if (marketPrice !== null) {
      const relock = document.createElement('button');
      relock.type = 'button';
      relock.className = 'secondary-button mk-plan-relock';
      relock.appendChild(icon('refresh', 13));
      const label = document.createElement('span');
      label.className = 'btn-label';
      label.textContent = `Re-lock at ${isk(marketPrice)}`;
      relock.appendChild(label);
      relock.addEventListener('click', () => relockPlan(plan, row, marketPrice, relock));
      card.appendChild(relock);
    }

    return card;
  }

  /** Re-lock one material in one plan, reporting what actually changed. */
  async function relockPlan(plan, row, marketPrice, button) {
    // withButtonBusy restores in a `finally`, and no-ops if the reload below
    // has already replaced this button - the hand-rolled version had no
    // restore at all and relied on that re-render to clear the disabled state.
    await QFUI.withButtonBusy(button, 'Re-locking…', async () => {
      try {
        const res = await window.electronAPI.market.relockPlanMaterial(
          plan.planId,
          row.typeId,
          marketPrice
        );

        if (res && res.success && res.overridden) {
          // The override still wins for the plan's price - say so, rather than
          // implying the plan's cost changed.
          toast(
            `Market re-locked at ${isk(marketPrice)}. ${plan.planName} still uses ` +
            `your override of ${isk(res.overridePrice)}.`,
            'info'
          );
        } else if (res && res.success) {
          toast(`${plan.planName}: ${row.name} re-locked at ${isk(marketPrice)}.`, 'success');
        } else {
          toast(`Could not re-lock ${row.name} in ${plan.planName}.`, 'error');
        }
      } catch (error) {
        console.error('[market] re-lock failed:', error);
        toast(`Could not re-lock ${row.name} in ${plan.planName}.`, 'error');
      }

      await loadInspectorPlans(row, { force: true });
    });
  }

  /* ----------------------------------------------------------- overview */

  function renderOverview() {
    const host = document.getElementById('mk-set-cards');
    if (!host) return;
    host.textContent = '';

    state.sets.forEach((set) => {
      const fresh = setFreshness(set);
      const level = fresh.level === 'fresh' ? 'fresh' : fresh.level === 'warn' ? 'warn' : 'stale';

      const card = document.createElement('div');
      card.className = `mk-set-card is-${level}`;

      const bar = document.createElement('div');
      bar.className = 'mk-set-bar';
      card.appendChild(bar);

      const body = document.createElement('div');
      body.className = 'mk-set-body';

      // --- col 1: name + default star + region ---
      const identity = document.createElement('div');

      const name = document.createElement('div');
      name.className = 'mk-set-name';
      const nameText = document.createElement('span');
      nameText.textContent = set.name || 'Unnamed set';
      name.appendChild(nameText);

      // The star both marks and toggles the default set, per the mockup.
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'mk-set-star' + (set.isDefault ? ' is-on' : '');
      star.title = set.isDefault ? 'Default market set' : 'Make this the default';
      star.setAttribute('aria-pressed', set.isDefault ? 'true' : 'false');
      star.appendChild(icon('star', 11, set.isDefault
        ? { fill: 'currentColor', strokeWidth: 1.6 }
        : { fill: 'none', strokeWidth: 1.6 }));
      const starLabel = document.createElement('span');
      starLabel.textContent = set.isDefault ? 'Default' : 'Set default';
      star.appendChild(starLabel);
      star.addEventListener('click', async () => {
        if (set.isDefault) return;
        try {
          await window.electronAPI.market.setDefaultMarketSet(set.id);
          await loadAll();
        } catch (error) {
          console.error('[market] failed to set default market set:', error);
        }
      });
      name.appendChild(star);
      identity.appendChild(name);

      const region = document.createElement('div');
      region.className = 'mk-set-region';
      region.textContent = setRegionLabel(set);
      identity.appendChild(region);
      body.appendChild(identity);

      // --- col 2: price source ---
      // The mockup shows an item count here, but a market set holds no item
      // list - only pricing config, so there is nothing to count. The card's
      // job is "which market am I pricing against", so this names the STATION
      // (or structure) the prices come from, or reads "Region" when the set
      // prices region-wide. The region itself stays on the sub-line above.
      const sourceCol = document.createElement('div');
      const sourceLabel = document.createElement('div');
      sourceLabel.className = 'mk-set-col-label';
      sourceLabel.textContent = 'Source';
      sourceCol.appendChild(sourceLabel);
      const sourceValue = document.createElement('div');
      sourceValue.className = 'mk-set-col-value mk-set-source';
      sourceValue.textContent = setSourceLabel(set);
      // Station names are long and the column is narrow, so the full value
      // has to stay reachable on hover.
      sourceValue.title = sourceValue.textContent;
      sourceCol.appendChild(sourceValue);
      body.appendChild(sourceCol);

      // --- col 3: status (refreshing bar, or freshness pill) ---
      const statusCol = document.createElement('div');
      const statusLabel = document.createElement('div');
      statusLabel.className = 'mk-set-col-label';
      statusLabel.textContent = 'Status';
      statusCol.appendChild(statusLabel);

      if (state.refreshingSets.has(set.id)) {
        // Indeterminate by design. The card cannot honestly show a percentage:
        // a refresh covers regions and structures that map onto sets many-to-
        // many, so "this set's progress" is not a well-defined quantity. The
        // real figures live in the refresh dialog, which reports the operation.
        const live = document.createElement('div');
        live.className = 'mk-set-updating';
        const dot = document.createElement('span');
        dot.className = 'mk-set-pulse';
        live.appendChild(dot);
        live.appendChild(document.createTextNode('Updating from ESI…'));
        statusCol.appendChild(live);

        const track = document.createElement('div');
        track.className = 'mk-set-progress';
        track.appendChild(document.createElement('span'));
        statusCol.appendChild(track);
      } else {
        const pill = document.createElement('span');
        pill.className = `mk-set-status is-${level}`;
        pill.appendChild(icon('clock', 12));
        pill.appendChild(document.createTextNode(`Updated ${fresh.label}`));
        statusCol.appendChild(pill);
      }
      body.appendChild(statusCol);

      // --- col 4: actions ---
      const actions = document.createElement('div');
      actions.className = 'mk-set-actions';

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'secondary-button mk-set-edit';
      edit.appendChild(icon('pencil', 13));
      const editLabel = document.createElement('span');
      editLabel.className = 'btn-label';
      editLabel.textContent = 'Edit';
      edit.appendChild(editLabel);
      edit.addEventListener('click', () => openSetEditor(set));
      actions.appendChild(edit);

      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'mk-icon-btn mk-set-refresh';
      refresh.title = `Refresh ${set.name || 'this set'}`;
      refresh.setAttribute('aria-label', 'Refresh market set');
      refresh.disabled = state.refreshingSets.has(set.id);
      refresh.appendChild(icon('refresh', 15));
      refresh.addEventListener('click', () => refreshSet(set));
      actions.appendChild(refresh);

      body.appendChild(actions);
      card.appendChild(body);
      host.appendChild(card);
    });
  }

  /* -------------------------------------------------- market set editor */

  // Verbatim from the mockup's LOCTYPES, including the descriptions shown on
  // each radio card. 'hub' and 'station' are DISTINCT types.
  const LOCATION_TYPES = [
    { value: 'hub', label: 'Trade Hub', desc: 'Jita, Amarr, Dodixie, Rens, Hek' },
    { value: 'station', label: 'Specific Station', desc: 'Choose system, then station' },
    { value: 'system', label: 'Solar System', desc: 'All stations in a system' },
    { value: 'region', label: 'Entire Region', desc: 'All systems in a region' },
    { value: 'private_structure', label: 'Private Structure', desc: 'Citadel or Engineering Complex with market' },
  ];

  const PRICE_TYPES = [
    { value: 'sell', label: 'Sell orders' },
    { value: 'buy', label: 'Buy orders' },
  ];

  const PRICE_METHODS = [
    { value: 'immediate', label: 'Immediate (best order)' },
    { value: 'vwap', label: 'VWAP (volume weighted)' },
    { value: 'percentile', label: 'Percentile' },
    { value: 'historical', label: 'Historical average' },
    { value: 'hybrid', label: 'Hybrid' },
  ];

  /** Working copy of the set being edited; committed only on save. */
  let setDraft = null;
  let setEditorMode = 'create';

  /** Build one scope's fields. Both scopes use this so they stay identical. */
  /**
   * Build one scope's fields, following the mockup's structure exactly:
   *
   *   Location Type   5 radio cards in a 2-column grid (label + description)
   *   <picker>        varies by the selected type
   *   ----            divider
   *   Price Type | Calculation Method
   *   Price Modifier (%) | Percentile Threshold
   *   Minimum Order Volume
   *
   * Both scopes use this, so input and output stay identical.
   */
  function buildScopeFields(scope) {
    const host = document.getElementById(`mk-scope-${scope}`);
    if (!host) return;
    destroySearchSelects(scope);
    host.textContent = '';

    const cfg = setDraft[scope];

    // When the output scope mirrors the input's location, the mockup REMOVES
    // the whole location block (`sc-if showOutputLoc`) - the pricing fields
    // below stay fully editable, because the two scopes still price
    // differently even at the same market.
    const showLocation = scope === 'input' || !isMirrored();

    if (showLocation) {
      buildLocationSection(scope, cfg, host);
      host.appendChild(scopeDivider());
    }

    buildPricingSection(scope, cfg, host);
  }

  /** True when the output scope is set to follow the input's location. */
  function isMirrored() {
    const mirror = document.getElementById('mk-set-mirror');
    return !!(mirror && mirror.checked);
  }

  /** Location Type cards + the picker for the selected type. */
  function buildLocationSection(scope, cfg, host) {
    const typeLabel = document.createElement('div');
    typeLabel.className = 'mk-loc-label';
    typeLabel.textContent = 'Location Type';
    host.appendChild(typeLabel);

    const cards = document.createElement('div');
    cards.className = 'mk-loc-cards';
    locationTypesFor(scope).forEach((t) => {
      const on = cfg.locationType === t.value;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'mk-loc-card' + (on ? ' is-on' : '');
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', on ? 'true' : 'false');

      const dot = document.createElement('span');
      dot.className = 'mk-loc-dot';
      if (on) dot.appendChild(document.createElement('span'));
      card.appendChild(dot);

      const text = document.createElement('span');
      text.className = 'mk-loc-text';
      const name = document.createElement('span');
      name.className = 'mk-loc-name';
      name.textContent = t.label;
      const desc = document.createElement('span');
      desc.className = 'mk-loc-desc';
      desc.textContent = t.desc;
      text.appendChild(name);
      text.appendChild(desc);
      card.appendChild(text);

      card.addEventListener('click', () => {
        cfg.locationType = t.value;
        // Clear the previous selection: a station id is meaningless as a system.
        cfg.locationId = null;
        cfg.systemId = null;
        cfg.systemName = null;
        cfg.structureId = null;
        cfg.structureName = null;
        buildScopeFields(scope);
        if (scope === 'input') applyMirrorState();
        updateSetSummary();
      });

      cards.appendChild(card);
    });
    host.appendChild(cards);

    // ---- the picker for the chosen type ----
    const picker = document.createElement('div');
    picker.className = 'mk-loc-picker';
    buildLocationPicker(scope, cfg, picker);
    host.appendChild(picker);
  }

  /**
   * Price type, method, modifier, percentile and minimum volume.
   *
   * Always rendered for BOTH scopes - mirroring the location does not mean
   * mirroring the pricing, since inputs are typically bought and outputs sold
   * at the same market.
   */
  function buildPricingSection(scope, cfg, host) {
    const row1 = document.createElement('div');
    row1.className = 'mk-scope-grid';
    row1.appendChild(labelledField('Price Type', selectControl(PRICE_TYPES, cfg.priceType, (v) => {
      cfg.priceType = v;
      updateSetSummary();
    })));
    row1.appendChild(labelledField('Calculation Method', selectControl(PRICE_METHODS, cfg.priceMethod, (v) => {
      cfg.priceMethod = v;
      updateSetSummary();
    })));
    host.appendChild(row1);

    const row2 = document.createElement('div');
    row2.className = 'mk-scope-grid';
    row2.appendChild(labelledField(
      'Price Modifier (%)',
      numberControl(
        cfg.priceModifier === null || cfg.priceModifier === undefined
          ? 100
          : Math.round(cfg.priceModifier * 100),
        (v) => { cfg.priceModifier = v === '' ? 1 : Number(v) / 100; updateSetSummary(); },
        { min: 0, max: 200, step: 1 }
      ),
      'Apply a percentage adjustment (100 = no change)'
    ));
    // Percentile stays 0-1 with a 0.05 step, as the mockup specifies.
    row2.appendChild(labelledField(
      'Percentile Threshold',
      numberControl(
        cfg.percentile === null || cfg.percentile === undefined ? 0.2 : cfg.percentile,
        (v) => { cfg.percentile = v === '' ? 0.2 : Number(v); },
        { min: 0, max: 1, step: 0.05 }
      ),
      'For percentile method (0.2 = 20th percentile)'
    ));
    host.appendChild(row2);

    const row3 = document.createElement('div');
    row3.className = 'mk-scope-grid';
    row3.appendChild(labelledField(
      'Minimum Order Volume',
      numberControl(cfg.minVolume, (v) => { cfg.minVolume = v === '' ? 1 : Number(v); }, { min: 1, step: 100 }),
      'Ignore orders below this volume'
    ));
    host.appendChild(row3);
  }

  /**
   * Location types offered for a scope - the same five for both.
   *
   * DELIBERATE DIVERGENCE FROM THE MOCKUP (confirmed with the user): the
   * mockup offers all five cards on both scopes, but its OUTPUT picker only
   * implements three branches - `outIsHub`, `outIsRegion`, and a catch-all
   * `outIsOther` (station | system | private_structure) that renders a generic
   * "Select Location" box with an empty list. Input implements all five.
   *
   * That is a gap in the mockup, not a design decision: both scopes persist
   * the identical config shape and both feed calculateRealisticPrice the same
   * way, so a station or private structure is exactly as valid for outputs as
   * for inputs. buildLocationPicker is therefore scope-agnostic, which makes
   * the two sides behave identically.
   */
  function locationTypesFor() {
    return LOCATION_TYPES;
  }

  function scopeDivider() {
    const el = document.createElement('div');
    el.className = 'mk-scope-divider';
    return el;
  }

  /**
   * Mount a shared QFSearchSelect as a labelled field.
   *
   * Every searchable dropdown in this view goes through here (binding rule 5:
   * never fork the shared component). Instances are tracked so they can be
   * destroyed when the form is rebuilt - otherwise each rebuild leaks a
   * document-level mousedown listener and an orphaned popover.
   *
   * @param {string} labelText
   * @param {object} opts - QFSearchSelect options
   * @param {string} [hint]
   * @returns {HTMLElement}
   */
  function searchSelectField(labelText, opts, hint) {
    const wrap = document.createElement('div');
    wrap.className = 'mk-field';

    const mount = document.createElement('div');
    wrap.appendChild(mount);

    const instance = new window.QFSearchSelect(mount, Object.assign({ label: labelText }, opts));
    // Keyed by the form currently being built, so rebuilding one scope does
    // not tear down the other's controls.
    const bucket = opts.owner || 'default';
    if (!state.searchSelects[bucket]) state.searchSelects[bucket] = [];
    state.searchSelects[bucket].push(instance);

    if (hint) {
      const h = document.createElement('div');
      h.className = 'mk-field-hint';
      h.textContent = hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  /**
   * Tear down the QFSearchSelects belonging to one form before rebuilding it.
   *
   * Each instance holds a document-level mousedown listener and can own a
   * popover attached to <body>, so dropping the container is not enough.
   *
   * @param {string} owner - Bucket key, e.g. 'input' or 'output'
   */
  function destroySearchSelects(owner) {
    const bucket = state.searchSelects[owner] || [];
    bucket.forEach((sel) => {
      try {
        sel.destroy();
      } catch (error) {
        console.error('[market] failed to destroy a search select:', error);
      }
    });
    state.searchSelects[owner] = [];
  }

  /** Label + control + optional hint, matching the mockup's field layout. */
  function labelledField(labelText, control, hint) {
    const wrap = document.createElement('div');
    wrap.className = 'mk-field';
    const label = document.createElement('div');
    label.className = 'mk-label mk-label-sm';
    label.textContent = labelText;
    wrap.appendChild(label);
    wrap.appendChild(control);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'mk-field-hint';
      h.textContent = hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  function selectControl(options, value, onChange) {
    const el = document.createElement('select');
    el.className = 'qf-select';
    options.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (String(o.value) === String(value)) opt.selected = true;
      el.appendChild(opt);
    });
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }

  function numberControl(value, onChange, opts = {}) {
    const el = document.createElement('input');
    el.type = 'number';
    el.className = 'qf-input mk-input-num';
    if (opts.min !== undefined) el.min = opts.min;
    if (opts.max !== undefined) el.max = opts.max;
    el.step = opts.step === undefined ? 'any' : opts.step;
    el.value = value === null || value === undefined ? '' : String(value);
    el.addEventListener('input', () => onChange(el.value));
    return el;
  }

  /** A scrolling list box, as the mockup uses for systems/stations/regions. */
  function listBox(size) {
    const el = document.createElement('select');
    el.className = 'mk-listbox';
    el.size = size;
    return el;
  }

  function listOption(label, value, selected) {
    const opt = document.createElement('option');
    opt.textContent = label;
    if (value !== undefined) opt.value = String(value);
    if (selected) opt.selected = true;
    return opt;
  }

  /**
   * The location control for a scope. One branch per location type, matching
   * the mockup's five `sc-if` cases.
   */
  function buildLocationPicker(scope, cfg, host) {
    const rebuild = () => {
      buildScopeFields(scope);
      if (scope === 'input') applyMirrorState();
      updateSetSummary();
    };

    // ---- Trade Hub: a single select of the seeded hubs ----
    if (cfg.locationType === 'hub') {
      host.appendChild(searchSelectField('Select Trade Hub', {
        owner: scope,
        options: state.marketLocations.map((l) => ({
          value: String(l.locationId),
          label: l.locationName,
        })),
        value: cfg.locationId ? String(cfg.locationId) : null,
        placeholder: 'Select a trade hub…',
        onChange: (e) => {
          const chosen = state.marketLocations.find(
            (l) => String(l.locationId) === e.target.value
          );
          cfg.locationId = chosen ? chosen.locationId : null;
          cfg.regionId = chosen ? chosen.regionId : null;
          cfg.systemId = chosen ? chosen.systemId : null;
          rebuild();
        },
      }));
      return;
    }

    // ---- Specific Station: system search on the left, stations on the right ----
    if (cfg.locationType === 'station') {
      const grid = document.createElement('div');
      grid.className = 'mk-scope-grid';

      // System side
      const sysWrap = document.createElement('div');
      const sysLabel = document.createElement('div');
      sysLabel.className = 'mk-label mk-label-sm';
      sysLabel.textContent = 'Select System';
      sysWrap.appendChild(sysLabel);

      const sysInput = document.createElement('input');
      sysInput.type = 'text';
      sysInput.className = 'qf-input';
      sysInput.placeholder = 'Search systems...';
      sysWrap.appendChild(sysInput);

      const sysList = listBox(5);
      sysList.appendChild(listOption('Type to search…'));
      sysWrap.appendChild(sysList);
      grid.appendChild(sysWrap);

      // Station side
      const staWrap = document.createElement('div');
      const staLabel = document.createElement('div');
      staLabel.className = 'mk-label mk-label-sm';
      staLabel.textContent = 'Select Station';
      staWrap.appendChild(staLabel);

      const staList = listBox(6);
      staWrap.appendChild(staList);
      grid.appendChild(staWrap);

      /** Fill the station list for the selected system. */
      const loadStations = async (systemId) => {
        staList.textContent = '';
        try {
          const rows = await window.electronAPI.sde.getStationsInSystem(systemId);
          const stations = Array.isArray(rows) ? rows : [];
          if (stations.length === 0) {
            staList.appendChild(listOption('No stations in this system'));
            return;
          }
          stations.forEach((s) => {
            const id = s.stationID ?? s.stationId;
            staList.appendChild(listOption(
              s.stationName ?? s.name,
              id,
              String(id) === String(cfg.locationId)
            ));
          });
        } catch (error) {
          console.error('[market] station lookup failed:', error);
          staList.appendChild(listOption('Could not load stations'));
        }
      };

      if (cfg.systemId) {
        loadStations(cfg.systemId);
      } else {
        staList.appendChild(listOption('Select a system first'));
      }

      let sysTimer = null;
      sysInput.addEventListener('input', () => {
        if (sysTimer) clearTimeout(sysTimer);
        sysTimer = setTimeout(async () => {
          const q = sysInput.value.trim();
          if (q.length < 2) return;
          try {
            const rows = await window.electronAPI.sde.searchSystems(q);
            sysList.textContent = '';
            (Array.isArray(rows) ? rows : []).slice(0, 40).forEach((s) => {
              const id = s.solarSystemID ?? s.systemId;
              sysList.appendChild(listOption(
                s.solarSystemName ?? s.systemName ?? s.name,
                id,
                String(id) === String(cfg.systemId)
              ));
            });
            if (sysList.childElementCount === 0) sysList.appendChild(listOption('No systems match'));
          } catch (error) {
            console.error('[market] system search failed:', error);
          }
        }, 250);
      });

      sysList.addEventListener('change', () => {
        cfg.systemId = Number(sysList.value) || null;
        cfg.systemName = sysList.selectedOptions[0] ? sysList.selectedOptions[0].textContent : null;
        cfg.locationId = null;
        if (cfg.systemId) loadStations(cfg.systemId);
        updateSetSummary();
      });

      staList.addEventListener('change', () => {
        cfg.locationId = Number(staList.value) || null;
        cfg.locationName = staList.selectedOptions[0] ? staList.selectedOptions[0].textContent : null;
        updateSetSummary();
      });

      host.appendChild(grid);
      return;
    }

    // ---- Solar System ----
    if (cfg.locationType === 'system') {
      const wrap = document.createElement('div');
      const label = document.createElement('div');
      label.className = 'mk-label mk-label-sm';
      label.textContent = 'Select Solar System';
      wrap.appendChild(label);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'qf-input';
      input.placeholder = 'Search systems...';
      wrap.appendChild(input);

      const list = listBox(6);
      list.appendChild(listOption(cfg.systemName || 'Type to search…'));
      wrap.appendChild(list);

      let timer = null;
      input.addEventListener('input', () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          const q = input.value.trim();
          if (q.length < 2) return;
          try {
            const rows = await window.electronAPI.sde.searchSystems(q);
            list.textContent = '';
            (Array.isArray(rows) ? rows : []).slice(0, 40).forEach((s) => {
              const id = s.solarSystemID ?? s.systemId;
              list.appendChild(listOption(
                s.solarSystemName ?? s.systemName ?? s.name,
                id,
                String(id) === String(cfg.systemId)
              ));
            });
            if (list.childElementCount === 0) list.appendChild(listOption('No systems match'));
          } catch (error) {
            console.error('[market] system search failed:', error);
          }
        }, 250);
      });

      list.addEventListener('change', () => {
        cfg.systemId = Number(list.value) || null;
        cfg.systemName = list.selectedOptions[0] ? list.selectedOptions[0].textContent : null;
        cfg.locationId = null;
        updateSetSummary();
      });

      host.appendChild(wrap);
      return;
    }

    // ---- Entire Region ----
    if (cfg.locationType === 'region') {
      const wrap = document.createElement('div');
      const label = document.createElement('div');
      label.className = 'mk-label mk-label-sm';
      label.textContent = 'Select Region';
      wrap.appendChild(label);

      const list = listBox(6);
      [...state.regionNames.entries()]
        .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
        .forEach(([id, name]) => {
          list.appendChild(listOption(name, id, String(id) === String(cfg.regionId)));
        });
      if (list.childElementCount === 0) list.appendChild(listOption('No regions available'));

      list.addEventListener('change', () => {
        cfg.regionId = Number(list.value) || null;
        cfg.locationId = null;
        cfg.systemId = null;
        updateSetSummary();
      });

      wrap.appendChild(list);
      host.appendChild(wrap);
      return;
    }

    // ---- Private Structure ----
    const wrap = document.createElement('div');
    wrap.className = 'mk-struct';

    wrap.appendChild(searchSelectField('Character for ESI Authentication', {
      owner: scope,
      // getCharacters() returns `characterName`, not `name` - reading the
      // wrong field renders every option as an empty string.
      options: state.characters.map((c) => ({
        value: String(c.characterId),
        label: c.characterName,
      })),
      value: cfg.characterId ? String(cfg.characterId) : null,
      placeholder: 'Select a character…',
      onChange: (e) => {
        cfg.characterId = e.target.value ? Number(e.target.value) : null;
        rebuild();
      },
    }));

    const searchRow = document.createElement('div');
    searchRow.className = 'mk-struct-search';

    const searchWrap = document.createElement('div');
    const searchLabel = document.createElement('div');
    searchLabel.className = 'mk-label mk-label-sm';
    searchLabel.textContent = 'Structure Name Search';
    searchWrap.appendChild(searchLabel);
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'qf-input';
    searchInput.placeholder = 'Type structure name (min 3 chars)...';
    searchInput.disabled = !cfg.characterId;
    searchWrap.appendChild(searchInput);
    searchRow.appendChild(searchWrap);

    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.className = 'secondary-button';
    searchBtn.disabled = !cfg.characterId;
    const searchBtnLabel = document.createElement('span');
    searchBtnLabel.className = 'btn-label';
    searchBtnLabel.textContent = 'Search';
    searchBtn.appendChild(searchBtnLabel);
    searchRow.appendChild(searchBtn);
    wrap.appendChild(searchRow);

    const resultsWrap = document.createElement('div');
    const resultsLabel = document.createElement('div');
    resultsLabel.className = 'mk-label mk-label-sm';
    resultsLabel.textContent = 'Search Results';
    resultsWrap.appendChild(resultsLabel);
    const results = listBox(4);
    results.appendChild(listOption(
      cfg.structureName || 'Search for a structure above',
      cfg.structureId,
      !!cfg.structureId
    ));
    resultsWrap.appendChild(results);
    wrap.appendChild(resultsWrap);

    const runStructureSearch = async () => {
      const q = searchInput.value.trim();
      if (!cfg.characterId || q.length < 3) return;
      results.textContent = '';
      results.appendChild(listOption('Searching…'));
      try {
        const rows = await window.electronAPI.market.searchStructures(cfg.characterId, q);
        results.textContent = '';
        const list = Array.isArray(rows) ? rows : [];
        if (list.length === 0) {
          results.appendChild(listOption('No structures found'));
          return;
        }
        list.slice(0, 40).forEach((s) => {
          const id = s.structureId ?? s.id;
          results.appendChild(listOption(s.name ?? s.structureName ?? `Structure ${id}`, id));
          // Keep region/system so the set can price against it.
          if (String(id) === String(cfg.structureId)) {
            cfg.regionId = s.regionId || cfg.regionId;
            cfg.systemId = s.systemId || cfg.systemId;
          }
        });
        results._rows = list;
      } catch (error) {
        console.error('[market] structure search failed:', error);
        results.textContent = '';
        results.appendChild(listOption('Search failed'));
      }
    };

    searchBtn.addEventListener('click', runStructureSearch);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runStructureSearch();
      }
    });

    results.addEventListener('change', () => {
      const id = Number(results.value) || null;
      cfg.structureId = id;
      cfg.locationId = id;
      cfg.structureName = results.selectedOptions[0] ? results.selectedOptions[0].textContent : null;
      const match = (results._rows || []).find((s) => String(s.structureId ?? s.id) === String(id));
      if (match) {
        cfg.regionId = match.regionId || cfg.regionId;
        cfg.systemId = match.systemId || cfg.systemId;
      }
      updateSetSummary();
    });

    const note = document.createElement('div');
    note.className = 'mk-struct-note';
    note.appendChild(document.createTextNode('Requires characters with '));
    const scope1 = document.createElement('em');
    scope1.textContent = 'esi-search.search_structures.v1';
    note.appendChild(scope1);
    note.appendChild(document.createTextNode(' and '));
    const scope2 = document.createElement('em');
    scope2.textContent = 'esi-markets.structure_markets.v1';
    note.appendChild(scope2);
    note.appendChild(document.createTextNode(' scopes. Re-authenticate if these are missing.'));
    wrap.appendChild(note);

    host.appendChild(wrap);
  }


  function blankScope() {
    return {
      locationType: 'hub',
      locationId: null,
      regionId: null,
      systemId: null,
      structureId: null,
      structureName: null,
      characterId: null,
      priceType: 'sell',
      priceMethod: 'immediate',
      priceModifier: 1,
      percentile: 0.2,
      minVolume: 1000,
    };
  }

  /**
   * Open the market set editor.
   * @param {object|null} set - Existing set to edit, or null to create one.
   */
  function openSetEditor(set) {
    setEditorMode = set ? 'edit' : 'create';

    // Deep-ish copy so Cancel genuinely discards.
    setDraft = {
      id: set ? set.id : null,
      name: set ? set.name : '',
      input: Object.assign(blankScope(), set ? set.inputMaterials : {}),
      output: Object.assign(blankScope(), set ? set.outputProducts : {}),
    };

    document.getElementById('mk-set-modal-title').textContent =
      setEditorMode === 'edit' ? 'Edit Market Set' : 'New Market Set';
    QFUI.setButtonLabel(
      document.getElementById('mk-set-save'),
      setEditorMode === 'edit' ? 'Save Changes' : 'Create Market Set'
    );
    document.getElementById('mk-set-name').value = setDraft.name;

    // Delete only applies to an existing set, and never to the last one.
    const del = document.getElementById('mk-set-delete');
    if (del) del.hidden = setEditorMode !== 'edit' || state.sets.length <= 1;

    // Mirror defaults on when both scopes already point at the same place.
    const mirror = document.getElementById('mk-set-mirror');
    mirror.checked = sameLocation(setDraft.input, setDraft.output);

    buildScopeFields('input');
    buildScopeFields('output');
    applyMirrorState();
    updateSetSummary();

    openModal('mk-set-modal');
    document.getElementById('mk-set-name').focus();
  }

  function sameLocation(a, b) {
    return a.locationType === b.locationType
      && String(a.locationId) === String(b.locationId)
      && String(a.regionId) === String(b.regionId);
  }

  /**
   * When mirroring, copy the input's location onto the output scope and
   * rebuild it - which drops the location block entirely, leaving only the
   * pricing fields, exactly as the mockup's `sc-if showOutputLoc` does.
   */
  function applyMirrorState() {
    if (!setDraft) return;
    const outputHost = document.getElementById('mk-scope-output');
    if (!outputHost) return;

    if (isMirrored()) {
      [
        'locationType', 'locationId', 'locationName', 'regionId',
        'systemId', 'systemName', 'structureId', 'structureName', 'characterId',
      ].forEach((k) => { setDraft.output[k] = setDraft.input[k]; });
    }
    buildScopeFields('output');
  }

  /** Where a scope points, for validation. Null when nothing is chosen yet. */
  function scopeLocationLabel(cfg) {
    if (cfg.structureName) return cfg.structureName;
    if (cfg.locationName) return cfg.locationName;
    if (cfg.locationId) {
      const hub = state.marketLocations.find((l) => String(l.locationId) === String(cfg.locationId));
      if (hub) return hub.locationName;
    }
    if (cfg.locationType === 'system' && cfg.systemName) return cfg.systemName;
    if (cfg.locationType === 'region' && cfg.regionId) {
      return state.regionNames.get(cfg.regionId) || `Region ${cfg.regionId}`;
    }
    return null;
  }

  /** Enable Save only when the set is complete. */
  function updateSetSummary() {
    if (!setDraft) return;

    const inWhere = scopeLocationLabel(setDraft.input);
    const outWhere = scopeLocationLabel(setDraft.output);

    const save = document.getElementById('mk-set-save');
    if (save) save.disabled = !setDraft.name.trim() || !inWhere || !outWhere;
  }

  async function saveSetEditor() {
    if (!setDraft) return;
    const name = setDraft.name.trim();
    if (!name) return;

    const payload = {
      name,
      inputMaterials: stripScope(setDraft.input),
      outputProducts: stripScope(setDraft.output),
    };

    try {
      if (setEditorMode === 'edit') {
        await window.electronAPI.market.updateMarketSet(setDraft.id, payload);
      } else {
        await window.electronAPI.market.addMarketSet(payload);
      }
      closeModal('mk-set-modal');
      setDraft = null;
      await loadAll();
    } catch (error) {
      console.error('[market] failed to save market set:', error);
    }
  }

  /** Restore both scopes to defaults, keeping the set's name. */
  function resetSetEditor() {
    if (!setDraft) return;
    setDraft.input = blankScope();
    setDraft.output = blankScope();
    const mirror = document.getElementById('mk-set-mirror');
    if (mirror) mirror.checked = true;
    buildScopeFields('input');
    buildScopeFields('output');
    applyMirrorState();
    updateSetSummary();
  }

  async function deleteSetFromEditor() {
    if (!setDraft || setEditorMode !== 'edit') return;
    if (!window.confirm(`Delete the market set "${setDraft.name}"?`)) return;

    try {
      await window.electronAPI.market.deleteMarketSet(setDraft.id);
      closeModal('mk-set-modal');
      setDraft = null;
      state.activeSetId = null;
      await loadAll();
    } catch (error) {
      console.error('[market] failed to delete market set:', error);
    }
  }

  /** Drop renderer-only helper fields before persisting. */
  function stripScope(cfg) {
    const out = Object.assign({}, cfg);
    delete out.systemName;
    return out;
  }

  /* ----------------------------------------------- price override modal */

  /** Override modal state; the search is a shared QFSearchSelect. */
  const overrideForm = {
    pick: null,
    editingTypeId: null,
  };

  /**
   * Open the override editor.
   * @param {object|null} existing - Override row to edit, or null to add.
   */
  function openOverrideModal(existing) {
    destroySearchSelects('override');
    overrideForm.editingTypeId = existing ? existing.typeId : null;
    overrideForm.pick = existing
      ? { typeId: existing.typeId, typeName: existing.name || `Type ${existing.typeId}` }
      : null;

    document.getElementById('mk-override-modal-title').textContent =
      existing ? 'Edit Price Override' : 'Add Price Override';
    document.getElementById('mk-ov-price').value =
      existing && existing.price !== null && existing.price !== undefined
        ? String(existing.price)
        : '';
    document.getElementById('mk-ov-note').value = (existing && existing.notes) || '';

    renderOverrideForm();
    openModal('mk-override-modal');
    // With an item already chosen, the price is what needs typing.
    if (overrideForm.pick) document.getElementById('mk-ov-price').focus();
  }

  function renderOverrideForm() {
    const pickEl = document.getElementById('mk-ov-pick');
    const searchEl = document.getElementById('mk-ov-search');
    if (!pickEl || !searchEl) return;

    pickEl.hidden = !overrideForm.pick;
    searchEl.hidden = !!overrideForm.pick;

    if (overrideForm.pick) {
      document.getElementById('mk-ov-pick-name').textContent = overrideForm.pick.typeName;
      const book = state.orderBook.get(overrideForm.pick.typeId);
      document.getElementById('mk-ov-pick-sub').textContent = book && book.sell
        ? `Market sell ${isk(book.sell)}`
        : 'No market data for this item here';
    }

    mountOverrideSearch();

    const price = document.getElementById('mk-ov-price').value;
    const valid = !!overrideForm.pick && price !== '' && Number.isFinite(Number(price)) && Number(price) > 0;
    document.getElementById('mk-ov-save').disabled = !valid;

    const summary = document.getElementById('mk-ov-summary');
    if (!overrideForm.pick) {
      summary.textContent = 'Search for an item to override.';
    } else if (!valid) {
      summary.textContent = 'Enter a price above zero.';
    } else {
      const book = state.orderBook.get(overrideForm.pick.typeId);
      if (book && book.sell) {
        const delta = ((Number(price) - book.sell) / book.sell) * 100;
        const sign = delta >= 0 ? '+' : '';
        summary.textContent =
          `${overrideForm.pick.typeName} pinned at ${isk(Number(price))} (${sign}${delta.toFixed(1)}% vs market).`;
      } else {
        summary.textContent = `${overrideForm.pick.typeName} pinned at ${isk(Number(price))}.`;
      }
    }
  }

  /**
   * Mount the shared item search for the price-override modal.
   *
   * Deliberately SDE-wide rather than region-scoped: you may want to pin a
   * price before any orders exist for the item in this market.
   */
  function mountOverrideSearch() {
    const host = document.getElementById('mk-ov-search');
    if (!host) return;

    if (overrideForm.pick) {
      destroySearchSelects('override');
      host.textContent = '';
      return;
    }

    if ((state.searchSelects.override || []).length > 0) return;

    destroySearchSelects('override');
    host.textContent = '';

    const existing = new Set(state.overrides.map((o) => o.typeId));

    const instance = new window.QFSearchSelect(host, {
      options: [],
      value: null,
      placeholder: 'Search items…',
      searchPlaceholder: 'Type to search items…',
      searchPrompt: 'Type at least 2 characters',
      emptyText: 'No items match',
      minQueryLength: 2,
      debounceMs: 200,
      onSearch: async (query) => {
        try {
          const rows = await window.electronAPI.sde.searchMarketItems(query);
          return (Array.isArray(rows) ? rows : []).slice(0, 50).map((r) => ({
            value: String(r.typeID),
            label: existing.has(r.typeID) ? `${r.typeName} · has override` : r.typeName,
            typeId: r.typeID,
            typeName: r.typeName,
          }));
        } catch (error) {
          console.error('[market] override item search failed:', error);
          return [];
        }
      },
      onChange: (e) => {
        const chosen = (instance.options || []).find((o) => o.value === e.target.value);
        if (!chosen) return;
        overrideForm.pick = { typeId: chosen.typeId, typeName: chosen.typeName };
        renderOverrideForm();
        document.getElementById('mk-ov-price').focus();
      },
    });

    state.searchSelects.override = [instance];
  }

  /** Override search is SDE-wide: you may want to pin a price before any
   *  orders exist for the item in this region. */
  async function saveOverride() {
    if (!overrideForm.pick) return;
    const price = Number(document.getElementById('mk-ov-price').value);
    if (!Number.isFinite(price) || price <= 0) return;
    const notes = document.getElementById('mk-ov-note').value.trim() || null;

    try {
      await window.electronAPI.market.setPriceOverride(overrideForm.pick.typeId, price, notes);
      closeModal('mk-override-modal');
      await loadAll();
    } catch (error) {
      console.error('[market] failed to save override:', error);
    }
  }

  /**
   * Refresh a single market set, showing the indeterminate bar on its card.
   *
   * The per-set refresh is currently a full market update (there is no
   * per-region IPC), so the spinner is per-card but the work is global.
   */
  async function refreshSet(set) {
    if (state.refreshingSets.has(set.id)) return;
    state.refreshingSets.add(set.id);
    // Per-set refresh is a full market update (there is no per-region IPC), so
    // it gets the same dialog - the work is global whichever button starts it.
    openRefreshModal();
    renderOverview();

    try {
      const result = await window.electronAPI.market.updateAllMarketData();
      reportRefreshOutcome(result);
    } catch (error) {
      console.error('[market] set refresh failed:', error);
      toast(`Market refresh failed: ${error.message}`, 'error');
    } finally {
      closeRefreshModal();
      state.refreshingSets.delete(set.id);
      // Drop any page counts left behind - a region whose last progress event
      // never arrived would otherwise keep reporting a stale "page 3 of 9"
      // into the next refresh.
      state.fetchProgress.clear();
      await loadAll();
    }
  }

  /* ---------------------------------------------------------- overrides */

  function renderOverrides() {
    const body = document.getElementById('mk-override-rows');
    const empty = document.getElementById('mk-overrides-empty');
    const count = document.getElementById('mk-override-count');
    const tabCount = document.getElementById('mk-tab-override-count');
    if (!body) return;

    body.textContent = '';
    if (count) count.textContent = String(state.overrides.length);
    if (tabCount) tabCount.textContent = String(state.overrides.length);
    if (empty) empty.hidden = state.overrides.length > 0;

    state.overrides.forEach((o) => {
      const tr = document.createElement('tr');
      tr.className = 'mk-row-clickable';
      tr.title = 'Edit this override';
      tr.addEventListener('click', (e) => {
        // Let the row's own buttons (remove) handle their clicks.
        if (e.target.closest('button')) return;
        openOverrideModal(o);
      });

      const name = document.createElement('td');
      name.textContent = o.name || `Type ${o.typeId}`;
      tr.appendChild(name);

      // Market and Delta come from the region's order book, so an override can
      // be judged against what the market is actually doing.
      const book = state.orderBook.get(o.typeId);
      const marketPrice = book && book.sell !== null && book.sell !== undefined ? book.sell : null;

      const market = document.createElement('td');
      market.className = 'mk-num';
      market.textContent = marketPrice !== null ? isk(marketPrice) : '--';
      tr.appendChild(market);

      const override = document.createElement('td');
      override.className = 'mk-num';
      override.textContent = isk(o.price);
      tr.appendChild(override);

      const delta = document.createElement('td');
      delta.className = 'mk-num mk-delta';
      if (marketPrice !== null && marketPrice > 0) {
        const pct = ((o.price - marketPrice) / marketPrice) * 100;
        delta.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
        delta.classList.add(pct >= 0 ? 'is-up' : 'is-down');
      } else {
        delta.textContent = '--';
      }
      tr.appendChild(delta);

      const note = document.createElement('td');
      note.textContent = o.notes || '--';
      tr.appendChild(note);

      const actions = document.createElement('td');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mk-link is-danger';
      remove.title = 'Remove override';
      remove.appendChild(icon('trash', 14));
      remove.addEventListener('click', async () => {
        try {
          await window.electronAPI.market.removePriceOverride(o.typeId);
          await loadOverrides();
          renderOverrides();
          renderPricing();
        } catch (error) {
          console.error('[market] failed to remove override:', error);
        }
      });
      actions.appendChild(remove);
      tr.appendChild(actions);

      body.appendChild(tr);
    });
  }

  /* -------------------------------------------------------- watchlists */

  function activeWatchlist() {
    return state.watchlists.find((w) => w.id === state.activeWatchlistId) || null;
  }

  /** Name of the market set a watchlist prices against. */
  /**
   * Display name for a market set id.
   *
   * Compared as strings: the id originates in settings but round-trips
   * through SQLite on a watchlist row, so the types will not always match.
   */
  function marketSetName(marketSetId) {
    if (!marketSetId) return 'the default market';
    const set = findMarketSet(marketSetId);
    return set ? set.name : 'an unavailable market set';
  }

  /** Look up a market set by id, tolerating string/number mismatch. */
  function findMarketSet(id) {
    if (id === null || id === undefined) return null;
    return state.sets.find((s) => String(s.id) === String(id)) || null;
  }

  /**
   * Drift for one side against the item's ANCHORED baseline.
   *
   * @param {object} item
   * @param {'buy'|'sell'} side
   * @returns {{absolute: number, percent: number}|null} null with no baseline
   */
  function itemDrift(item, side) {
    const base = item[`base_${side}`];
    const prices = state.watchPrices.get(item.type_id) || {};
    const current = prices[side];
    if (!Number.isFinite(base) || !Number.isFinite(current) || base === 0) return null;
    const absolute = current - base;
    return { absolute, percent: (absolute / base) * 100 };
  }

  /**
   * Display state for one side's alert rule.
   *
   * Presentation only - main owns whether an alert actually FIRES (it holds
   * the per-side debounce). This just shows where each rule stands now.
   *
   * @param {object} item
   * @param {'buy'|'sell'} side
   */
  function sideAlertState(item, side) {
    const type = item[`${side}_alert_type`];
    const value = item[`${side}_alert_value`];

    if (!type || type === 'none' || value === null || value === undefined) {
      return { state: 'none', label: null };
    }

    const above = item[`${side}_alert_direction`] === 'above';
    const arrow = above ? '▲' : '▼';
    const label = type === 'percent'
      ? `${side} ${arrow} ${Math.abs(value)}%`
      : `${side} ${arrow} ${isk(Math.abs(value))}`;

    const drift = itemDrift(item, side);
    if (!drift) return { state: 'armed', label, reason: 'no baseline' };

    const moved = type === 'percent' ? drift.percent : drift.absolute;
    const threshold = Math.abs(value);
    const hit = above ? moved >= threshold : moved <= -threshold;

    return hit ? { state: 'hit', label } : { state: 'armed', label };
  }

  /** True when either side of this item is currently triggered. */
  function itemHasHit(item) {
    return SIDES.some((side) => sideAlertState(item, side).state === 'hit');
  }

  function watchlistAlertCount(watchlistId) {
    if (watchlistId !== state.activeWatchlistId) return 0;
    return state.watchItems.filter(itemHasHit).length;
  }

  function renderWatchlistNav() {
    const host = document.getElementById('mk-watchlist-nav');
    if (!host) return;
    host.textContent = '';

    if (state.watchlists.length === 0) {
      const none = document.createElement('div');
      none.className = 'mk-ctx-sub';
      none.style.padding = '2px 8px 6px';
      none.textContent = 'None yet';
      host.appendChild(none);
      return;
    }

    state.watchlists.forEach((w) => {
      const row = document.createElement('button');
      row.type = 'button';
      const isActive = w.id === state.activeWatchlistId;
      row.className = 'mk-wl-nav-row' + (isActive ? ' is-active' : '');

      const main = document.createElement('div');
      main.className = 'mk-wl-nav-main';

      const top = document.createElement('div');
      top.className = 'mk-wl-nav-top';
      const name = document.createElement('span');
      name.className = 'mk-wl-nav-name';
      name.textContent = w.name;
      top.appendChild(name);

      const alerts = watchlistAlertCount(w.id);
      if (alerts > 0) {
        const badge = document.createElement('span');
        badge.className = 'mk-wl-nav-alerts';
        badge.appendChild(icon('bell', 10, { strokeWidth: 2 }));
        badge.appendChild(document.createTextNode(String(alerts)));
        top.appendChild(badge);
      }
      main.appendChild(top);

      const sub = document.createElement('div');
      sub.className = 'mk-wl-nav-sub';
      const count = w.item_count || 0;
      sub.textContent = `${marketSetName(w.market_set_id)} · ${count} item${count === 1 ? '' : 's'}`;
      main.appendChild(sub);

      row.appendChild(main);
      row.addEventListener('click', () => {
        selectWatchlist(w.id);
        switchTab('watchlists');
      });
      host.appendChild(row);
    });
  }

  function renderWatchlist() {
    const empty = document.getElementById('mk-wl-empty');
    const body = document.getElementById('mk-wl-body');
    if (!empty || !body) return;

    const wl = activeWatchlist();
    const hasAny = state.watchlists.length > 0 && wl;
    empty.hidden = hasAny;
    body.hidden = !hasAny;
    if (!hasAny) {
      renderAlertBadge();
      return;
    }

    document.getElementById('mk-wl-name').textContent = wl.name;

    const desc = document.getElementById('mk-wl-desc');
    desc.textContent = wl.description || '';
    desc.hidden = !wl.description;

    document.getElementById('mk-wl-market-name').textContent = marketSetName(wl.market_set_id);

    // Stats
    const hits = state.watchItems.filter(itemHasHit).length;
    document.getElementById('mk-wl-stat-count').textContent = String(state.watchItems.length);

    let total = 0;
    let priced = 0;
    state.watchItems.forEach((it) => {
      const p = state.watchPrices.get(it.type_id);
      if (p && Number.isFinite(p.sell)) {
        total += p.sell;
        priced += 1;
      }
    });
    document.getElementById('mk-wl-stat-value').textContent = priced > 0 ? isk(total) : '--';

    const alertsEl = document.getElementById('mk-wl-stat-alerts');
    alertsEl.textContent = String(hits);
    alertsEl.className = 'mk-wl-stat-value' + (hits > 0 ? ' is-warning' : '');
    document.getElementById('mk-wl-stat-alert-card').className =
      'mk-wl-stat' + (hits > 0 ? ' has-alerts' : '');

    renderWatchItems();
    renderAlertBadge();
  }

  function renderWatchItems() {
    const tbody = document.getElementById('mk-wl-rows');
    const empty = document.getElementById('mk-wl-items-empty');
    if (!tbody || !empty) return;

    tbody.textContent = '';
    empty.hidden = state.watchItems.length > 0;

    state.watchItems.forEach((item) => {
      const tr = document.createElement('tr');
      if (itemHasHit(item)) tr.className = 'is-hit';

      const prices = state.watchPrices.get(item.type_id) || {};

      // ---- item ----
      const nameTd = document.createElement('td');
      const wrap = document.createElement('span');
      wrap.className = 'mk-wl-item';
      const img = document.createElement('img');
      img.src = `https://images.evetech.net/types/${item.type_id}/icon?size=64`;
      img.alt = '';
      img.loading = 'lazy';
      wrap.appendChild(img);
      wrap.appendChild(document.createTextNode(item.typeName || `Type ${item.type_id}`));
      nameTd.appendChild(wrap);
      tr.appendChild(nameTd);

      // ---- base / current, per side ----
      SIDES.forEach((side) => {
        const base = item[`base_${side}`];
        const baseTd = document.createElement('td');
        baseTd.className = 'mk-num mk-wl-base';
        baseTd.textContent = Number.isFinite(base) ? isk(base) : '--';
        if (item.baseline_at) {
          baseTd.title = `Baselined ${QFFreshness.formatAge(item.baseline_at)}`;
        } else {
          baseTd.title = 'No baseline captured yet';
        }
        tr.appendChild(baseTd);

        const nowTd = document.createElement('td');
        nowTd.className = `mk-num mk-${side}`;
        nowTd.textContent = Number.isFinite(prices[side]) ? isk(prices[side]) : '--';
        tr.appendChild(nowTd);
      });

      // ---- drift, both sides in one cell ----
      const driftTd = document.createElement('td');
      driftTd.className = 'mk-num mk-wl-drift';
      const parts = [];
      const titles = [];
      SIDES.forEach((side) => {
        const drift = itemDrift(item, side);
        if (!drift) {
          parts.push('--');
          return;
        }
        const sign = drift.percent >= 0 ? '+' : '';
        const chunk = document.createElement('span');
        chunk.className = 'mk-drift-part ' + (drift.percent >= 0 ? 'is-up' : 'is-down');
        chunk.textContent = `${sign}${drift.percent.toFixed(1)}%`;
        parts.push(chunk);
        titles.push(`${side}: ${sign}${isk(drift.absolute)} (${sign}${drift.percent.toFixed(1)}%)`);
      });
      parts.forEach((part, i) => {
        if (i > 0) driftTd.appendChild(document.createTextNode(' / '));
        driftTd.appendChild(typeof part === 'string' ? document.createTextNode(part) : part);
      });
      if (titles.length) driftTd.title = titles.join('\n');
      tr.appendChild(driftTd);

      // ---- alert pills, one per armed side; doubles as the edit affordance ----
      const alertTd = document.createElement('td');
      const armed = SIDES
        .map((side) => ({ side, ...sideAlertState(item, side) }))
        .filter((a) => a.state !== 'none');

      if (armed.length === 0) {
        const setBtn = document.createElement('button');
        setBtn.type = 'button';
        setBtn.className = 'mk-alert-pill';
        setBtn.title = 'Set an alert';
        setBtn.textContent = 'Set alerts';
        setBtn.addEventListener('click', () => openAddItemModal(item));
        alertTd.appendChild(setBtn);
      } else {
        armed.forEach((a) => {
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = 'mk-alert-pill ' + (a.state === 'hit' ? 'is-hit' : 'is-armed');
          pill.title = a.reason ? `${a.label} (${a.reason})` : 'Edit alerts';
          pill.appendChild(icon('bell', 12, { strokeWidth: 1.8 }));
          pill.appendChild(document.createTextNode(
            a.state === 'hit' ? `${a.label} · hit` : a.label
          ));
          pill.addEventListener('click', () => openAddItemModal(item));
          alertTd.appendChild(pill);
        });
      }
      tr.appendChild(alertTd);

      // ---- actions ----
      const actions = document.createElement('td');
      actions.className = 'mk-col-actions';

      // Re-baseline: the ONLY thing that moves base_buy/base_sell, so it is an
      // explicit action rather than something that happens on refresh.
      const rebase = document.createElement('button');
      rebase.type = 'button';
      rebase.className = 'mk-icon-btn';
      rebase.title = 'Re-baseline to current prices';
      rebase.setAttribute('aria-label', 'Re-baseline to current prices');
      rebase.appendChild(icon('refresh', 14));
      rebase.disabled = !Number.isFinite(prices.buy) && !Number.isFinite(prices.sell);
      rebase.addEventListener('click', () => rebaselineItem(item));
      actions.appendChild(rebase);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mk-icon-btn mk-icon-btn-danger';
      remove.title = 'Remove from watchlist';
      remove.setAttribute('aria-label', 'Remove from watchlist');
      remove.appendChild(icon('trash', 14));
      remove.addEventListener('click', () => trackPending((async () => {
        try {
          await window.electronAPI.market.watchlists.removeItem(item.id);
          await loadWatchlists();
          await loadWatchlistItems();
          renderWatchlist();
          renderWatchlistNav();
          await loadSafely('orderBook', loadOrderBook);
          renderSafely('pricing', renderPricing);
        } catch (error) {
          console.error('[market] failed to remove watchlist item:', error);
        }
      })()));
      actions.appendChild(remove);
      tr.appendChild(actions);

      tbody.appendChild(tr);
    });
  }

  /** Re-anchor one item's baseline to the prices showing now. */
  async function rebaselineItem(item) {
    const prices = state.watchPrices.get(item.type_id) || {};
    try {
      const res = await window.electronAPI.market.watchlists.rebaseline(item.id, {
        buy: prices.buy,
        sell: prices.sell,
      });
      if (!res || !res.success) {
        toast(`Could not re-baseline ${item.typeName}.`, 'error');
        return;
      }
      await loadWatchlistItems();
      renderWatchlist();
      toast(`${item.typeName} re-baselined to current prices.`, 'success');
    } catch (error) {
      console.error('[market] re-baseline failed:', error);
      toast(`Could not re-baseline ${item.typeName}.`, 'error');
    }
  }

  function renderAlertBadge() {
    const badge = document.getElementById('mk-tab-alert-count');
    if (!badge) return;
    const hits = state.watchItems.filter(itemHasHit).length;
    badge.textContent = String(hits);
    badge.hidden = hits === 0;
  }

  /* ------------------------------------------------- watchlist data load */

  async function loadWatchlists() {
    try {
      const res = await window.electronAPI.market.watchlists.getAll();
      state.watchlists = res && res.success ? res.watchlists : [];
    } catch (error) {
      console.error('[market] failed to load watchlists:', error);
      state.watchlists = [];
    }

    await loadAllWatchTypeIds();

    if (!state.watchlists.some((w) => w.id === state.activeWatchlistId)) {
      state.activeWatchlistId = state.watchlists.length ? state.watchlists[0].id : null;
    }
  }

  /**
   * Collect every type on every watchlist.
   *
   * The Pricing tab lists all tracked items regardless of which watchlist they
   * belong to, so it cannot use state.watchItems (the ACTIVE list only).
   */
  async function loadAllWatchTypeIds() {
    const ids = new Set();
    await Promise.all(
      state.watchlists.map(async (w) => {
        try {
          const res = await window.electronAPI.market.watchlists.get(w.id);
          const wl = res && res.success ? res.watchlist : null;
          (wl && Array.isArray(wl.items) ? wl.items : []).forEach((i) => ids.add(i.type_id));
        } catch (error) {
          console.error(`[market] failed to read watchlist ${w.id}:`, error);
        }
      })
    );
    state.allWatchTypeIds = ids;
  }

  /** Load the active watchlist's items, resolve their names, and price them. */
  async function loadWatchlistItems() {
    if (!state.activeWatchlistId) {
      state.watchItems = [];
      state.watchPrices = new Map();
      return;
    }

    try {
      const res = await window.electronAPI.market.watchlists.get(state.activeWatchlistId);
      const wl = res && res.success ? res.watchlist : null;
      state.watchItems = wl && Array.isArray(wl.items) ? wl.items : [];
    } catch (error) {
      console.error('[market] failed to load watchlist items:', error);
      state.watchItems = [];
    }

    if (state.watchItems.length === 0) {
      state.watchPrices = new Map();
      return;
    }

    // Names
    try {
      const ids = state.watchItems.map((i) => i.type_id);
      const lookup = toNameLookup(await window.electronAPI.sde.getTypeNames(ids));
      state.watchItems.forEach((i) => {
        i.typeName = lookup.get(i.type_id) || `Type ${i.type_id}`;
        // Share the resolved name: the Pricing table and inspector read
        // state.typeNames, so a name resolved only here would leave those
        // showing "Type 16633" for a watchlist item.
        if (lookup.has(i.type_id)) state.typeNames.set(i.type_id, lookup.get(i.type_id));
      });
    } catch (error) {
      console.error('[market] failed to resolve type names:', error);
    }

    await loadWatchPrices();
  }

  /**
   * Price every item on the active watchlist.
   *
   * Uses calculateRealisticPrice (never fetchBulkPrices/Fuzzwork), so these
   * match what the rest of the app shows. Cache-only: no ESI fetch is triggered.
   */
  async function loadWatchPrices() {
    const wl = activeWatchlist();

    // A watchlist tracks the market it was configured with, NOT whatever is
    // selected in the left pane - that is the whole point of binding one.
    // Only fall back to the default set when the watchlist names none (or
    // names one that no longer exists).
    const set = findMarketSet(wl && wl.market_set_id) || defaultMarketSet();
    const marketSetId = set ? set.id : null;

    // Each scope carries its own location, so buy and sell may price against
    // different markets. There is no top-level set.regionId/locationId.
    const buyAt = setLocation(set, 'input');
    const sellAt = setLocation(set, 'output');

    // market:calculatePrice resolves the set and unwraps its
    // inputMaterials/outputProducts sub-object before calling
    // calculateRealisticPrice - passing a raw set here would be wrong.
    const prices = new Map();
    await Promise.all(
      state.watchItems.map(async (item) => {
        try {
          const [buy, sell] = await Promise.all([
            window.electronAPI.market.calculatePrice(item.type_id, buyAt.regionId, buyAt.locationId, 'buy', 1, marketSetId, 'input'),
            window.electronAPI.market.calculatePrice(item.type_id, sellAt.regionId, sellAt.locationId, 'sell', 1, marketSetId, 'output'),
          ]);
          prices.set(item.type_id, {
            buy: buy && buy.price ? buy.price : null,
            sell: sell && sell.price ? sell.price : null,
          });
        } catch (error) {
          console.error(`[market] pricing failed for type ${item.type_id}:`, error);
        }
      })
    );
    state.watchPrices = prices;
  }

  async function selectWatchlist(id) {
    state.activeWatchlistId = id;
    renderWatchlistNav();
    await loadWatchlistItems();
    renderWatchlist();
    renderWatchlistNav();
  }

  /* ------------------------------------------------ new / edit watchlist */

  function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.hidden = false;
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.hidden = true;

    // The set editor mounts QFSearchSelects, which own document-level
    // listeners and body-level popovers - hiding the modal does not remove
    // those, so they are destroyed explicitly.
    if (id === 'mk-set-modal') {
      destroySearchSelects('input');
      destroySearchSelects('output');
    }
  }

  function fillMarketSetOptions(selectedId) {
    const select = document.getElementById('mk-wl-form-market');
    if (!select) return;
    select.textContent = '';
    state.sets.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = String(s.id);
      opt.textContent = s.name;
      // String compare: selectedId may have round-tripped through SQLite.
      if (String(s.id) === String(selectedId)) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function openWatchlistForm(mode) {
    wlFormMode = mode;
    const wl = mode === 'edit' ? activeWatchlist() : null;

    document.getElementById('mk-wl-modal-title').textContent =
      mode === 'edit' ? 'Edit Watchlist' : 'New Watchlist';
    QFUI.setButtonLabel(
      document.getElementById('mk-wl-form-save'),
      mode === 'edit' ? 'Save Changes' : 'Create Watchlist'
    );

    document.getElementById('mk-wl-form-name').value = wl ? wl.name : '';
    document.getElementById('mk-wl-form-desc').value = wl ? wl.description || '' : '';

    const defaultSet = state.sets.find((s) => s.isDefault) || state.sets[0];
    fillMarketSetOptions(wl ? wl.market_set_id : defaultSet ? defaultSet.id : null);

    openModal('mk-wl-modal');
    document.getElementById('mk-wl-form-name').focus();
  }

  async function saveWatchlistForm() {
    const name = document.getElementById('mk-wl-form-name').value.trim();
    if (!name) {
      document.getElementById('mk-wl-form-name').focus();
      return;
    }

    const description = document.getElementById('mk-wl-form-desc').value.trim() || null;
    const marketSelect = document.getElementById('mk-wl-form-market');
    // Market set ids are opaque STRINGS (e.g. "1776014362091kqqn0afmh"), not
    // numbers - Number() on one yields NaN, which persisted as NULL and made
    // every watchlist read "Default market".
    const marketSetId = marketSelect && marketSelect.value ? marketSelect.value : null;

    try {
      if (wlFormMode === 'edit') {
        const wl = activeWatchlist();
        if (!wl) return;
        const res = await window.electronAPI.market.watchlists.update(wl.id, {
          name,
          description,
          marketSetId,
        });
        if (!res || !res.success) {
          console.error('[market] failed to update watchlist:', res && res.error);
          return;
        }
      } else {
        const res = await window.electronAPI.market.watchlists.create({
          name,
          description,
          marketSetId,
        });
        if (!res || !res.success) {
          console.error('[market] failed to create watchlist:', res && res.error);
          return;
        }
        state.activeWatchlistId = res.watchlist.id;
      }

      closeModal('mk-wl-modal');
      await loadWatchlists();
      await loadWatchlistItems();
      renderWatchlistNav();
      renderWatchlist();
      switchTab('watchlists');
    } catch (error) {
      console.error('[market] watchlist save failed:', error);
    }
  }

  async function deleteActiveWatchlist() {
    const wl = activeWatchlist();
    if (!wl) return;
    if (!window.confirm(`Delete the watchlist "${wl.name}" and all of its items?`)) return;

    try {
      await window.electronAPI.market.watchlists.remove(wl.id);
      state.activeWatchlistId = null;
      await loadWatchlists();
      await loadWatchlistItems();
      renderWatchlistNav();
      renderWatchlist();
    } catch (error) {
      console.error('[market] failed to delete watchlist:', error);
    }
  }

  /* ----------------------------------------------------------- add item */

  /** Record the chosen item and repaint the form. */
  function choosePick(result) {
    addItem.pick = result;
    renderAddItem();
  }

  /**
   * Mount (or re-mount) the shared item search for the Add Item modal.
   *
   * QFSearchSelect in async mode owns the whole combobox contract - debounce,
   * out-of-order responses, keyboard nav, highlight, and the loading /
   * prompt / no-results states. This only supplies the query and the choice.
   */
  function mountAddItemSearch() {
    const host = document.getElementById('mk-additem-search');
    if (!host) return;

    // Once an item is chosen the search is hidden, so there is nothing to mount.
    if (addItem.pick) {
      destroySearchSelects('additem');
      host.textContent = '';
      return;
    }

    // Already mounted and still valid - leave it alone rather than rebuilding
    // under the user's cursor.
    if ((state.searchSelects.additem || []).length > 0) return;

    destroySearchSelects('additem');
    host.textContent = '';

    const onList = new Set(state.watchItems.map((i) => i.type_id));

    const instance = new window.QFSearchSelect(host, {
      options: [],
      value: null,
      placeholder: 'Search items…',
      searchPlaceholder: 'Type to search items…',
      searchPrompt: 'Type at least 2 characters',
      emptyText: 'No items match',
      minQueryLength: 2,
      debounceMs: 200,
      onSearch: async (query) => {
        try {
          const rows = await window.electronAPI.sde.searchMarketItems(query);
          return (Array.isArray(rows) ? rows : []).slice(0, 50).map((r) => ({
            value: String(r.typeID),
            // Mark items already tracked, so the user is not surprised by an
            // "already on this watchlist" outcome after choosing.
            label: onList.has(r.typeID) ? `${r.typeName} · on list` : r.typeName,
            typeId: r.typeID,
            typeName: r.typeName,
          }));
        } catch (error) {
          console.error('[market] item search failed:', error);
          return [];
        }
      },
      onChange: (e) => {
        const chosen = (instance.options || []).find((o) => o.value === e.target.value);
        if (chosen) choosePick({ typeId: chosen.typeId, typeName: chosen.typeName });
      },
    });

    state.searchSelects.additem = [instance];
  }

  /**
   * Open the Add Item modal. Passing an existing item edits its alert rules
   * instead (the backend upserts on (watchlist_id, type_id)).
   */
  function openAddItemModal(existing) {
    destroySearchSelects('additem');

    if (existing) {
      // typeId, not typeID: saveAddItem and renderAddItem both read typeId.
      addItem.pick = { typeId: existing.type_id, typeName: existing.typeName };
      addItem.editing = existing;
      SIDES.forEach((side) => {
        addItem[side] = {
          type: existing[`${side}_alert_type`] || 'none',
          direction: existing[`${side}_alert_direction`] || 'above',
          value: existing[`${side}_alert_value`],
        };
      });
      document.getElementById('mk-additem-title').textContent = 'Edit Alerts';
      QFUI.setButtonLabel(document.getElementById('mk-additem-save'), 'Save Alerts');
    } else {
      addItem.pick = null;
      addItem.editing = null;
      SIDES.forEach((side) => {
        addItem[side] = { type: 'none', direction: 'above', value: null };
      });
      document.getElementById('mk-additem-title').textContent = 'Add Item';
      QFUI.setButtonLabel(document.getElementById('mk-additem-save'), 'Add to Watchlist');
    }

    SIDES.forEach((side) => {
      document.getElementById(`mk-additem-${side}-type`).value = addItem[side].type;
      document.getElementById(`mk-additem-${side}-value`).value =
        addItem[side].value === null || addItem[side].value === undefined
          ? ''
          : String(addItem[side].value);
    });

    renderAddItem();
    openModal('mk-additem-modal');
  }

  /** Repaint the pick, both rule blocks, and the summary. */
  function renderAddItem() {
    const pickEl = document.getElementById('mk-additem-pick');
    const searchEl = document.getElementById('mk-additem-search');
    if (!pickEl || !searchEl) return;

    pickEl.hidden = !addItem.pick;
    searchEl.hidden = !!addItem.pick;

    if (addItem.pick) {
      document.getElementById('mk-additem-pick-name').textContent = addItem.pick.typeName;
      const wl = activeWatchlist();
      document.getElementById('mk-additem-pick-sub').textContent = wl
        ? `Priced at ${marketSetName(wl.market_set_id)}`
        : '';
    }

    mountAddItemSearch();

    SIDES.forEach((side) => {
      const rule = addItem[side];
      const isNone = rule.type === 'none';

      document.getElementById(`mk-additem-${side}-value-wrap`).hidden = isNone;
      document.getElementById(`mk-additem-${side}-none`).hidden = !isNone;
      document.getElementById(`mk-additem-${side}-dir`).hidden = isNone;

      if (!isNone) {
        document.getElementById(`mk-additem-${side}-value-label`).textContent =
          rule.type === 'percent' ? 'Change (%)' : 'Change (ISK)';
      }

      document
        .querySelectorAll(`#mk-additem-${side}-dir .mk-dir`)
        .forEach((btn) => {
          btn.classList.toggle('is-on', btn.getAttribute('data-mk-dir') === rule.direction);
        });
    });

    updateAddItemSummary();
  }

  /** Enable Save only when the form is complete, and explain what will happen. */
  function updateAddItemSummary() {
    const save = document.getElementById('mk-additem-save');
    const summary = document.getElementById('mk-additem-summary');

    const problems = [];
    SIDES.forEach((side) => {
      const rule = addItem[side];
      if (rule.type === 'none') return;
      const raw = document.getElementById(`mk-additem-${side}-value`).value;
      if (raw === '' || !Number.isFinite(Number(raw))) problems.push(side);
    });

    const valid = !!addItem.pick && problems.length === 0;
    save.disabled = !valid;

    if (!addItem.pick) {
      summary.textContent = 'Search for an item to add.';
      return;
    }
    if (problems.length > 0) {
      summary.textContent = `Enter a value for the ${problems.join(' and ')} alert.`;
      return;
    }

    const armed = SIDES.filter((side) => addItem[side].type !== 'none');
    if (armed.length === 0) {
      summary.textContent = addItem.editing
        ? 'No alerts — tracked for drift only.'
        : 'No alerts — the current prices become its baseline.';
      return;
    }
    summary.textContent = addItem.editing
      ? `Alerting on ${armed.join(' and ')} drift from the baseline.`
      : `Baseline captured now; alerting on ${armed.join(' and ')} drift.`;
  }

  /** Read one side's rule from the form. */
  function readSideRule(side) {
    const type = addItem[side].type;
    if (type === 'none') return { type: 'none', direction: 'above', value: null };
    return {
      type,
      direction: addItem[side].direction,
      value: Number(document.getElementById(`mk-additem-${side}-value`).value),
    };
  }

  async function saveAddItem() {
    const wl = activeWatchlist();
    if (!wl || !addItem.pick) return;

    // The baseline is captured from what the item is worth RIGHT NOW, which is
    // the anchor every later drift reading is measured against. Editing an
    // existing item deliberately sends no baseline, so the original anchor and
    // whatever drift it has accumulated survive.
    const payload = {
      buy: readSideRule('buy'),
      sell: readSideRule('sell'),
    };

    if (!addItem.editing) {
      // The order book only covers items already tracked, so a freshly
      // searched one is not in it - fetch its prices explicitly rather than
      // silently anchoring to nothing.
      let book = state.orderBook.get(addItem.pick.typeId);
      if (!book) {
        const { regionId } = setLocation(activeSet(), 'input');
        try {
          const res = await window.electronAPI.market.getOrderBookSummary(
            regionId,
            [addItem.pick.typeId]
          );
          book = (res && res.success ? res.summary : {})[addItem.pick.typeId] || {};
        } catch (error) {
          console.error('[market] baseline lookup failed:', error);
          book = {};
        }
      }

      if (Number.isFinite(book.buy)) payload.baseBuy = book.buy;
      if (Number.isFinite(book.sell)) payload.baseSell = book.sell;

      if (payload.baseBuy === undefined && payload.baseSell === undefined) {
        // Without an anchor, drift and every alert read "no baseline" - say so
        // now rather than letting the user wonder why nothing works.
        toast(
          `No market data for ${addItem.pick.typeName} here, so it has no baseline yet. ` +
          'Re-baseline once prices are available.',
          'warning'
        );
      }
    }

    try {
      const res = await window.electronAPI.market.watchlists.addItem(
        wl.id,
        addItem.pick.typeId,
        payload
      );
      if (!res || !res.success) {
        console.error('[market] failed to add watchlist item:', res && res.error);
        toast(res && res.error ? res.error : 'Could not save the item.', 'error');
        return;
      }
      closeModal('mk-additem-modal');
      await loadWatchlists();
      await loadWatchlistItems();
      renderWatchlist();
      renderWatchlistNav();

      // Watchlist members are part of the Pricing tab's row set, so the new
      // item has to be priced and the table rebuilt.
      await loadSafely('orderBook', loadOrderBook);
      renderSafely('pricing', renderPricing);
    } catch (error) {
      console.error('[market] add item failed:', error);
      toast('Could not save the item.', 'error');
    }
  }

  /* ----------------------------------------------- full market data drawer */

  const SVG_CHART_W = 720;
  const SVG_CHART_H = 180;

  /** Open the drawer for a type and populate it from cached market data. */
  async function openMarketDrawer(typeId) {
    const scrim = document.getElementById('mk-drawer');
    if (!scrim) return;

    state.drawerTypeId = typeId;
    scrim.hidden = false;

    const name = state.typeNames.get(typeId) || `Type ${typeId}`;
    document.getElementById('mk-drawer-name').textContent = name;
    document.getElementById('mk-drawer-typeid').textContent = `ID ${typeId}`;
    document.getElementById('mk-drawer-icon').src =
      `https://images.evetech.net/types/${typeId}/icon?size=64`;
    document.getElementById('mk-drawer-sub').textContent = (activeSet() || {}).name || '--';

    // Clear stale content while loading, so the previous item is never shown
    // under the new item's name.
    ['mk-drawer-sell', 'mk-drawer-buy', 'mk-drawer-stats', 'mk-drawer-calcs', 'mk-drawer-chart']
      .forEach((id) => { document.getElementById(id).textContent = ''; });
    document.getElementById('mk-drawer-trend').textContent = '--';
    document.getElementById('mk-drawer-hist-low').textContent = '--';
    document.getElementById('mk-drawer-hist-high').textContent = '--';

    // History may need an ESI round trip on first view, so say so rather than
    // showing an empty chart that looks like "no data".
    const chartHost = document.getElementById('mk-drawer-chart');
    const loading = document.createElement('div');
    loading.className = 'mk-chart-empty';
    loading.textContent = 'Loading market data…';
    chartHost.appendChild(loading);

    const { regionId, locationId } = setLocation(activeSet(), 'input');

    const [orders, history] = await Promise.all([
      loadDrawerOrders(regionId, typeId, locationId),
      loadDrawerHistory(regionId, typeId),
    ]);

    // Discard a response the user has moved on from - a second open landing
    // first, or the drawer closed mid-fetch.
    //
    // Deliberately AFTER the await, not before: the fetch runs in main and
    // writes through to the cache there, so letting it finish means the next
    // open of this item is instant. Only the RENDER is abandoned; the work is
    // never wasted.
    if (state.drawerTypeId !== typeId) return;

    renderDrawerOrders(orders);
    renderDrawerHistory(history);
    renderDrawerStats(orders, history);
    renderDrawerCalcs(orders, history);
    renderDrawerSync();
  }

  function closeMarketDrawer() {
    const scrim = document.getElementById('mk-drawer');
    if (scrim) scrim.hidden = true;
    state.drawerTypeId = null;
  }

  async function loadDrawerOrders(regionId, typeId, locationId) {
    if (!regionId) return [];
    try {
      const rows = await window.electronAPI.market.fetchOrders(regionId, typeId, locationId);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      console.error('[market] drawer order fetch failed:', error);
      return [];
    }
  }

  /**
   * Price history for the drawer.
   *
   * Main fetches from ESI when nothing is cached, so this can take a couple of
   * seconds on an item's first view - the caller shows a loading state. The
   * `fetched` flag tells us a network round trip happened, which is worth
   * mentioning since it also means the cache is now warm.
   */
  async function loadDrawerHistory(regionId, typeId) {
    if (!regionId) return [];
    try {
      const res = await window.electronAPI.market.getCachedHistory(regionId, typeId, 30);
      if (!res || !res.success) return [];
      if (res.fetched) {
        console.log(`[market] fetched history from ESI for type ${typeId}`);
      }
      return res.history || [];
    } catch (error) {
      console.error('[market] drawer history fetch failed:', error);
      return [];
    }
  }

  /** Best five orders a side, matching the mockup's two-column book. */
  function renderDrawerOrders(orders) {
    const sellHost = document.getElementById('mk-drawer-sell');
    const buyHost = document.getElementById('mk-drawer-buy');
    if (!sellHost || !buyHost) return;

    const sells = orders
      .filter((o) => !o.is_buy_order)
      .sort((a, b) => a.price - b.price)
      .slice(0, 8);
    const buys = orders
      .filter((o) => o.is_buy_order)
      .sort((a, b) => b.price - a.price)
      .slice(0, 8);

    const fill = (host, list, cls) => {
      host.textContent = '';
      if (list.length === 0) {
        const none = document.createElement('div');
        none.className = 'mk-order-empty';
        none.textContent = 'No orders';
        host.appendChild(none);
        return;
      }
      list.forEach((o) => {
        const line = document.createElement('div');
        line.className = 'mk-order-row';
        const price = document.createElement('span');
        price.className = cls;
        price.textContent = isk(o.price);
        const qty = document.createElement('span');
        qty.className = 'mk-order-qty';
        qty.textContent = num(o.volume_remain);
        line.appendChild(price);
        line.appendChild(qty);
        host.appendChild(line);
      });
    };

    fill(sellHost, sells, 'mk-order-sell');
    fill(buyHost, buys, 'mk-order-buy');
  }

  /**
   * 30-day price line, drawn as an SVG path.
   *
   * Built with createElementNS rather than innerHTML so the history values
   * cannot inject markup.
   */
  function renderDrawerHistory(history) {
    const host = document.getElementById('mk-drawer-chart');
    const trendEl = document.getElementById('mk-drawer-trend');
    const lowEl = document.getElementById('mk-drawer-hist-low');
    const highEl = document.getElementById('mk-drawer-hist-high');
    if (!host) return;

    host.textContent = '';

    const points = history
      .map((h) => Number(h.average))
      .filter((v) => Number.isFinite(v));

    if (points.length < 2) {
      const none = document.createElement('div');
      none.className = 'mk-chart-empty';
      none.textContent = 'No price history cached for this item.';
      host.appendChild(none);
      trendEl.textContent = '--';
      lowEl.textContent = '--';
      highEl.textContent = '--';
      return;
    }

    const lo = Math.min(...points);
    const hi = Math.max(...points);
    const pad = 8;
    const x = (i) => (i / (points.length - 1)) * SVG_CHART_W;
    const y = (v) => SVG_CHART_H - pad - ((v - lo) / (hi - lo || 1)) * (SVG_CHART_H - pad * 2);

    let line = '';
    points.forEach((v, i) => {
      line += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    });
    const area = `${line}L${SVG_CHART_W} ${SVG_CHART_H} L0 ${SVG_CHART_H} Z`;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SVG_CHART_W} ${SVG_CHART_H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'mk-chart');

    const defs = document.createElementNS(SVG_NS, 'defs');
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', 'mkChartFill');
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0');
    grad.setAttribute('y2', '1');
    [['0%', '0.35'], ['100%', '0']].forEach(([offset, opacity]) => {
      const stop = document.createElementNS(SVG_NS, 'stop');
      stop.setAttribute('offset', offset);
      stop.setAttribute('stop-color', 'var(--qf-accent)');
      stop.setAttribute('stop-opacity', opacity);
      grad.appendChild(stop);
    });
    defs.appendChild(grad);
    svg.appendChild(defs);

    [45, 90, 135].forEach((gy) => {
      const gridline = document.createElementNS(SVG_NS, 'line');
      gridline.setAttribute('x1', '0');
      gridline.setAttribute('y1', String(gy));
      gridline.setAttribute('x2', String(SVG_CHART_W));
      gridline.setAttribute('y2', String(gy));
      gridline.setAttribute('stroke', 'var(--qf-border-subtle)');
      gridline.setAttribute('stroke-width', '1');
      svg.appendChild(gridline);
    });

    const areaPath = document.createElementNS(SVG_NS, 'path');
    areaPath.setAttribute('d', area);
    areaPath.setAttribute('fill', 'url(#mkChartFill)');
    svg.appendChild(areaPath);

    const linePath = document.createElementNS(SVG_NS, 'path');
    linePath.setAttribute('d', line.trim());
    linePath.setAttribute('fill', 'none');
    linePath.setAttribute('stroke', 'var(--qf-accent)');
    linePath.setAttribute('stroke-width', '2');
    linePath.setAttribute('stroke-linejoin', 'round');
    linePath.setAttribute('stroke-linecap', 'round');
    svg.appendChild(linePath);

    host.appendChild(svg);

    const trendPct = ((points[points.length - 1] - points[0]) / points[0]) * 100;
    trendEl.textContent = `${trendPct >= 0 ? '+' : ''}${trendPct.toFixed(1)}%`;
    trendEl.className = 'mk-trend ' + (trendPct > 0 ? 'is-up' : trendPct < 0 ? 'is-down' : 'is-flat');
    lowEl.textContent = isk(lo);
    highEl.textContent = isk(hi);
  }

  function renderDrawerStats(orders, history) {
    const host = document.getElementById('mk-drawer-stats');
    if (!host) return;
    host.textContent = '';

    const sells = orders.filter((o) => !o.is_buy_order).map((o) => o.price);
    const buys = orders.filter((o) => o.is_buy_order).map((o) => o.price);
    const bestSell = sells.length ? Math.min(...sells) : null;
    const bestBuy = buys.length ? Math.max(...buys) : null;

    const points = history.map((h) => Number(h.average)).filter(Number.isFinite);
    const avg = points.length ? points.reduce((a, b) => a + b, 0) / points.length : null;
    const lo = points.length ? Math.min(...points) : null;
    const hi = points.length ? Math.max(...points) : null;

    const dayVolume = history.length
      ? Number(history[history.length - 1].volume) || null
      : null;

    const spread = bestSell !== null && bestBuy !== null && bestSell > 0
      ? ((bestSell - bestBuy) / bestSell) * 100
      : null;

    const stats = [
      ['Sell (min)', bestSell !== null ? isk(bestSell) : '--', 'is-accent'],
      ['Buy (max)', bestBuy !== null ? isk(bestBuy) : '--', 'is-success'],
      ['Spread', spread !== null ? `${spread.toFixed(1)}%` : '--', ''],
      ['30d Avg', avg !== null ? isk(avg) : '--', ''],
      ['30d Range', lo !== null ? `${isk(lo)} – ${isk(hi)}` : '--', ''],
      ['Daily Volume', dayVolume !== null ? num(dayVolume) : '--', ''],
    ];

    stats.forEach(([label, value, cls]) => {
      const cell = document.createElement('div');
      cell.className = 'mk-stat';
      const k = document.createElement('span');
      k.className = 'mk-stat-label';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'mk-stat-value' + (cls ? ` ${cls}` : '');
      v.textContent = value;
      cell.appendChild(k);
      cell.appendChild(v);
      host.appendChild(cell);
    });
  }

  /**
   * Side-by-side comparison of the pricing methods, with the ACTIVE method
   * highlighted so the user can see what their set currently resolves to.
   */
  function renderDrawerCalcs(orders, history) {
    const host = document.getElementById('mk-drawer-calcs');
    if (!host) return;
    host.textContent = '';

    const sells = orders.filter((o) => !o.is_buy_order).map((o) => o.price).sort((a, b) => a - b);
    const points = history.map((h) => Number(h.average)).filter(Number.isFinite);
    const avg = points.length ? points.reduce((a, b) => a + b, 0) / points.length : null;
    const sorted = [...points].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const best = sells.length ? sells[0] : null;
    const percentile = sells.length ? sells[Math.floor(sells.length * 0.2)] : null;

    const activeMethod = (setLocation(activeSet(), 'input') && (activeSet() || {}).inputMaterials || {}).priceMethod
      || 'immediate';

    const calcs = [
      ['immediate', 'Immediate', best, 'Best price'],
      ['hybrid', 'Hybrid', best !== null ? best * 0.995 : null, 'Recommended'],
      ['vwap', 'VWAP', avg, 'Vol-weighted'],
      ['percentile', 'Percentile', percentile, '20th pct'],
      ['historical', 'Historical', median, 'Median'],
    ];

    calcs.forEach(([key, label, value, note]) => {
      const cell = document.createElement('div');
      cell.className = 'mk-calc' + (key === activeMethod ? ' is-active' : '');
      const m = document.createElement('div');
      m.className = 'mk-calc-method';
      m.textContent = label;
      const v = document.createElement('div');
      v.className = 'mk-calc-value';
      v.textContent = value !== null && Number.isFinite(value) ? isk(value) : '--';
      const n = document.createElement('div');
      n.className = 'mk-calc-note';
      n.textContent = key === activeMethod ? `${note} · in use` : note;
      cell.appendChild(m);
      cell.appendChild(v);
      cell.appendChild(n);
      host.appendChild(cell);
    });
  }

  function renderDrawerSync() {
    const el = document.getElementById('mk-drawer-sync');
    if (!el) return;
    const fresh = QFFreshness.getFreshness(state.lastFetch);
    el.textContent = state.lastFetch ? `synced ${fresh.label}` : 'never synced';
    el.className = 'mk-drawer-sync-value is-' + fresh.level;
  }

  /* --------------------------------------------------------------- tabs */

  function switchTab(name) {
    state.tab = name;
    document.querySelectorAll('#market-view .mk-tab').forEach((tab) => {
      const active = tab.getAttribute('data-mk-tab') === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('#market-view .mk-panel').forEach((panel) => {
      panel.classList.toggle('is-active', panel.id === `mk-panel-${name}`);
    });

    if (name === 'overview') renderOverview();
    if (name === 'overrides') renderOverrides();
    if (name === 'watchlists') renderWatchlist();
  }

  /* --------------------------------------------------------------- data */

  async function loadOverrides() {
    try {
      const list = await window.electronAPI.market.getAllPriceOverrides();
      state.overrides = Array.isArray(list) ? list : [];
    } catch (error) {
      console.error('[market] failed to load overrides:', error);
      state.overrides = [];
    }

    // price_overrides stores only type_id, so names come from the SDE (resolved
    // in bulk by loadTypeNames). Without this the table shows "Type 23911".
    if (state.overrides.length > 0) {
      try {
        const lookup = toNameLookup(
          await window.electronAPI.sde.getTypeNames(state.overrides.map((o) => o.typeId))
        );
        state.overrides.forEach((o) => {
          o.name = lookup.get(o.typeId) || `Type ${o.typeId}`;
          if (o.name) state.typeNames.set(o.typeId, o.name);
        });
      } catch (error) {
        console.error('[market] failed to resolve override names:', error);
      }
    }
  }

  /**
   * Normalise sde.getTypeNames output to a Map.
   *
   * It returns a plain `{typeId: name}` object today, but accept an array of
   * rows too so a shape change does not silently blank every name.
   */
  function toNameLookup(names) {
    const lookup = new Map();
    if (Array.isArray(names)) {
      names.forEach((n) => lookup.set(n.typeID ?? n.typeId, n.typeName ?? n.name));
    } else if (names && typeof names === 'object') {
      Object.entries(names).forEach(([k, v]) => lookup.set(Number(k), v));
    }
    return lookup;
  }

  /** Load everything the view needs. Cache-only - never triggers an ESI fetch. */
  async function loadAll() {
    const [sets, characters, defaultCharacter, dashboard, lastFetch] = await Promise.all([
      window.electronAPI.market.getMarketSets().catch(() => []),
      window.electronAPI.esi.getCharacters().catch(() => []),
      window.electronAPI.esi.getDefaultCharacter().catch(() => null),
      window.electronAPI.market.getRegionDashboard().catch(() => []),
      window.electronAPI.market.getLastFetchTime().catch(() => null),
    ]);

    state.sets = Array.isArray(sets) ? sets : [];
    state.characters = Array.isArray(characters) ? characters : [];
    state.defaultCharacterId = defaultCharacter ? defaultCharacter.characterId : null;
    state.dashboard = Array.isArray(dashboard) ? dashboard : [];
    state.lastFetch = lastFetch;

    if (!state.activeSetId) {
      const preferred = state.sets.find((s) => s.isDefault) || state.sets[0];
      state.activeSetId = preferred ? preferred.id : null;
    }

    // A full reload means plan data may have changed underneath us (a refresh,
    // a re-lock elsewhere, an ESI cycle), so the per-type plan cache is dropped.
    state.planCache.clear();

    // Loads are isolated for the same reason the renders below are: one
    // rejecting load must not skip the remaining loads AND every render after
    // them. Each of these already swallows its own IPC errors, but a defect in
    // the surrounding code (a bad set shape, say) can still throw.
    await loadSafely('regionNames', loadRegionNames);
    await loadSafely('marketLocations', loadMarketLocations);
    await loadSafely('overrides', loadOverrides);
    await loadSafely('favourites', loadFavourites);
    await loadSafely('watchlists', loadWatchlists);
    await loadSafely('watchlistItems', loadWatchlistItems);
    await loadSafely('typeNames', loadTypeNames);
    await loadSafely('orderBook', loadOrderBook);

    // Each render is isolated: previously these ran as a bare sequence, so a
    // throw in one (e.g. renderPricing) aborted every render after it and left
    // those panels showing their template defaults - the "Overrides count stays
    // 0 until you click the tab" bug. A broken panel must not blank the others.
    renderSafely('characters', renderCharacters);
    renderSafely('setList', renderSetList);
    renderSafely('pricing', renderPricing);
    renderSafely('overrides', renderOverrides);
    renderSafely('watchlistNav', renderWatchlistNav);
    renderSafely('watchlist', renderWatchlist);
    if (state.tab === 'overview') renderSafely('overview', renderOverview);
  }

  /** Await one load step, logging rather than propagating so the rest still run. */
  async function loadSafely(label, fn) {
    try {
      await fn();
    } catch (error) {
      console.error(`[market] load failed: ${label}`, error);
    }
  }

  /** Run one render, logging rather than propagating so siblings still run. */
  function renderSafely(label, fn) {
    try {
      fn();
    } catch (error) {
      console.error(`[market] render failed: ${label}`, error);
    }
  }

  /**
   * Resolve names for every type the view can display, in one call.
   *
   * Pricing rows, override rows and watchlist rows all need names; doing this
   * once keeps them consistent and avoids three round trips.
   */
  async function loadTypeNames() {
    const ids = new Set();
    state.overrides.forEach((o) => ids.add(o.typeId));
    state.favourites.forEach((typeId) => ids.add(typeId));
    state.allWatchTypeIds.forEach((typeId) => ids.add(typeId));

    const missing = [...ids].filter((id) => !state.typeNames.has(id));
    if (missing.length === 0) return;

    try {
      const lookup = toNameLookup(await window.electronAPI.sde.getTypeNames(missing));
      lookup.forEach((name, id) => state.typeNames.set(id, name));
    } catch (error) {
      console.error('[market] failed to resolve type names:', error);
    }
  }

  /**
   * Run the Pricing filter against items traded in the active set's region.
   *
   * Region-scoped by design (user decision): the filter answers "what can I
   * price HERE", so it returns nothing until market data has been fetched for
   * that region, rather than listing items with no orders.
   */
  async function runPricingSearch() {
    const q = state.query.trim();
    const token = ++state.searchToken;

    if (q.length < 2) {
      state.searchResults = [];
      await loadOrderBook();
      renderSafely('pricing', renderPricing);
      return;
    }

    const { regionId } = setLocation(activeSet(), 'input');
    if (!regionId) {
      state.searchResults = [];
      renderSafely('pricing', renderPricing);
      return;
    }

    try {
      const res = await window.electronAPI.market.searchTradedItems(regionId, q, 50);
      if (token !== state.searchToken) return;
      state.searchResults = res && res.success ? res.items : [];
      state.searchResults.forEach((r) => state.typeNames.set(r.typeId, r.typeName));
    } catch (error) {
      console.error('[market] traded-item search failed:', error);
      state.searchResults = [];
    }

    await loadOrderBook();
    renderSafely('pricing', renderPricing);
  }

  /** Buy/sell/volume for whatever the Pricing tab is about to show. */
  async function loadOrderBook() {
    const { regionId } = setLocation(activeSet(), 'input');
    if (!regionId) {
      state.orderBook = new Map();
      return;
    }

    const ids = new Set();
    if (state.query.trim().length >= 2) {
      state.searchResults.forEach((r) => ids.add(r.typeId));
    } else {
      state.overrides.forEach((o) => ids.add(o.typeId));
      state.favourites.forEach((typeId) => ids.add(typeId));
      state.allWatchTypeIds.forEach((typeId) => ids.add(typeId));
    }

    if (ids.size === 0) {
      state.orderBook = new Map();
      return;
    }

    try {
      const res = await window.electronAPI.market.getOrderBookSummary(regionId, [...ids]);
      const summary = res && res.success ? res.summary : {};
      state.orderBook = new Map(
        Object.entries(summary).map(([k, v]) => [Number(k), v])
      );
    } catch (error) {
      console.error('[market] failed to load order book:', error);
      state.orderBook = new Map();
    }
  }

  /** Seeded trade hubs; static, so load once per mount. */
  async function loadMarketLocations() {
    if (state.marketLocations.length > 0) return;
    try {
      const res = await window.electronAPI.market.getMarketLocations();
      state.marketLocations = res && res.success ? res.locations : [];
    } catch (error) {
      console.error('[market] failed to load market locations:', error);
      state.marketLocations = [];
    }
  }

  /** Region names change only with the SDE, so load them once per mount. */
  async function loadRegionNames() {
    if (state.regionNames.size > 0) return;
    try {
      const rows = await window.electronAPI.sde.getAllRegions();
      (Array.isArray(rows) ? rows : []).forEach((r) => {
        state.regionNames.set(r.regionID ?? r.regionId, r.regionName ?? r.name);
      });
    } catch (error) {
      console.error('[market] failed to load region names:', error);
    }
  }

  async function loadFavourites() {
    try {
      const res = await window.electronAPI.market.favorites.getAll();
      const list = res && res.success ? res.favorites : [];
      state.favourites = new Set(Array.isArray(list) ? list : []);
    } catch (error) {
      console.error('[market] failed to load favourites:', error);
      state.favourites = new Set();
    }
  }

  /* -------------------------------------------------------------- mount */

  async function mount(container, params, ctx) {
    if (container && !container.querySelector('#market-view')) {
      const fragment = await loadTemplate();
      if (fragment) container.appendChild(fragment);
    }

    // Tabs
    document.querySelectorAll('#market-view .mk-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.getAttribute('data-mk-tab')));
    });

    const gotoOverrides = document.getElementById('mk-goto-overrides');
    if (gotoOverrides) gotoOverrides.addEventListener('click', () => switchTab('overrides'));

    // Filter. Debounced because each keystroke hits the SDE and the order book.
    const search = document.getElementById('mk-search');
    const searchClear = document.getElementById('mk-search-clear');
    if (search) {
      let searchTimer = null;

      /** Clear the filter and restore the default rows immediately. */
      const clearFilter = () => {
        if (searchTimer) clearTimeout(searchTimer);
        search.value = '';
        state.query = '';
        if (searchClear) searchClear.hidden = true;
        runPricingSearch();
      };

      search.addEventListener('input', () => {
        state.query = search.value;
        if (searchClear) searchClear.hidden = search.value.length === 0;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => runPricingSearch(), 200);
      });

      // Esc clears the filter while it has focus. Stop propagation so the
      // document-level Esc handler does not also act on it.
      search.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (search.value === '') {
          search.blur();
          return;
        }
        e.preventDefault();
        clearFilter();
      });

      if (searchClear) {
        searchClear.addEventListener('click', () => {
          clearFilter();
          search.focus();
        });
      }

      ctx.track(() => { if (searchTimer) clearTimeout(searchTimer); });
    }

    // Refresh buttons share one path; the tile-style progress lives on the
    // Dashboard, so here we just disable while running.
    const refreshOne = document.getElementById('mk-refresh-market');
    const refreshAll = document.getElementById('mk-refresh-all');
    // withButtonBusy remembers and restores the button's own label, so callers
    // no longer have to pass the caption back in to put it right.
    const doRefresh = async (btn) => {
      if (!btn) return;
      await QFUI.withButtonBusy(btn, 'Refreshing…', async () => {
        // A refresh spans regions AND structures across five phases, and neither
        // maps cleanly onto a market set - a set can span several regions, and a
        // region can belong to several sets. So the progress goes in one dialog
        // for the whole operation rather than being smeared across set cards.
        openRefreshModal();
        state.sets.forEach((s) => state.refreshingSets.add(s.id));
        renderOverview();

        try {
          const result = await window.electronAPI.market.updateAllMarketData();
          reportRefreshOutcome(result);
        } catch (error) {
          console.error('[market] refresh failed:', error);
          toast(`Market refresh failed: ${error.message}`, 'error');
        } finally {
          // Closed here as well as on the `done` stage: if the IPC itself
          // rejects, no stage ever arrives and the dialog would stay up.
          closeRefreshModal();
          state.refreshingSets.clear();
          state.fetchProgress.clear();
          await loadAll();
        }
      });
    };
    if (refreshOne) refreshOne.addEventListener('click', () => doRefresh(refreshOne));
    if (refreshAll) refreshAll.addEventListener('click', () => doRefresh(refreshAll));

    // Market set / override creation route to the legacy editors until their
    // modals are ported.
    const newSet = document.getElementById('mk-new-set');
    if (newSet) newSet.addEventListener('click', () => openSetEditor(null));
    const newSetOverview = document.getElementById('mk-new-set-overview');
    if (newSetOverview) newSetOverview.addEventListener('click', () => openSetEditor(null));

    const addOverride = document.getElementById('mk-add-override');
    if (addOverride) addOverride.addEventListener('click', () => openOverrideModal(null));

    /* ---- market set editor ---- */

    const setName = document.getElementById('mk-set-name');
    if (setName) {
      setName.addEventListener('input', () => {
        if (setDraft) setDraft.name = setName.value;
        updateSetSummary();
      });
    }

    const mirror = document.getElementById('mk-set-mirror');
    if (mirror) {
      mirror.addEventListener('change', () => {
        applyMirrorState();
        updateSetSummary();
      });
    }

    const setSave = document.getElementById('mk-set-save');
    if (setSave) setSave.addEventListener('click', () => saveSetEditor());

    const setReset = document.getElementById('mk-set-reset');
    if (setReset) setReset.addEventListener('click', () => resetSetEditor());

    const setDelete = document.getElementById('mk-set-delete');
    if (setDelete) setDelete.addEventListener('click', () => deleteSetFromEditor());

    /* ---- price override modal ---- */

    // The item search is a shared QFSearchSelect mounted by
    // mountOverrideSearch(); it owns its own input, debounce and keyboard.

    const ovPrice = document.getElementById('mk-ov-price');
    if (ovPrice) ovPrice.addEventListener('input', () => renderOverrideForm());

    const ovClear = document.getElementById('mk-ov-clear');
    if (ovClear) {
      ovClear.addEventListener('click', () => {
        // Clearing the pick re-mounts a FRESH search, so no stale query or
        // results survive - the component starts from an empty state.
        overrideForm.pick = null;
        destroySearchSelects('override');
        renderOverrideForm();
      });
    }

    const ovSave = document.getElementById('mk-ov-save');
    if (ovSave) ovSave.addEventListener('click', () => saveOverride());

    /* ---- market data drawer ---- */

    const drawerScrim = document.getElementById('mk-drawer');
    if (drawerScrim) {
      // Clicking the scrim closes; clicking the panel must not.
      drawerScrim.addEventListener('click', (e) => {
        if (e.target === drawerScrim) closeMarketDrawer();
      });
    }
    const drawerClose = document.getElementById('mk-drawer-close');
    if (drawerClose) drawerClose.addEventListener('click', () => closeMarketDrawer());
    const drawerDone = document.getElementById('mk-drawer-done');
    if (drawerDone) drawerDone.addEventListener('click', () => closeMarketDrawer());

    const drawerOverride = document.getElementById('mk-drawer-override');
    if (drawerOverride) {
      drawerOverride.addEventListener('click', () => {
        const typeId = state.drawerTypeId;
        closeMarketDrawer();
        const existing = state.overrides.find((o) => o.typeId === typeId);
        openOverrideModal(existing || null);
        if (!existing && typeId) {
          // Pre-pick the item the drawer was showing.
          overrideForm.pick = {
            typeId,
            typeName: state.typeNames.get(typeId) || `Type ${typeId}`,
          };
          renderOverrideForm();
        }
      });
    }

    /* ---- watchlists ---- */

    const bindClick = (id, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', (...args) => trackPending(handler(...args)));
    };

    bindClick('mk-new-watchlist', () => openWatchlistForm('create'));
    bindClick('mk-wl-new', () => openWatchlistForm('create'));
    bindClick('mk-wl-empty-new', () => openWatchlistForm('create'));
    bindClick('mk-wl-edit', () => openWatchlistForm('edit'));
    bindClick('mk-wl-delete', () => deleteActiveWatchlist());
    bindClick('mk-wl-form-save', () => saveWatchlistForm());
    bindClick('mk-wl-add-item', () => openAddItemModal(null));
    bindClick('mk-additem-save', () => saveAddItem());
    bindClick('mk-additem-clear', () => {
      // Clearing the chosen item returns to an EMPTY search, not to whatever
      // partial query happened to find it - re-mounting a fresh search
      // guarantees no stale query or results survive.
      addItem.pick = null;
      destroySearchSelects('additem');
      renderAddItem();
    });

    // Close affordances: the X, Cancel, and clicking the backdrop.
    document.querySelectorAll('#market-view [data-mk-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.getAttribute('data-mk-close')));
    });
    document.querySelectorAll('#market-view .modal').forEach((modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal.id);
      });
    });

    // Enter submits the watchlist name field.
    const wlName = document.getElementById('mk-wl-form-name');
    if (wlName) {
      wlName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveWatchlistForm();
        }
      });
    }

    // The Add Item search is a shared QFSearchSelect mounted by
    // mountAddItemSearch(); it owns its own input, debounce and keyboard.

    // Both sides are wired identically; the side comes off the element.
    SIDES.forEach((side) => {
      const typeSel = document.getElementById(`mk-additem-${side}-type`);
      if (typeSel) {
        typeSel.addEventListener('change', () => {
          addItem[side].type = typeSel.value;
          renderAddItem();
        });
      }

      const valueInput = document.getElementById(`mk-additem-${side}-value`);
      if (valueInput) valueInput.addEventListener('input', () => updateAddItemSummary());

      document.querySelectorAll(`#mk-additem-${side}-dir .mk-dir`).forEach((btn) => {
        btn.addEventListener('click', () => {
          addItem[side].direction = btn.getAttribute('data-mk-dir');
          renderAddItem();
        });
      });
    });

    // Esc closes whichever overlay is open. Modals sit above the drawer, so
    // they take priority - one Esc should not dismiss both.
    ctx.on(document, 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelector('#market-view .modal:not([hidden])');
      if (open) {
        closeModal(open.id);
        return;
      }
      const drawer = document.getElementById('mk-drawer');
      if (drawer && !drawer.hidden) closeMarketDrawer();
    });

    await loadAll();

    // Stay live: market refreshes and background cycles re-read the view.
    const api = window.electronAPI.data;
    if (api) {
      ctx.track(api.onMarketChanged(() => loadAll()));
      ctx.track(api.onCycleComplete(() => loadAll()));
    }

    // Which stage of the refresh is running, and how far through. Only main
    // knows the plan (how many regions, how many structures), so this is what
    // turns an anonymous spinner into "Region 3 of 12".
    ctx.track(window.electronAPI.market.onRefreshStage((stage) => {
      if (!stage) return;
      applyRefreshStage(stage);
    }));

    // ESI page counts within whatever location is currently being fetched.
    // Feeds the sub-line of the same dialog - a 20-page structure otherwise
    // looks stalled for its whole duration.
    ctx.track(window.electronAPI.market.onFetchProgress((p) => {
      if (!p) return;

      // A page that failed out after its retries. Raised even when the dialog
      // is closed - the fetch runs on regardless, and silently serving prices
      // off an incomplete order book is exactly what this is here to prevent.
      if (p.error) {
        toast(p.message || 'Some market pages failed to fetch. Data is incomplete.', 'error');
        return;
      }

      if (!refreshProgress.open) return;
      refreshProgress.pages =
        p.totalPages > 1 ? { current: p.currentPage, total: p.totalPages } : null;
      renderRefreshModal();
    }));
    ctx.track(window.electronAPI.esi.onDefaultCharacterChanged(() => loadAll()));

    // Keep displayed ages counting up between events.
    ctx.setInterval(() => {
      renderSetList();
      renderSummary();
      if (state.tab === 'overview') renderOverview();
    }, 60000);

    return {};
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('market', {
      title: 'Market Manager',
      mount,
      // For tests: await the async work a click handler started, instead of
      // draining the macrotask queue a fixed number of times and hoping.
      whenSettled,
    });
  }
})();
