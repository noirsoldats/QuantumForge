// Main window renderer.
//
// Builds the application shell, registers every tool with the ShellRouter, and
// renders the dashboard (status tiles + tool cards).
//
// Navigation model: tools mount into the shell's #view-host rather than
// replacing the document. Tools whose renderers have not been converted yet are
// hosted in a same-origin iframe (see shell.js `file:` views) - the shell chrome
// never reloads either way.

console.log('Quantum Forge renderer initialized');


let currentDefaultCharacterId = null;
let characterMenuClickOutsideListener = null;

// Global error handlers
window.onerror = (message, source, lineno, colno, error) => {
  console.error('Renderer error:', { message, source, lineno, colno, error });
  return false;
};

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

/* ============================================================
   Tool registry

   `file` = not yet ported; hosted in an iframe by the shell.
   `standalone: true` = always opens as its own window, never mounted here.
   ============================================================ */

const TOOLS = [
  {
    id: 'market',
    name: 'Market Manager',
    desc: 'Live market pricing across your saved sets.',
    cardId: 'market-manager-card',
    icon: [['path', { d: 'M3 3v18h18' }], ['path', { d: 'M7 14l4-4 3 3 5-6' }]],
  },
  {
    id: 'blueprint-calculator',
    name: 'Blueprint Calculator',
    desc: 'Material, cost and profit for any blueprint.',
    cardId: 'blueprints-card',
    icon: [
      ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }],
      ['polyline', { points: '14 2 14 8 20 8' }],
    ],
  },
  {
    id: 'manufacturing-plans',
    name: 'Manufacturing Plans',
    desc: 'Track builds with locked prices.',
    cardId: 'manufacturing-plans-card',
    icon: [['rect', { x: 6, y: 4, width: 12, height: 17, rx: 2 }], ['path', { d: 'M9 11l2 2 4-4' }]],
  },
  {
    id: 'manufacturing-summary',
    name: 'Manufacturing Summary',
    desc: 'Profitability roll-up across blueprints.',
    cardId: 'manufacturing-summary-card',
    // No openWindow: this is a native shell view and mounts in the main
    // window's content pane. Pop-out arrives with the generic pop-out work.
    icon: [
      ['line', { x1: 18, y1: 20, x2: 18, y2: 10 }],
      ['line', { x1: 12, y1: 20, x2: 12, y2: 4 }],
      ['line', { x1: 6, y1: 20, x2: 6, y2: 14 }],
    ],
  },
  {
    id: 'facilities',
    name: 'Facilities',
    desc: 'Structures, rigs and activity bonuses.',
    cardId: 'facilities-card',
    icon: [['path', { d: 'M3 21V9l7-4v4l7-4v16z' }], ['line', { x1: 10, y1: 9, x2: 10, y2: 13 }]],
  },
  {
    id: 'reactions',
    name: 'Reactions',
    desc: 'Reaction chain cost and profit.',
    cardId: 'reactions-calculator-card',
    icon: [
      ['circle', { cx: 12, cy: 12, r: 2 }],
      ['ellipse', { cx: 12, cy: 12, rx: 10, ry: 4.5 }],
      ['ellipse', { cx: 12, cy: 12, rx: 10, ry: 4.5, transform: 'rotate(60 12 12)' }],
      ['ellipse', { cx: 12, cy: 12, rx: 10, ry: 4.5, transform: 'rotate(120 12 12)' }],
    ],
  },
  {
    id: 'loot-analyzer',
    name: 'Loot Analyzer',
    desc: 'Reprocess vs. sell across two markets.',
    cardId: 'loot-analyzer-card',
    // No openWindow: this is a native shell view and mounts in the main
    // window's content pane.
    icon: [['circle', { cx: 11, cy: 11, r: 8 }], ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]],
  },
  {
    id: 'what-can-i-build',
    name: 'What Can I Build?',
    desc: 'Buildable now from on-hand materials.',
    cardId: 'cleanup-tool-card',
    // No openWindow: this is a native shell view and mounts in the main
    // window's content pane.
    icon: [
      ['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }],
      ['polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }],
      ['line', { x1: 12, y1: 22.08, x2: 12, y2: 12 }],
    ],
  },
];

const SVG_NS = 'http://www.w3.org/2000/svg';

function toolIcon(defs, size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  defs.forEach(([tag, attrs]) => {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    svg.appendChild(node);
  });
  return svg;
}

/* ============================================================
   Dashboard view
   ============================================================ */

/** Open a tool: mount it in the shell, or spawn its own window. */
function openTool(tool) {
  if (tool.openWindow) {
    tool.openWindow();
  } else {
    window.QFShell.router.show(tool.id);
  }
}

/** Build the tool card grid. Card ids are part of the renderer contract. */
function renderToolCards() {
  const grid = document.getElementById('dash-tools');
  if (!grid) return;
  grid.textContent = '';

  TOOLS.forEach((tool) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'qf-tool-card';
    card.id = tool.cardId;

    const bar = document.createElement('div');
    bar.className = 'qf-tool-card-bar';
    card.appendChild(bar);

    const body = document.createElement('div');
    body.className = 'qf-tool-card-body';

    const top = document.createElement('div');
    top.className = 'qf-tool-card-top';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'qf-tool-icon';
    iconWrap.appendChild(toolIcon(tool.icon, 26));
    top.appendChild(iconWrap);

    const badge = document.createElement('span');
    badge.className = 'qf-tool-badge';
    badge.id = `${tool.id}-badge`;
    badge.hidden = true;
    top.appendChild(badge);
    body.appendChild(top);

    const name = document.createElement('div');
    name.className = 'qf-tool-name';
    name.textContent = tool.name;
    body.appendChild(name);

    const desc = document.createElement('div');
    desc.className = 'qf-tool-desc';
    desc.textContent = tool.desc;
    body.appendChild(desc);

    const spacer = document.createElement('span');
    spacer.className = 'qf-tool-spacer';
    body.appendChild(spacer);

    const stat = document.createElement('div');
    stat.className = 'qf-tool-stat';
    stat.id = `${tool.id}-stat`;
    stat.textContent = '';
    body.appendChild(stat);

    card.appendChild(body);
    card.addEventListener('click', () => openTool(tool));
    grid.appendChild(card);
  });
}

/** Set a tool card's stat line. */
function setToolStat(toolId, text, state) {
  const el = document.getElementById(`${toolId}-stat`);
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('is-ok', 'is-warning');
  if (state) el.classList.add(`is-${state}`);
}

/** Set (or clear) a tool card's badge. */
function setToolBadge(toolId, label) {
  const el = document.getElementById(`${toolId}-badge`);
  if (!el) return;
  if (label) {
    el.textContent = label;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

/** Apply a state class to a status tile, clearing the others. */
function setTileState(tileId, state) {
  const el = document.getElementById(tileId);
  if (!el) return;
  el.classList.remove('is-ok', 'is-warning', 'is-error', 'is-fresh');
  if (state) el.classList.add(`is-${state}`);
}

/* ---- Tile loaders ---- */

async function loadMarketTile() {
  try {
    const lastFetch = await window.electronAPI.market.getLastFetchTime();
    const ageEl = document.getElementById('tile-market-age');
    const detailEl = document.getElementById('tile-market-detail');

    if (!lastFetch) {
      if (ageEl) ageEl.textContent = 'Never';
      if (detailEl) detailEl.textContent = 'No market data yet';
      setTileState('tile-market', 'error');
      setToolStat('market', 'No market data', 'warning');
      return;
    }

    // One shared threshold scheme for the whole app (shared/freshness.js).
    const fresh = QFFreshness.getFreshness(lastFetch);
    const state = fresh.level === 'fresh' ? 'fresh' : fresh.level === 'warn' ? 'warning' : 'error';

    if (ageEl) ageEl.textContent = fresh.label;
    setTileState('tile-market', state);

    // Detail line: the default market set plus how many are configured.
    let detail = 'Market data';
    let setCount = 0;
    try {
      const sets = await window.electronAPI.market.getMarketSets();
      if (Array.isArray(sets) && sets.length) {
        setCount = sets.length;
        const defaultSet = sets.find((s) => s.isDefault || s.is_default) || sets[0];
        const name = defaultSet && (defaultSet.name || defaultSet.setName);
        detail = name
          ? `${name} · ${setCount} set${setCount === 1 ? '' : 's'}`
          : `${setCount} set${setCount === 1 ? '' : 's'}`;
      } else {
        detail = 'No market sets configured';
      }
    } catch (_) { /* detail is best-effort */ }
    if (detailEl) detailEl.textContent = detail;

    setToolStat(
      'market',
      setCount
        ? `${setCount} set${setCount === 1 ? '' : 's'} · oldest ${fresh.label}`
        : `Updated ${fresh.label} ago`,
      state === 'fresh' ? 'ok' : 'warning'
    );
  } catch (error) {
    console.error('Error loading market tile:', error);
  }
}

async function loadEsiTile() {
  try {
    const status = await window.electronAPI.esiStatus.getAggregated();
    const labelEl = document.getElementById('tile-esi-status');
    const listEl = document.getElementById('tile-esi-endpoints');

    const overall = status?.overall || 'green';
    const state = overall === 'green' ? 'ok' : overall === 'yellow' ? 'warning' : 'error';
    const label = overall === 'green' ? 'Operational' : overall === 'yellow' ? 'Degraded' : 'Down';

    if (labelEl) labelEl.textContent = label;
    setTileState('tile-esi', state);

    // Endpoint breakdown, derived from the aggregate counts.
    if (listEl) {
      listEl.textContent = '';
      const rows = [
        ['Healthy', status?.successCount ?? 0, 'ok'],
        ['Warnings', status?.warningCount ?? 0, 'warning'],
        ['Errors', status?.errorCount ?? 0, 'error'],
      ];
      rows.forEach(([name, count, tone]) => {
        if (!count) return;
        const row = document.createElement('div');
        row.className = 'dash-endpoint';
        const n = document.createElement('span');
        n.className = 'dash-endpoint-name';
        n.textContent = name;
        const v = document.createElement('span');
        v.className = `dash-endpoint-state is-${tone}`;
        v.textContent = String(count);
        row.appendChild(n);
        row.appendChild(v);
        listEl.appendChild(row);
      });
    }
  } catch (error) {
    console.error('Error loading ESI tile:', error);
  }
}

async function loadPlansTile() {
  try {
    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();
    const countEl = document.getElementById('tile-plans-count');
    const noteEl = document.getElementById('tile-plans-note');

    if (!defaultCharacter) {
      if (countEl) countEl.textContent = '0';
      if (noteEl) noteEl.textContent = 'No character selected';
      setToolStat('manufacturing-plans', 'No character selected');
      return;
    }

    const plans = await window.electronAPI.plans.getAll(defaultCharacter.characterId, { status: 'active' });
    const count = Array.isArray(plans) ? plans.length : 0;

    if (countEl) countEl.textContent = String(count);
    if (noteEl) {
      noteEl.textContent = count ? `${count} in progress` : 'No active plans';
      noteEl.classList.remove('is-warning');
    }
    setToolStat('manufacturing-plans', count ? `${count} active` : 'No active plans', count ? 'ok' : null);
  } catch (error) {
    console.error('Error loading plans tile:', error);
  }
}

async function loadServerTile() {
  const labelEl = document.getElementById('tile-server-status');
  const noteEl = document.getElementById('tile-server-note');

  try {
    // Read-only. This used to call status.fetch(), which triggers a real ESI
    // call - so the dashboard and the footer raced each other, one of them got
    // rate-limited, and the two then disagreed about whether the server was up.
    // The background cycle owns fetching now; both just read what it stored.
    const cached = await window.electronAPI.status.getCached();

    if (cached) {
      const vip = cached.vip === true;
      if (labelEl) labelEl.textContent = vip ? 'VIP Mode' : 'Online';
      setTileState('tile-server', vip ? 'warning' : 'ok');
      if (noteEl) {
        noteEl.textContent = cached.players
          ? `${Number(cached.players).toLocaleString()} pilots online`
          : 'Tranquility';
      }
      return;
    }

    // Nothing stored yet - the first refresh cycle has not landed. That is
    // "not known", not "offline".
    if (labelEl) labelEl.textContent = 'Unknown';
    setTileState('tile-server', 'warning');
    if (noteEl) noteEl.textContent = 'Status unavailable';
  } catch (error) {
    console.error('Error loading server tile:', error);
    if (labelEl) labelEl.textContent = 'Unknown';
    setTileState('tile-server', 'warning');
    if (noteEl) noteEl.textContent = 'Status unavailable';
  }
}

/** Populate the tool cards whose stats come from other sources. */
async function loadToolStats() {
  try {
    const facilities = await window.electronAPI.facilities.getFacilities();
    const n = Array.isArray(facilities) ? facilities.length : 0;
    setToolStat('facilities', n ? `${n} structure${n === 1 ? '' : 's'} configured` : 'No facilities yet', n ? 'ok' : null);
  } catch (_) { /* non-fatal */ }

  try {
    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();
    if (defaultCharacter) {
      const blueprints = await window.electronAPI.blueprints.getAll(defaultCharacter.characterId);
      const n = Array.isArray(blueprints) ? blueprints.length : 0;
      setToolStat('blueprint-calculator', n ? `${n.toLocaleString()} blueprints owned` : 'No blueprints cached', n ? 'ok' : null);
    }
  } catch (_) { /* non-fatal */ }

  // These four tools have no persistent state worth counting, so their stat
  // line stays a description of what the tool does.
  setToolStat('manufacturing-summary', 'Rank builds by profit');
  setToolStat('reactions', 'Reaction calculator');
  setToolStat('loot-analyzer', 'Reprocess vs. market');
  setToolStat('what-can-i-build', 'Build from on-hand assets');
}

/* ---- Market refresh with in-tile progress ---- */

let marketRefreshInFlight = false;
let disposeMarketProgress = null;

/** Show/hide the market tile's progress bar. */
function setMarketProgress(visible, { percent, label, indeterminate } = {}) {
  const wrap = document.getElementById('tile-market-progress');
  const fill = document.getElementById('tile-market-progress-fill');
  const text = document.getElementById('tile-market-progress-label');
  if (!wrap) return;

  wrap.hidden = !visible;
  if (!visible) {
    wrap.classList.remove('is-indeterminate');
    if (fill) fill.style.width = '0%';
    return;
  }

  wrap.classList.toggle('is-indeterminate', !!indeterminate);
  if (fill && !indeterminate && Number.isFinite(percent)) {
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
  if (text && label) text.textContent = label;
}

/**
 * Refresh all market data (regions, structures, adjusted prices, cost indices)
 * and report progress in the tile.
 *
 * This is deliberately separate from the header's "Refresh Industry Data"
 * button: market refreshes are slow and rate-limited, so they get their own
 * affordance with its own progress rather than hiding inside a generic action.
 */
async function refreshMarketData() {
  if (marketRefreshInFlight) return;
  marketRefreshInFlight = true;

  const btn = document.getElementById('tile-market-refresh');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
  }

  // Start indeterminate: the first progress event only arrives once page
  // fetching begins, and some steps report no progress at all.
  setMarketProgress(true, { indeterminate: true, label: 'Contacting ESI…' });

  /*
   * Live progress from the main process, sent only to the frame that asked for
   * the refresh - a dashboard in another window stays quiet.
   *
   * The dashboard keeps its inline tile rather than the Market view's dialog:
   * it is a screen you pass through, and blocking it behind a modal for the
   * length of a refresh is a worse trade there. Same events, presented to suit
   * the surface.
   */
  let currentPhase = '';

  const PHASE_LABELS = {
    starting: 'Contacting ESI',
    regions: 'Region market orders',
    structures: 'Private structure orders',
    'adjusted-prices': 'Adjusted prices',
    'cost-indices': 'Industry cost indices',
  };

  const disposeStage = window.electronAPI.market.onRefreshStage((stage) => {
    if (!stage || stage.phase === 'done') return;
    // Phase context the page counts alone cannot give: without it the tile says
    // "page 3 of 9" with no hint whether that is the first region of twelve.
    const name = PHASE_LABELS[stage.phase] || '';
    currentPhase = stage.total > 1
      ? `${name} — ${stage.current} of ${stage.total}`
      : name;
    setMarketProgress(true, { indeterminate: true, label: currentPhase });
  });

  disposeMarketProgress = window.electronAPI.market.onFetchProgress((p) => {
    if (!p) return;
    const pct = Number(p.progress);
    if (Number.isFinite(pct)) {
      // `currentPage` is the COUNT of pages fetched, not a page number - pages
      // come back out of order, so it never identifies a specific page.
      const pages = p.totalPages > 1 ? ` · ${p.currentPage} of ${p.totalPages} pages` : '';
      setMarketProgress(true, {
        percent: pct,
        indeterminate: false,
        label: `${currentPhase || 'Fetching orders'}${pages}`,
      });
    }
  });

  try {
    const result = await window.electronAPI.market.updateAllMarketData();
    if (result && result.errors && result.errors.length) {
      console.warn('Market refresh completed with errors:', result.errors);
      setMarketProgress(true, { percent: 100, indeterminate: false, label: 'Completed with warnings' });
    } else {
      setMarketProgress(true, { percent: 100, indeterminate: false, label: 'Up to date' });
    }
  } catch (error) {
    console.error('Market refresh failed:', error);
    setMarketProgress(true, { percent: 100, indeterminate: false, label: 'Refresh failed' });
  } finally {
    if (disposeStage) disposeStage();
    if (disposeMarketProgress) {
      disposeMarketProgress();
      disposeMarketProgress = null;
    }
    // Leave the final message visible briefly, then re-read the tile.
    setTimeout(() => {
      setMarketProgress(false);
      loadMarketTile();
    }, 1200);

    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Refresh';
    }
    marketRefreshInFlight = false;
  }
}

/** Refresh every dashboard tile. */
async function refreshDashboard() {
  await Promise.allSettled([
    loadMarketTile(),
    loadEsiTile(),
    loadPlansTile(),
    loadServerTile(),
    loadToolStats(),
  ]);
}

/** Greeting line: character name + EVE date. */
async function loadGreeting() {
  try {
    const defaultCharacter = await window.electronAPI.esi.getDefaultCharacter();
    const welcomeEl = document.getElementById('dash-welcome');
    const subEl = document.getElementById('dash-subtitle');

    if (welcomeEl) {
      welcomeEl.textContent = defaultCharacter
        ? `Welcome back, ${defaultCharacter.characterName}`
        : 'Welcome to Quantum Forge';
    }
    if (subEl) {
      const now = new Date();
      const eveDate = now.toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
      });
      subEl.textContent = `Your industry operations at a glance. ${eveDate} · YC${now.getUTCFullYear() - 1898}`;
    }
  } catch (error) {
    console.error('Error loading greeting:', error);
  }
}

/* ============================================================
   Shell + router wiring
   ============================================================ */

function registerViews() {
  const router = window.QFShell.router;

  // The dashboard itself. Re-renders its tiles on every mount so returning to
  // it always shows current data.
  router.register('dashboard', {
    title: 'Dashboard',
    mount(container, params, ctx) {
      const view = document.getElementById('dashboard-view');
      if (view) container.appendChild(view);
      refreshDashboard();

      // React to fresh data instead of only reading it at mount. This is what
      // makes the "market data is Nh old" tile clear itself after a refresh
      // completes in ANY window, with no user action.
      const api = window.electronAPI.data;
      if (api) {
        ctx.track(api.onMarketChanged(() => loadMarketTile()));
        ctx.track(api.onCycleComplete(() => refreshDashboard()));
        // Endpoint-level changes: only re-read the tile that endpoint feeds, so
        // a burst of fetches does not re-query everything repeatedly.
        ctx.track(api.onChanged((info) => {
          if (!info) return;
          if (info.endpointType === 'server_status') loadServerTile();
          else if (String(info.endpointType).startsWith('market')) loadMarketTile();
          else if (String(info.endpointType).includes('industry')) loadPlansTile();
          loadEsiTile(); // ESI health reflects every call
        }));
      }

      // Keep the displayed age counting up between events.
      ctx.setInterval(() => loadMarketTile(), 60000);

      return {
        destroy() {
          // Park the view back on <body> so it survives for the next mount.
          if (view && view.parentNode) document.body.appendChild(view);
        },
      };
    },
  });

  // Tools. Those with a `file` are hosted in an iframe until their renderer is
  // converted to a native view; the shell chrome does not reload either way.
  TOOLS.forEach((tool) => {
    if (tool.file) {
      router.register(tool.id, { title: tool.name, file: tool.file });
    }
  });

  // Settings registers ITSELF as a native view (see settings-renderer.js),
  // since its markup and logic ship together. Nothing to do here.
}

/** Rail selection: mount in-shell, spawn a window, or open Settings. */
function onRailSelect(entry) {
  if (entry.id === 'dashboard') {
    window.QFShell.router.show('dashboard');
    return;
  }
  if (entry.id === 'settings') {
    window.QFShell.router.show('settings');
    return;
  }
  if (entry.id === 'characters') {
    window.QFShell.router.show('characters');
    return;
  }
  const tool = TOOLS.find((t) => t.id === entry.id);
  if (tool) openTool(tool);
}

/*
 * No SDE update modal here.
 *
 * This used to subscribe to `sde:update-available` and raise a modal. Nothing
 * ever sent that channel - it was the push half of a design whose pull half is
 * what actually shipped. SDE updates are found in exactly two places, both
 * deliberate:
 *
 *   - at startup, via checkUpdateRequired() in startup-manager.js, which
 *     surfaces on the splash
 *   - on demand, when the user opens Settings and checks
 *
 * The app does NOT poll for SDE updates while running. The data changes about
 * monthly, so a background check would be almost entirely wasted requests
 * against a third party, and a modal interrupting a session to announce it
 * would be worse than finding it in Settings.
 */

/* ============================================================
   Character avatar + menu
   ============================================================ */

const MENU_ITEMS = [
  {
    key: 'skills',
    label: 'Skills Manager',
    open: (id) => window.electronAPI.window.openView('skills', { characterId: id }),
    icon: [
      ['path', { d: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z' }],
      ['path', { d: 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z' }],
    ],
  },
  {
    key: 'blueprints',
    label: 'Blueprint Manager',
    open: (id) => window.electronAPI.window.openView('blueprints', { characterId: id }),
    icon: [
      ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }],
      ['polyline', { points: '14 2 14 8 20 8' }],
    ],
  },
  {
    key: 'assets',
    label: 'Assets Manager',
    open: (id) => window.electronAPI.window.openView('assets', { characterId: id }),
    icon: [
      ['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }],
      ['polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }],
    ],
  },
];

/** Close any open character menu. */
function closeAllCharacterMenus() {
  document.querySelectorAll('.character-menu').forEach((m) => {
    m.style.display = 'none';
  });
  document.querySelectorAll('.character-avatar-icon').forEach((b) => {
    b.setAttribute('aria-expanded', 'false');
  });
  document.querySelectorAll('.character-avatar-item.is-open').forEach((i) => {
    i.classList.remove('is-open');
  });
}

/**
 * Render one avatar per connected character in the title bar.
 *
 * The default character comes first with a gold ring; the rest overlap it
 * slightly (per the mockup). Every avatar is clickable and opens its own menu,
 * so any character's Skills/Blueprints/Assets are one click away - previously
 * only the default character was reachable here.
 */
async function loadCharacterAvatars() {
  const container = document.getElementById('character-avatar-container');
  const stack = document.getElementById('character-avatar-stack');
  if (!container || !stack) return;

  try {
    const [characters, defaultCharacter] = await Promise.all([
      window.electronAPI.esi.getCharacters(),
      window.electronAPI.esi.getDefaultCharacter(),
    ]);

    const defaultId = defaultCharacter ? defaultCharacter.characterId : null;
    currentDefaultCharacterId = defaultId;

    if (!Array.isArray(characters) || characters.length === 0) {
      container.style.display = 'none';
      stack.textContent = '';
      return;
    }

    // Default first, then the rest by name, so the gold ring always leads.
    const ordered = characters.slice().sort((a, b) => {
      if (a.characterId === defaultId) return -1;
      if (b.characterId === defaultId) return 1;
      return String(a.characterName).localeCompare(String(b.characterName));
    });

    stack.textContent = '';
    ordered.forEach((character, index) => {
      const item = buildAvatar(character, character.characterId === defaultId, index);
      // Descending z-index so the default (index 0) paints on top and each
      // avatar to its right tucks further behind.
      item.style.setProperty('--qf-stack-order', String(ordered.length - index));
      stack.appendChild(item);
    });

    container.style.display = 'flex';
    QFUI.attachPortraitFallbacks(stack);
  } catch (error) {
    console.error('Error loading character avatars:', error);
  }
}

/** Build one avatar button plus its dropdown menu. */
function buildAvatar(character, isDefault, index) {
  const wrap = document.createElement('div');
  wrap.className = 'character-avatar-item';
  if (index > 0) wrap.classList.add('is-stacked');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'character-avatar-icon' + (isDefault ? ' is-default' : '');
  btn.id = `character-avatar-btn-${character.characterId}`;
  btn.title = isDefault ? `${character.characterName} (default)` : character.characterName;
  btn.setAttribute('aria-label', `${character.characterName} menu`);
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');

  const img = document.createElement('img');
  img.src = `${character.portrait}?size=64`;
  img.alt = '';
  img.setAttribute('data-fallback', 'portrait');
  btn.appendChild(img);
  wrap.appendChild(btn);

  const menu = document.createElement('div');
  menu.className = 'character-menu';
  menu.id = `character-menu-${character.characterId}`;
  menu.style.display = 'none';

  const header = document.createElement('div');
  header.className = 'character-menu-header';
  header.textContent = character.characterName;
  if (isDefault) {
    const badge = document.createElement('span');
    badge.className = 'character-menu-default';
    badge.textContent = 'Default';
    header.appendChild(badge);
  }
  menu.appendChild(header);

  MENU_ITEMS.forEach((item) => {
    const mi = document.createElement('button');
    mi.type = 'button';
    mi.className = 'character-menu-item';
    mi.appendChild(toolIcon(item.icon, 16));
    const label = document.createElement('span');
    label.textContent = item.label;
    mi.appendChild(label);
    mi.addEventListener('click', () => {
      item.open(character.characterId);
      closeAllCharacterMenus();
    });
    menu.appendChild(mi);
  });

  // Non-default characters get a quick way to become the default.
  if (!isDefault) {
    const setDefault = document.createElement('button');
    setDefault.type = 'button';
    setDefault.className = 'character-menu-item character-menu-item-accent';
    setDefault.appendChild(toolIcon([['polygon', { points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2' }]], 16));
    const sdLabel = document.createElement('span');
    sdLabel.textContent = 'Set as Default';
    setDefault.appendChild(sdLabel);
    setDefault.addEventListener('click', async () => {
      closeAllCharacterMenus();
      try {
        await window.electronAPI.esi.setDefaultCharacter(character.characterId);
        // The main process broadcasts default-character-changed, which
        // re-renders the stack; no manual refresh needed here.
      } catch (error) {
        console.error('Failed to set default character:', error);
      }
    });
    menu.appendChild(setDefault);
  }

  wrap.appendChild(menu);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.style.display === 'block';
    closeAllCharacterMenus();
    if (!isOpen) {
      menu.style.display = 'block';
      btn.setAttribute('aria-expanded', 'true');
      // Lift this avatar above the stack so its menu is not clipped by a
      // higher-stacked neighbour to the left.
      wrap.classList.add('is-open');
    }
  });

  return wrap;
}


// One document-level listener closes any open character menu.
characterMenuClickOutsideListener = (e) => {
  if (!e.target.closest || !e.target.closest('.character-avatar-item')) {
    closeAllCharacterMenus();
  }
};
document.addEventListener('click', characterMenuClickOutsideListener);

window.addEventListener('beforeunload', () => {
  if (characterMenuClickOutsideListener) {
    document.removeEventListener('click', characterMenuClickOutsideListener);
  }
});

/* ============================================================
   Init
   ============================================================ */

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Query params let this one document serve two window shapes:
    //   (no params)                    the main window - rail + dashboard
    //   ?role=standalone&view=assets…  a tool in its own window - no rail
    // Tools that open in their own window (Asset Manager) load index.html with
    // the params set, so they get the identical shell and view code.
    const bootParams = new URLSearchParams(window.location.search);
    const bootView = bootParams.get('view');
    const bootRole = bootParams.get('role') || 'main';

    // Mount params arrive as a JSON blob so a view can take arbitrary input
    // (character id, blueprint id) without a param per tool.
    let bootViewParams = {};
    const rawParams = bootParams.get('params');
    if (rawParams) {
      try {
        bootViewParams = JSON.parse(rawParams);
      } catch (error) {
        console.error('[renderer] Could not parse view params:', error);
      }
    }

    // 1. Build the shell (title bar + rail + footer) and register views.
    window.QFShell.init({
      role: bootRole,
      title: bootView ? '' : 'Dashboard',
      onRailSelect,
    });
    registerViews();

    // 2. Dock the character avatar into the title bar's trailing slot, so it
    //    participates in the bar's flex flow rather than overlapping it.
    const trailing = document.getElementById('titlebar-trailing');
    const avatar = document.getElementById('character-avatar-container');
    if (trailing && avatar) trailing.appendChild(avatar);

    // 3. Mount the boot view. A standalone tool window opens straight into its
    //    tool; the main window renders the dashboard.
    if (bootView) {
      // The dashboard markup lives statically in index.html and is only MOVED
      // into the view host when the dashboard view mounts. In a standalone
      // window it never mounts, so without this it stays parked on <body> and
      // renders above the tool. Detach it - this window will never show it.
      const dashboardEl = document.getElementById('dashboard-view');
      if (dashboardEl && dashboardEl.parentNode) dashboardEl.remove();

      window.QFShell.router.show(bootView, bootViewParams);
    } else {
      renderToolCards();
      window.QFShell.router.show('dashboard');
    }

    // 4. Settings.
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', () => window.QFShell.router.show('settings'));

    // Main process relaying an `openSettings()` call from elsewhere - a framed
    // tool, or a separate window such as the Audit Log. Mount it here rather
    // than spawning a Settings window.
    if (window.electronAPI.window.onShowView) {
      window.electronAPI.window.onShowView((payload) => {
        if (!payload || !payload.view) return;
        // `params` carries mount arguments (e.g. the blueprint to open in the
        // calculator). Forwarding them is what lets a view receive its input
        // during mount instead of racing a follow-up event.
        window.QFShell.router.show(payload.view, payload.params);
      });
    }

    // 5a. "Refresh Industry Data": runs the main-process ESI cycle, which
    //     covers industry jobs, wallet transactions and wallet journal for
    //     every character and corporation. It does NOT touch market data -
    //     that has its own button on the Market Data Age tile.
    const refreshBtn = document.getElementById('dash-refresh-all');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        QFUI.setButtonLabel(refreshBtn, 'Refreshing…');
        try {
          await window.electronAPI.esi.refreshGlobalNow();
        } catch (error) {
          console.error('Industry refresh failed:', error);
        } finally {
          await refreshDashboard();
          QFUI.setButtonLabel(refreshBtn, 'Refresh Industry Data');
          refreshBtn.disabled = false;
        }
      });
    }

    // 5b. Market tile's own Refresh, with in-tile progress.
    const marketRefreshBtn = document.getElementById('tile-market-refresh');
    if (marketRefreshBtn) {
      marketRefreshBtn.addEventListener('click', refreshMarketData);
    }

    // 6. Character avatar + greeting.
    await loadCharacterAvatars();
    await loadGreeting();

    window.electronAPI.esi.onDefaultCharacterChanged(() => {
      loadCharacterAvatars();
      loadGreeting();
      refreshDashboard();
      window.footerUtils.updateCharacterCount();
    });

    // 7. Status footer live data.
    await window.footerUtils.initializeFooter();
  } catch (error) {
    console.error('Fatal initialization error:', error);
    document.body.innerHTML = `
      <div style="color: #ff4444; padding: 40px; font-family: system-ui; text-align: center;">
        <h2>Failed to Initialize</h2>
        <p>${error.message}</p>
        <p style="font-size: 0.9em; color: #999; margin-top: 20px;">Check the console for more details</p>
      </div>
    `;
  }
});
