/**
 * Manufacturing Plans - shell view (SLICE 1).
 *
 * Ported from "Manufacturing Plans (1a).dc.html". Replaces the separate
 * manufacturing-plans window: this mounts inside the main window like Market
 * and the Blueprint Calculator, and gains pop-out later (overhaul Phase 4.2).
 *
 * Slice 1 covers the sidebar, plan header, tab strip, Overview and Materials.
 * The remaining panels exist in the template as placeholders so tab switching
 * is real; later slices fill them in.
 *
 * ALL calculation stays in main - this gathers inputs, calls the same IPC as
 * the legacy renderer, and renders. Any change in the numbers is a bug.
 *
 * THE RULE THIS SCREEN EXISTS TO RESPECT (binding rule 7): a plan's prices are
 * LOCKED. `price_each` frozen at `price_frozen_at` is the cost basis, and
 * nothing here may change it. The Live column and every drift indicator are
 * read-only comparisons; only an explicit "Re-lock Prices" adopts live prices.
 */
(function () {
  'use strict';

  const TOOL_KEY_PLANS = 'manufacturingPlansMarketSetId';
  /** A material must move more than this to count toward the drift banner. */
  const DRIFT_THRESHOLD_PCT = 5;

  /* ------------------------------------------------------------------ state */

  const state = {
    characterId: null,
    characters: [],
    plans: [],
    planId: null,
    plan: null,
    tab: 'overview',
    statusFilter: 'all',
    search: '',
    marketSet: null,
    summary: null,
    materials: [],
    /** typeId -> { livePrice, lockedPrice, driftPercent, driftAbsolute } */
    drift: {},
    volumes: {},
    names: {},
    categories: {},
    showOwned: false,
    /** Category name -> collapsed?; survives re-renders within a session. */
    collapsedGroups: {},

    /* ---- build list (slice 2) ---- */
    buildItems: [],
    facilities: [],
    /** true when every row is editable at once. */
    bulkEdit: false,
    /**
     * Pending edits, keyed by blueprintTypeId. Held in memory until Save so
     * Cancel is a genuine discard - nothing is written per keystroke.
     */
    buildEdits: {},
    /** blueprintTypeId currently in single-row edit, or null. */
    editingRow: null,
    blueprints: [],
    reactions: [],
    tree: null,

    /* ---- tracking tabs (slice 3) ---- */
    products: [],
    pendingJobs: [],
    linkedJobs: [],
    pendingTransactions: [],
    linkedTransactions: [],
    analytics: null,

    /* ---- ledger & settings (slice 4) ---- */
    ledger: null,
    planSettings: null,
    overrides: [],

    /* ---- modal selections (slice 5) ---- */
    acquireTypeId: null,
    blueprintTypeId: null,
    /** The intermediate whose built runs the Mark Built modal is editing. */
    builtBlueprint: null,

    /** planBlueprintId -> { materials, tree, product } from calculateReactionTree. */
    reactionTrees: {},

    /** Blueprint Tree: node key -> true when collapsed. Expanded is default. */
    treeCollapsed: {},
    /** Node key whose detail panel is open, or null. One at a time. */
    treeDetailOpen: null,
    /** Node key -> detail payload. `undefined` means "not fetched yet". */
    treeDetails: {},

    /** facilityId -> resolved name. Main owns the real cache. */
    facilityNames: {},
    /** characterId -> { divisionId: name }, from divisions.getSettings. */
    divisionNames: {},
  };

  /**
   * Build-plan options OFFERED, matching the legacy dropdown exactly.
   *
   * `build_buy` is deliberately ABSENT: the backend accepts it and the app can
   * display it, but it is unimplemented ("AI-optimized building vs buying -
   * coming in a future update") and has never been selectable. Offering it here
   * would let a user pick a mode that does nothing.
   *
   * It is still rendered read-only via BUILD_PLAN_LABELS when stored data
   * already holds it, so such a row shows its real value rather than a blank.
   */
  const BUILD_PLAN_OPTIONS = [
    { value: 'raw_materials', label: 'Raw Materials' },
    { value: 'components', label: 'Buy Components' },
    { value: 'buy', label: 'Buy Intermediate' },
  ];

  /** Display labels, including values that are not selectable. */
  const BUILD_PLAN_LABELS = {
    raw_materials: 'Raw Materials',
    components: 'Buy Components',
    buy: 'Buy Intermediate',
    build_buy: 'Build/Buy',
  };

  let searchSelects = [];
  let templateCache = null;

  /* --------------------------------------------------------------- helpers */

  /**
   * Mount a QFSearchSelect into a host, replacing whatever was there.
   *
   * These hosts are re-initialised (changing the default character re-runs
   * initCharacters), and a bare `new QFSearchSelect(host, ...)` APPENDS - so
   * the user saw two dropdowns, and the old instance kept its document
   * listener and its body-mounted popover alive.
   */
  function mountSearchSelect(host, opts) {
    if (!host || !window.QFSearchSelect) return null;

    // Drop any previous instance owning this host before its markup goes.
    searchSelects = searchSelects.filter((entry) => {
      if (entry.host !== host) return true;
      try {
        entry.sel.destroy();
      } catch (error) {
        console.error('[plans] search select destroy failed:', error);
      }
      return false;
    });
    host.textContent = '';

    const sel = new window.QFSearchSelect(host, opts);
    searchSelects.push({ host, sel });
    return sel;
  }

  function destroySearchSelects() {
    searchSelects.forEach(({ sel }) => {
      try {
        sel.destroy();
      } catch (error) {
        console.error('[plans] search select destroy failed:', error);
      }
    });
    searchSelects = [];
  }

  function $(id) {
    return document.getElementById(id);
  }

  function toast(message, type, options) {
    if (window.QFToast) window.QFToast.show(message, type, options);
    else console[type === 'error' ? 'error' : 'log']('[plans]', message);
  }

  function formatISK(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatNumber(value, decimals = 0) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  /** Job durations, which run from seconds to weeks. */
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    return parts.join(' ');
  }

  /** "3 days ago" style, for lock timestamps. */
  function formatAgo(timestamp) {
    if (!timestamp) return null;
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function formatDate(timestamp) {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleDateString();
  }

  /** Date + time, for job and transaction timestamps. */
  function formatDateTime(timestamp) {
    if (!timestamp) return '—';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /**
   * Text cell that reveals its full value on hover when truncated.
   *
   * Columns here ellipsise aggressively; without a title the full value is
   * simply unreachable.
   */
  function truncatedCell(cls, text) {
    const node = el('span', cls, text);
    if (text !== undefined && text !== null && String(text) !== '') {
      node.title = String(text);
    }
    return node;
  }

  /* -------------------------------------------------- plan data accessors
     Field names verified against docs/plan-ipc-shapes.md. The backend returns
     `quantity`/`basePrice`, never `quantityNeeded`/`priceEach`, and a
     plan-scoped override arrives SEPARATELY - reading only basePrice would
     silently show the un-overridden price. */

  /** Price this plan is locked to, honouring a plan-scoped override. */
  function effectivePrice(row) {
    if (!row) return null;
    return row.planOverridePrice !== null && row.planOverridePrice !== undefined
      ? row.planOverridePrice
      : row.basePrice;
  }

  /**
   * How much of a material is still to be obtained.
   *
   * Acquisition arrives from THREE independent sources - manual entry,
   * confirmed purchases, and confirmed manufacturing. Counting only one
   * over-reports what is left to buy.
   */
  function stillNeeded(material) {
    const acquired = (material.manuallyAcquiredQuantity || 0)
      + (material.purchasedQuantity || 0)
      + (material.manufacturedQuantity || 0);
    return Math.max(0, (material.quantity || 0) - acquired);
  }

  /**
   * Type icon.
   *
   * EVE serves BLUEPRINTS from a different variant: `/icon` 404s for a
   * blueprint typeID, which renders as a broken image. Blueprints (and
   * reactions, which are blueprints) must use `/bp`.
   */
  function typeIcon(typeId, cls, variant) {
    const img = document.createElement('img');
    img.className = cls || 'mp-mat-icon';
    img.src = `https://images.evetech.net/types/${typeId}/${variant || 'icon'}?size=64`;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    return img;
  }

  /** Icon for a blueprint or reaction typeID. */
  function blueprintIcon(typeId, cls) {
    return typeIcon(typeId, cls, 'bp');
  }

  /**
   * Run a render step in isolation.
   *
   * One panel throwing must not abort the panels after it - that is exactly how
   * the Market override counters silently read 0.
   */
  function renderSafely(label, fn) {
    try {
      fn();
    } catch (error) {
      console.error(`[plans] render failed: ${label}`, error);
    }
  }

  async function loadSafely(label, fn) {
    try {
      return await fn();
    } catch (error) {
      console.error(`[plans] load failed: ${label}`, error);
      return null;
    }
  }

  /**
   * Resolve and cache type names.
   *
   * NO plan IPC on this surface returns type names - every list hands back
   * type IDs only (getBuildItems is the lone exception). Anything rendering
   * "Type ######" is a missing call to this, not a backend gap.
   *
   * Cached across tabs so switching does not re-query the SDE for names the
   * view already has.
   */
  async function ensureNames(typeIds) {
    const missing = [...new Set(typeIds)]
      .filter((id) => id !== null && id !== undefined && !state.names[id]);
    if (missing.length === 0) return;

    const names = await loadSafely('type names', () =>
      window.electronAPI.sde.getTypeNames(missing)
    );
    Object.assign(state.names, names || {});
  }

  function typeName(typeId) {
    return state.names[typeId] || `Type ${typeId}`;
  }

  /**
   * Resolve facility ids to names.
   *
   * Delegates to the shared location resolver, which handles NPC stations from
   * the SDE and player structures via ESI, with its own in-memory cache. This
   * view keeps a local map purely so rendering stays synchronous.
   *
   * Player structures need the character (and corp flag) that can SEE them -
   * a structure is only nameable through a character with docking access, so
   * the ids come from the job rather than being looked up globally.
   */
  async function ensureFacilityNames(jobs) {
    const seen = new Set();
    await Promise.all((jobs || []).map(async (job) => {
      if (!job || !job.facilityId) return;
      if (seen.has(job.facilityId) || state.facilityNames[job.facilityId]) return;
      seen.add(job.facilityId);

      try {
        const info = await window.electronAPI.location.resolve(
          job.facilityId,
          job.characterId,
          !!job.isCorporation
        );
        const resolved = info && (info.fullPath || info.stationName);
        // 'Unknown'/'Error' are the resolver's own failure strings - storing
        // them would be worse than falling back to the id.
        if (resolved && resolved !== 'Unknown' && resolved !== 'Error') {
          state.facilityNames[job.facilityId] = resolved;
        }
      } catch (error) {
        // Leave unresolved; the row falls back to the raw id.
        console.warn(`[plans] could not resolve facility ${job.facilityId}:`, error.message);
      }
    }));
  }

  function facilityLabel(job) {
    if (!job || !job.facilityId) return '—';
    return state.facilityNames[job.facilityId] || `Facility ${job.facilityId}`;
  }

  /* -------------------------------------------------------------- template */

  async function loadTemplate() {
    const inline = $('manufacturing-plans-view-template');
    if (inline) return inline.content.cloneNode(true);

    if (!templateCache) {
      try {
        const html = await fetch('manufacturing-plans.view.html').then((r) => r.text());
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const tpl = parsed.getElementById('manufacturing-plans-view-template');
        if (!tpl) {
          console.error('[plans] template not found');
          return null;
        }
        templateCache = tpl.content;
      } catch (error) {
        console.error('[plans] failed to load template:', error);
        return null;
      }
    }
    return document.importNode(templateCache, true);
  }

  /* ------------------------------------------------------------ characters */

  async function initCharacters() {
    const characters = (await loadSafely('characters', () =>
      window.electronAPI.esi.getCharacters()
    )) || [];
    state.characters = characters;

    const defaultCharacter = await loadSafely('default character', () =>
      window.electronAPI.esi.getDefaultCharacter()
    );
    state.characterId =
      (defaultCharacter && defaultCharacter.characterId) ||
      (characters[0] && characters[0].characterId) ||
      null;

    renderCharacterPortrait();

    mountSearchSelect($('mp-character-host'), {
      options: characters.map((c) => ({
        value: String(c.characterId),
        // characterName, not name - the shape settings-manager returns.
        label: c.characterName,
      })),
      value: state.characterId ? String(state.characterId) : null,
      placeholder: 'Select character…',
      onChange: async (e) => {
        state.characterId = parseInt(e.target.value, 10);
        // Clearing the id alone left every tab holding the old character's
        // materials, jobs and ledger behind an empty detail pane.
        clearPlanSelection();
        renderCharacterPortrait();
        await loadPlans();
      },
    });
  }

  function renderCharacterPortrait() {
    const host = $('mp-character-portrait');
    if (!host) return;
    host.textContent = '';

    const character = state.characters.find(
      (c) => String(c.characterId) === String(state.characterId)
    );
    if (!character || !character.portrait) return;

    const img = document.createElement('img');
    img.src = `${character.portrait}?size=64`;
    img.alt = '';
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    host.appendChild(img);
  }

  /* ----------------------------------------------------------- market set */

  async function initMarketSet() {
    const sets = (await loadSafely('market sets', () =>
      window.electronAPI.market.getMarketSets()
    )) || [];

    const result = await loadSafely('tool market set', () =>
      window.electronAPI.market.getMarketSetForTool(TOOL_KEY_PLANS)
    );
    state.marketSet = result ? result.marketSet : null;

    // A plain select: this is a short list of the user's own market sets,
    // and searching a handful of names is friction rather than help.
    const host = $('mp-market-host');
    if (host) host.textContent = '';
    mountRowSelect(host, {
      // Market set ids are opaque STRINGS - never coerce to Number.
      options: sets.map((s) => ({
        value: String(s.id),
        label: s.name + (s.isDefault ? ' (Default)' : ''),
      })),
      value: state.marketSet ? String(state.marketSet.id) : null,
      placeholder: 'Market set…',
      onChange: async (e) => {
        await loadSafely('set tool market set', async () => {
          await window.electronAPI.market.setMarketSetForTool(TOOL_KEY_PLANS, e.target.value);
          const next = await window.electronAPI.market.getMarketSetForTool(TOOL_KEY_PLANS);
          state.marketSet = next.marketSet;
        });
        // Changing the comparison market re-reads LIVE prices only. The plan's
        // locked cost basis is untouched.
        await loadDrift();
        renderSafely('materials', renderMaterials);
        renderSafely('overview', renderOverview);
      },
    });
  }

  /* ---------------------------------------------------------------- plans */

  async function loadPlans() {
    if (!state.characterId) {
      state.plans = [];
      renderPlansList();
      return;
    }

    const plans = (await loadSafely('plans', () =>
      window.electronAPI.plans.getAll(state.characterId, {})
    )) || [];
    state.plans = plans;
    renderPlansList();
  }

  function visiblePlans() {
    const search = state.search.trim().toLowerCase();
    return state.plans.filter((plan) => {
      if (state.statusFilter !== 'all' && plan.status !== state.statusFilter) return false;
      if (search && !String(plan.planName).toLowerCase().includes(search)) return false;
      return true;
    });
  }

  function renderPlansList() {
    const host = $('plans-list');
    if (!host) return;
    host.textContent = '';

    const plans = visiblePlans();
    if (plans.length === 0) {
      host.appendChild(el('div', 'mp-pending', state.plans.length === 0
        ? 'No plans yet.'
        : 'No plans match this filter.'));
      return;
    }

    plans.forEach((plan) => {
      const card = el('button', 'mp-plan-card');
      card.type = 'button';
      card.setAttribute('data-plan-id', plan.planId);
      card.classList.toggle('is-selected', String(plan.planId) === String(state.planId));

      const top = el('div', 'mp-plan-card-top');
      top.appendChild(el('span', 'mp-plan-card-name', plan.planName));
      card.appendChild(top);

      const mid = el('div', 'mp-plan-card-mid');
      const badge = el('span', 'mp-status-badge', plan.status);
      badge.setAttribute('data-status', plan.status);
      mid.appendChild(badge);
      if (plan.productName) {
        mid.appendChild(el('span', 'mp-plan-card-product', plan.productName));
      }
      card.appendChild(mid);

      card.addEventListener('click', () => selectPlan(plan.planId));
      host.appendChild(card);
    });
  }

  async function selectPlan(planId) {
    state.planId = planId;
    state.plan = state.plans.find((p) => String(p.planId) === String(planId)) || null;

    if (!state.plan) {
      // The list does not have it. Ask for the plan directly rather than
      // showing an empty detail pane - this happens with a just-created plan
      // whose list refresh has not landed, and when a plan is opened by id
      // from outside the view.
      const fetched = await loadSafely('plan', () => window.electronAPI.plans.get(planId));
      if (fetched) {
        state.plan = fetched;
      } else {
        // Genuinely gone (deleted elsewhere). Fall back to no selection
        // rather than a half-rendered detail pane.
        console.warn(`[plans] plan ${planId} not found; clearing selection`);
        state.planId = null;
        renderPlansList();
        renderPlanDetail();
        return;
      }
    }

    resetPlanState();

    renderPlansList();
    renderPlanDetail();

    await loadPlanData();
    showTab('overview');
  }

  /**
   * Drop everything belonging to the previously selected plan.
   *
   * Per-plan state must not leak across a switch - unsaved edits especially,
   * since they are keyed by blueprintTypeId and would silently apply to the
   * wrong plan on save.
   */
  function resetPlanState() {
    state.tab = 'overview';
    state.drift = {};
    state.summary = null;
    state.materials = [];
    state.buildItems = [];
    state.buildEdits = {};
    state.editingRow = null;
    state.bulkEdit = false;
    state.blueprints = [];
    state.reactions = [];
    state.reactionTrees = {};
    state.tree = null;
    // Tree expansion and fetched details are keyed by node - another plan's
    // nodes are different nodes.
    state.treeCollapsed = {};
    state.treeDetailOpen = null;
    state.treeDetails = {};
    state.products = [];
    state.pendingJobs = [];
    state.linkedJobs = [];
    state.pendingTransactions = [];
    state.linkedTransactions = [];
    state.analytics = null;
    state.ledger = null;
    state.planSettings = null;
    state.overrides = [];
    state.acquireTypeId = null;
    state.blueprintTypeId = null;
    state.builtBlueprint = null;
    // A modal left open across a plan switch would submit against the NEW
    // plan while showing the old one's data.
    closeAllModals();
    setBulkChrome();
  }

  /**
   * Clear the open plan entirely.
   *
   * Switching character changes which plans EXIST, so the open one may not
   * belong to the new character at all - leaving it on screen would show one
   * character's plan while the rest of the view describes another.
   */
  function clearPlanSelection() {
    state.planId = null;
    state.plan = null;
    resetPlanState();

    // renderPlanDetail only HIDES the pane, so without this the old plan's
    // rows sit underneath and reappear intact the moment another plan is
    // opened on a tab whose loader has not run yet.
    [
      'mp-materials-body', 'build-list-container', 'blueprints-container',
      'reactions-container', 'blueprint-tree-container', 'products-container',
      'jobs-container', 'transactions-container', 'mp-analytics',
      'ledger-container',
    ].forEach((id) => {
      const host = $(id);
      if (host) host.textContent = '';
    });

    renderPlansList();
    renderPlanDetail();
  }

  function renderPlanDetail() {
    const empty = $('no-plan-selected');
    const detail = $('plan-detail');
    const hasPlan = !!state.plan;

    if (empty) empty.hidden = hasPlan;
    if (detail) detail.hidden = !hasPlan;
    if (!hasPlan) return;

    $('plan-name').textContent = state.plan.planName;

    const status = $('plan-status');
    status.textContent = state.plan.status;
    status.setAttribute('data-status', state.plan.status);

    $('plan-created').textContent = `Created ${formatDate(state.plan.createdAt)}`;

    // Keeps Mark Complete / Reopen in step with the status just rendered above.
    setPlanActionChrome();
  }

  /**
   * Mark Complete / Reopen.
   *
   * Status drives the plan-list filters, so a plan stuck on "active" forever is
   * why the Completed filter looked broken. updateManufacturingPlan takes
   * CAMELCASE keys (`status`, `completedAt`) and maps them to snake_case
   * columns itself - sending `completed_at` writes nothing and reports success.
   */
  async function togglePlanComplete() {
    if (!state.plan) return;

    const completing = state.plan.status !== 'completed';
    const updates = completing
      ? { status: 'completed', completedAt: Date.now() }
      // Reopening clears the timestamp; leaving it set would date a plan that
      // is running again.
      : { status: 'active', completedAt: null };

    try {
      const ok = await window.electronAPI.plans.update(state.planId, updates);
      // updateManufacturingPlan returns false when nothing matched (unknown
      // field, missing plan) rather than throwing.
      if (!ok) throw new Error('Plan not updated');

      state.plan = { ...state.plan, ...updates };
      await loadPlans();
      // renderPlanDetail re-syncs the button label via setPlanActionChrome.
      renderPlanDetail();
      toast(completing ? 'Plan marked complete.' : 'Plan reopened.', 'success');
    } catch (error) {
      console.error('[plans] toggle complete failed:', error);
      toast(`Failed to update plan: ${error.message}`, 'error');
    }
  }

  /**
   * Delete the open plan.
   *
   * Irreversible and takes every blueprint/material/match with it, so it
   * confirms first. window.confirm is what the rest of this view would use -
   * there is no shared confirm component in the app today.
   */
  async function deleteCurrentPlan() {
    if (!state.plan) return;

    const name = state.plan.planName;
    if (!window.confirm(
      `Delete "${name}"?\n\nThis removes the plan and everything in it - blueprints, `
      + 'materials, and job/transaction matches. This cannot be undone.'
    )) return;

    try {
      const ok = await window.electronAPI.plans.delete(state.planId);
      if (!ok) throw new Error('Plan not deleted');

      // Clear the selection before reloading: the detail pane is bound to a
      // plan that no longer exists.
      state.planId = null;
      state.plan = null;
      await loadPlans();
      renderPlanDetail();
      toast(`Deleted "${name}".`, 'success');
    } catch (error) {
      console.error('[plans] delete plan failed:', error);
      toast(`Failed to delete plan: ${error.message}`, 'error');
    }
  }

  /* ---- rename ---- */

  function openRenamePlan() {
    if (!state.plan) return;
    $('mp-rename-name').value = state.plan.planName || '';
    $('mp-rename-description').value = state.plan.description || '';
    openModal('mp-rename-modal');
  }

  /**
   * Save the plan's name/description.
   *
   * updateManufacturingPlan takes CAMELCASE keys (`planName`, `description`) -
   * `plan_name` is silently dropped and the call still reports success.
   */
  async function confirmRenamePlan() {
    if (!state.plan) return;

    const planName = $('mp-rename-name').value.trim();
    const description = $('mp-rename-description').value.trim() || null;

    // The backend auto-names only on CREATE; an empty name here would blank it.
    if (!planName) {
      toast('Plan name cannot be empty.', 'warning');
      return;
    }

    try {
      const ok = await window.electronAPI.plans.update(state.planId, { planName, description });
      if (!ok) throw new Error('Plan not updated');

      state.plan = { ...state.plan, planName, description };
      closeModal('mp-rename-modal');
      await loadPlans();
      renderPlanDetail();
      // The Overview tab prints the description, so it can be stale otherwise.
      if (state.tab === 'overview') renderOverview();
      toast('Plan renamed.', 'success');
    } catch (error) {
      console.error('[plans] rename plan failed:', error);
      toast(`Failed to rename plan: ${error.message}`, 'error');
    }
  }

  /** Mark Complete reads "Reopen" once the plan is completed. */
  function setPlanActionChrome() {
    const label = $('mp-complete-plan-label');
    if (!label) return;
    const completed = !!state.plan && state.plan.status === 'completed';
    label.textContent = completed ? 'Reopen Plan' : 'Mark Complete';
  }

  /* ------------------------------------------------------------ plan data */

  async function loadPlanData() {
    if (!state.planId) return;

    const [summary, materials, facilities] = await Promise.all([
      loadSafely('summary', () => window.electronAPI.plans.getSummary(state.planId)),
      loadSafely('materials', () =>
        window.electronAPI.plans.getMaterials(state.planId, state.showOwned)
      ),
      // Every tab that shows a facility without a frozen snapshot resolves it
      // through this list. Loading it only on the Build List meant the others
      // read "Unknown facility" until that tab happened to be opened.
      loadSafely('facilities', () => window.electronAPI.facilities.getFacilities()),
    ]);

    state.summary = summary;
    state.materials = materials || [];
    state.facilities = facilities || [];

    // Volumes and categories are material-specific; names go through the
    // shared cache so other tabs reuse them.
    const typeIds = state.materials.map((m) => m.typeId);
    if (typeIds.length > 0) {
      const [volumes, categories] = await Promise.all([
        loadSafely('item volumes', () => window.electronAPI.sde.getItemVolumes(typeIds)),
        loadSafely('type categories', () => window.electronAPI.sde.getTypeCategoryInfo(typeIds)),
      ]);
      state.volumes = volumes || {};
      state.categories = categories || {};
      await ensureNames(typeIds);
    }

    // Reactions tab visibility has to be resolved up front - if it only ran
    // when the tab was opened, the tab would never appear to be opened.
    await loadReactionsTab();

    // Pending match counts drive the tab badges, which are the only signal
    // that something is waiting for a decision - so they cannot wait until the
    // tab is opened either.
    await loadPendingCounts();

    // Drift last: it is display-only, so a slow or failing market must not
    // hold up the rest of the plan.
    await loadDrift();

    renderSafely('overview', renderOverview);
    renderSafely('materials', renderMaterials);
  }

  async function loadDrift() {
    if (!state.planId) return;
    const drift = await loadSafely('material drift', () =>
      window.electronAPI.plans.getMaterialDrift(
        state.planId,
        state.marketSet ? state.marketSet.id : null
      )
    );
    state.drift = drift || {};
  }

  /** Materials whose live price has moved more than the threshold. */
  function driftedMaterials() {
    return state.materials.filter((mat) => {
      const entry = state.drift[mat.typeId];
      return entry
        && Number.isFinite(entry.driftPercent)
        && Math.abs(entry.driftPercent) > DRIFT_THRESHOLD_PCT;
    });
  }

  /**
   * What the material total WOULD be at live prices. Never written anywhere.
   *
   * Returns null unless EVERY material could be priced: a partial total
   * silently understates the comparison, and "−40% if re-priced live" is worse
   * than showing nothing when it is really "we could only price half of it".
   */
  function liveMaterialCost() {
    if (state.materials.length === 0) return null;

    let total = 0;
    for (const mat of state.materials) {
      const entry = state.drift[mat.typeId];
      if (!entry || !Number.isFinite(entry.livePrice)) return null;
      total += entry.livePrice * mat.quantity;
    }
    return total;
  }

  /* -------------------------------------------------------------- overview */

  function renderOverview() {
    // Both are required: a planId can be set while the plan itself is absent
    // from the list - it was deleted elsewhere, or the list has not caught up
    // with a just-created plan.
    if (!state.summary || !state.plan) return;
    const s = state.summary;

    const drifted = driftedMaterials();
    const banner = $('mp-drift-banner');
    banner.hidden = drifted.length === 0;
    if (drifted.length > 0) {
      $('mp-drift-banner-head').textContent =
        `${drifted.length} material${drifted.length === 1 ? ' has' : 's have'} drifted more than ` +
        `${DRIFT_THRESHOLD_PCT}% from your locked prices.`;
    }

    $('mp-stat-material-cost').textContent = formatISK(s.materialCost);
    $('mp-stat-material-meta').textContent =
      `${s.materialsWithPrice}/${s.totalMaterials} priced · + ${formatISK(s.jobInstallationCost)} job installation`;

    // "What it would cost live" - a comparison, not a change.
    const live = liveMaterialCost();
    const costDrift = $('mp-stat-cost-drift');
    if (live !== null && Number.isFinite(s.materialCost) && s.materialCost !== 0) {
      const deltaPct = ((live - s.materialCost) / s.materialCost) * 100;
      costDrift.hidden = Math.abs(deltaPct) <= DRIFT_THRESHOLD_PCT;
      costDrift.textContent =
        `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}% if re-priced live`;
      costDrift.classList.toggle('mp-negative', deltaPct > 0);
      costDrift.classList.toggle('mp-positive', deltaPct < 0);
    } else {
      costDrift.hidden = true;
    }

    $('mp-stat-product-value').textContent = formatISK(s.productValue);
    $('mp-stat-product-meta').textContent =
      `${s.productsWithPrice}/${s.totalProducts} priced`;

    const profit = $('mp-stat-profit');
    profit.textContent = formatISK(s.estimatedProfit);
    profit.classList.toggle('mp-positive', s.estimatedProfit >= 0);
    profit.classList.toggle('mp-negative', s.estimatedProfit < 0);
    $('mp-stat-profit-meta').textContent =
      `${Number.isFinite(s.roi) ? s.roi.toFixed(1) : '—'}% ROI · at locked cost`;

    const profitLive = $('mp-stat-profit-live');
    // Needs a COMPLETE live total; a partial one would misstate the profit.
    if (live !== null && Number.isFinite(s.productValue) && drifted.length > 0) {
      const liveProfit = s.productValue - live - (s.jobInstallationCost || 0);
      profitLive.hidden = false;
      profitLive.textContent = `Live-cost profit would be ${formatISK(liveProfit)}`;
      profitLive.classList.toggle('mp-positive', liveProfit >= 0);
      profitLive.classList.toggle('mp-negative', liveProfit < 0);
    } else {
      profitLive.hidden = true;
    }

    $('mp-description').textContent = state.plan.description || 'No description.';

    renderLockedMeta();
  }

  /** The "prices locked N ago" line, shown in the header and on Materials. */
  function renderLockedMeta() {
    const frozenAt = state.materials.reduce((latest, mat) => {
      const at = mat.priceFrozenAt;
      return Number.isFinite(at) && at > latest ? at : latest;
    }, 0);

    const ago = frozenAt ? formatAgo(frozenAt) : null;
    $('mp-locked-ago').textContent = ago ? `Prices locked ${ago}` : 'Prices not locked';
    $('mp-materials-locked-ago').textContent = ago ? `Locked ${ago}` : 'Not locked';
  }

  /* ------------------------------------------------------------- materials */

  /**
   * The materials table's columns, in order.
   *
   * One definition drives the header, the grid template and the totals row,
   * so the two optional Owned columns cannot leave them misaligned.
   */
  /**
   * The materials table's columns, in order.
   *
   * No widths: the browser's table layout sizes each column across every row
   * at once, which is exactly what per-row grids could not do. Only the name
   * column is constrained, by a max-width in CSS so long names ellipsis
   * instead of pushing the figures off screen.
   */
  function materialColumns() {
    const columns = [
      { label: 'Material', cls: 'mp-col-name' },
      { label: 'Needed', align: 'mp-right' },
      { label: 'Still Needed', align: 'mp-right' },
    ];

    if (state.showOwned) {
      columns.push(
        { label: 'Owned (Personal)', align: 'mp-right', owned: true },
        { label: 'Owned (Corp)', align: 'mp-right', owned: true }
      );
    }

    columns.push(
      { label: 'm³', align: 'mp-right' },
      { label: 'Total m³', align: 'mp-right', total: 'mp-total-m3' },
      { label: 'Price (Locked)', align: 'mp-right' },
      { label: 'Live', align: 'mp-right', total: 'mp-total-live' },
      { label: 'Drift', align: 'mp-center', total: 'mp-total-drift' },
      { label: 'Total Cost (Locked)', align: 'mp-right', total: 'mp-total-locked' },
      { label: 'Acquisition', align: 'mp-center' }
    );

    return columns;
  }

  /**
   * An owned-quantity cell, with the per-holder breakdown on hover.
   *
   * The total alone does not say WHERE the stock is, which is what decides
   * whether it can actually be used - so the breakdown is the point of the
   * column, not a decoration.
   */
  function ownedCell(quantity, details, label) {
    const cell = el('td', 'mp-right mp-mono mp-owned-cell', formatNumber(quantity || 0));
    const rows = details || [];
    if (rows.length === 0) return cell;

    cell.classList.add('mp-has-tooltip');
    cell.title = rows
      .map((d) => `${label(d)}: ${formatNumber(d.quantity)}`)
      .join('\n');
    return cell;
  }

  /** Rebuild the header and totals rows against the current column set. */
  function renderMaterialsChrome() {
    const columns = materialColumns();

    const header = $('mp-materials-header');
    if (header) {
      header.textContent = '';
      const row = el('tr', 'mp-materials-row mp-materials-header-row');
      columns.forEach((col) => {
        const th = el('th', [col.align, col.cls].filter(Boolean).join(' ') || null, col.label);
        th.scope = 'col';
        row.appendChild(th);
      });
      header.appendChild(row);
    }

    const totals = $('mp-materials-total');
    if (!totals) return;
    totals.textContent = '';
    const row = el('tr', 'mp-materials-row mp-materials-total-row');
    columns.forEach((col, i) => {
      if (i === 0) {
        row.appendChild(el('td', 'mp-total-label', 'Total material cost'));
        return;
      }
      if (!col.total) {
        row.appendChild(el('td'));
        return;
      }
      // Drift is a container the drift badge is painted into; the rest are
      // plain figures.
      if (col.total === 'mp-total-drift') {
        const cell = el('td', 'mp-center');
        const badge = el('span');
        badge.id = 'mp-total-drift';
        cell.appendChild(badge);
        row.appendChild(cell);
        return;
      }
      const cls = col.total === 'mp-total-locked'
        ? 'mp-right mp-mono mp-total-value'
        : col.total === 'mp-total-live'
          ? 'mp-right mp-mono mp-accent'
          : 'mp-right mp-mono';
      const cell = el('td', cls, '—');
      cell.id = col.total;
      row.appendChild(cell);
    });
    totals.appendChild(row);
  }

  /**
   * The order categories are shown in, roughly how an industrialist sources
   * them. Also the canonical name list.
   */
  const MATERIAL_CATEGORIES = [
    'Minerals',
    'Ice Products',
    'Reaction Materials',
    'Planetary Materials',
    'Gas Cloud Materials',
    'Salvage Materials',
    'Other',
  ];

  /**
   * Classify a material for the shopping list.
   *
   * These are EVE sourcing categories, not raw SDE names: the SDE calls
   * Tritanium's category "Material", which groups minerals, ice, moon goo and
   * salvage into one meaningless bucket. The groupID sets below are what
   * separate them, and are carried over verbatim from the previous UI.
   */
  function categorizeMaterial(info) {
    const { categoryID, groupID } = info || {};

    if (categoryID === 4 && [18, 422].includes(groupID)) return 'Minerals';

    // Heavy Water, Liquid Ozone, Strontium Clathrates and the four isotopes.
    if (categoryID === 4 && groupID === 423) return 'Ice Products';

    // Moon materials and their intermediates, plus every reaction output.
    if ((categoryID === 4 && [427, 428, 429, 967, 974, 4096].includes(groupID))
      || categoryID === 24) {
      return 'Reaction Materials';
    }

    if (categoryID === 42 || categoryID === 43) return 'Planetary Materials';
    if (categoryID === 4 && [754, 866].includes(groupID)) return 'Salvage Materials';
    if (groupID === 711) return 'Gas Cloud Materials';

    return 'Other';
  }

  /** Group materials by sourcing category, in MATERIAL_CATEGORIES order. */
  function groupMaterials() {
    const byCategory = new Map();
    state.materials.forEach((mat) => {
      const name = categorizeMaterial(state.categories[mat.typeId]);
      if (!byCategory.has(name)) byCategory.set(name, []);
      byCategory.get(name).push(mat);
    });

    // Fixed order, and empty categories are dropped rather than shown blank.
    const groups = new Map();
    MATERIAL_CATEGORIES.forEach((name) => {
      const items = byCategory.get(name);
      if (items && items.length > 0) groups.set(name, items);
    });
    return groups;
  }

  /**
   * Inline price-override editor.
   *
   * Three behaviours worth stating, all requested explicitly:
   *   - an UNCHANGED value writes nothing. An override equal to the locked
   *     price would pin it needlessly and survive future re-locks.
   *   - Escape abandons the edit.
   *   - clearing the field REMOVES an existing override rather than writing 0.
   */
  function startPriceOverrideEdit(cell, material) {
    if (cell.querySelector('input')) return; // already editing

    const original = effectivePrice(material);
    const hadOverride = material.planOverridePrice !== null
      && material.planOverridePrice !== undefined;

    const restore = () => {
      cell.textContent = formatISK(original);
      cell.classList.toggle('mp-overridden', hadOverride);
    };

    cell.textContent = '';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'mp-price-input';
    input.step = '0.01';
    input.min = '0';
    input.value = original === null || original === undefined ? '' : original;
    cell.appendChild(input);
    input.focus();
    input.select();

    let settled = false;

    const commit = async () => {
      if (settled) return;
      settled = true;

      const raw = input.value.trim();

      // Empty clears an existing override; on a material with none it is a
      // no-op rather than an error.
      if (raw === '') {
        if (!hadOverride) { restore(); return; }
        try {
          await window.electronAPI.plans.removePriceOverride(state.planId, material.typeId);
          toast('Price override removed.', 'success');
          await loadPlanData();
        } catch (error) {
          console.error('[plans] remove override failed:', error);
          toast(`Failed to remove override: ${error.message}`, 'error');
          restore();
        }
        return;
      }

      const price = parseFloat(raw);
      if (!Number.isFinite(price) || price <= 0) {
        toast('Enter a price greater than zero.', 'warning');
        restore();
        return;
      }

      // Unchanged: nothing to do. Writing an override equal to the locked
      // price would pin it against future re-locks for no reason.
      if (Number.isFinite(original) && Math.abs(price - original) < 0.005) {
        restore();
        return;
      }

      try {
        await window.electronAPI.plans.setPriceOverride(state.planId, material.typeId, price);
        toast('Price override saved.', 'success');
        await loadPlanData();
      } catch (error) {
        console.error('[plans] set override failed:', error);
        toast(`Failed to save override: ${error.message}`, 'error');
        restore();
      }
    };

    const abandon = () => {
      if (settled) return;
      settled = true;
      restore();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        abandon();
      }
    });
    input.addEventListener('blur', () => commit());
  }

  /**
   * Re-lock every material in the plan to the current market price.
   *
   * This is the ONE sanctioned way a plan adopts live prices - everything else
   * (market refresh, recalculation, rebuild) deliberately leaves locked prices
   * alone. So it confirms first: it rewrites the cost basis of the whole plan.
   *
   * The backend is per-material (`relockPlanMaterial`), so this iterates. Only
   * materials with a readable live price are touched; one that failed to price
   * is SKIPPED rather than locked at 0, which would silently zero its cost.
   *
   * A material carrying a price override keeps that override as its price - the
   * re-lock only updates the market snapshot behind it. That is reported
   * separately so the numbers not moving does not read as a failure.
   */
  async function relockAllPrices() {
    if (!state.planId) return;

    const materials = Array.isArray(state.materials) ? state.materials : [];

    /*
     * Prices are read FRESH here rather than from state.drift.
     *
     * state.drift is populated by the Materials tab, so depending on it meant
     * re-locking could report "no live prices" purely because a tab had not been
     * opened yet - a state this button must never be in.
     *
     * getMaterialDrift prices from the LOCAL market cache
     * (calculateRealisticPrice -> getCachedMarketOrders). It does not refresh
     * the order book: market-order data updates only via the Market Manager and
     * Dashboard refresh buttons, never as a side effect of a calculation.
     */
    await loadDrift();
    const drift = state.drift || {};

    const relockable = materials
      .map((mat) => ({ mat, live: drift[mat.typeId]?.livePrice }))
      .filter(({ live }) => Number.isFinite(live) && live > 0);

    if (relockable.length === 0) {
      toast(
        'No cached market prices for this plan\'s materials. Refresh market data '
        + 'in Market Manager first.',
        'warning'
      );
      return;
    }

    const skipped = materials.length - relockable.length;
    if (!window.confirm(
      `Re-lock ${relockable.length} material price${relockable.length === 1 ? '' : 's'} to the `
      + 'current market?\n\nThis replaces the frozen prices this plan\'s costs are based on '
      + 'and cannot be undone.'
      + (skipped > 0 ? `\n\n${skipped} material(s) have no live price and will be skipped.` : '')
    )) return;

    const btn = $('mp-relock');
    const label = $('mp-relock-label');
    const original = label ? label.textContent : null;
    if (btn) {
      btn.disabled = true;
      if (label) label.textContent = 'Re-locking…';
    }

    let locked = 0;
    let overridden = 0;
    let failed = 0;

    try {
      // Sequential: these all write the same plan, and a half-applied batch of
      // price locks is worse than a slow one.
      for (const { mat, live } of relockable) {
        try {
          const res = await window.electronAPI.market.relockPlanMaterial(
            state.planId, mat.typeId, live
          );
          if (res && res.success) {
            locked += 1;
            if (res.overridden) overridden += 1;
          } else {
            failed += 1;
          }
        } catch (error) {
          console.error(`[plans] re-lock failed for type ${mat.typeId}:`, error);
          failed += 1;
        }
      }

      await loadPlanData();

      if (locked > 0) {
        const notes = [];
        if (overridden > 0) notes.push(`${overridden} kept a manual override`);
        if (skipped > 0) notes.push(`${skipped} had no live price`);
        if (failed > 0) notes.push(`${failed} failed`);
        toast(
          `Re-locked ${locked} price${locked === 1 ? '' : 's'}`
          + (notes.length ? ` — ${notes.join(', ')}.` : '.'),
          failed > 0 ? 'warning' : 'success'
        );
      } else {
        toast('Could not re-lock any prices.', 'error');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        if (label && original !== null) label.textContent = original;
      }
    }
  }

  function driftCell(entry) {
    const span = el('span', 'mp-drift');
    if (!entry || !Number.isFinite(entry.driftPercent)) {
      // No locked basis, or the market could not be read. "—" is honest;
      // rendering 0% would claim the price has not moved.
      span.textContent = '—';
      span.classList.add('is-flat');
      return span;
    }

    const pct = entry.driftPercent;
    span.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    // Up is bad for a material you still have to buy; down is good.
    span.classList.toggle('is-up', pct > 0.05);
    span.classList.toggle('is-down', pct < -0.05);
    span.classList.toggle('is-flat', Math.abs(pct) <= 0.05);
    if (Number.isFinite(entry.driftAbsolute)) {
      span.title = `${entry.driftAbsolute >= 0 ? '+' : ''}${formatISK(entry.driftAbsolute)} ISK per unit`;
    }
    return span;
  }

  function renderMaterials() {
    const host = $('mp-materials-body');
    if (!host) return;
    host.textContent = '';

    // First: the header and totals must agree with the rows about how many
    // columns there are before either is populated.
    renderMaterialsChrome();

    const columnCount = materialColumns().length;

    /** A row spanning every column - group headings, empty states. */
    const fullWidthRow = (cls, child) => {
      const tr = el('tr', cls);
      const td = el('td');
      td.colSpan = columnCount;
      td.appendChild(child);
      tr.appendChild(td);
      return tr;
    };

    if (state.materials.length === 0) {
      host.appendChild(fullWidthRow(
        'mp-materials-empty',
        el('div', 'mp-pending', 'No materials in this plan.')
      ));
      $('mp-total-locked').textContent = '—';
      $('mp-total-live').textContent = '—';
      $('mp-total-m3').textContent = '—';
      return;
    }

    let grandVolume = 0;
    let grandLocked = 0;
    let grandLive = 0;
    let livePriced = 0;

    groupMaterials().forEach((items, groupName) => {
      const collapsed = !!state.collapsedGroups[groupName];

      let groupVolume = 0;
      let groupLocked = 0;
      items.forEach((mat) => {
        groupVolume += (state.volumes[mat.typeId] || 0) * mat.quantity;
        groupLocked += (effectivePrice(mat) || 0) * mat.quantity;
      });

      const header = el('button', 'mp-mat-group');
      header.type = 'button';
      header.classList.toggle('is-collapsed', collapsed);

      const nameWrap = el('span', 'mp-mat-group-name');
      const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chev.setAttribute('class', 'mp-mat-group-chev');
      chev.setAttribute('width', '12');
      chev.setAttribute('height', '12');
      chev.setAttribute('viewBox', '0 0 24 24');
      chev.setAttribute('fill', 'none');
      chev.setAttribute('stroke', 'currentColor');
      chev.setAttribute('stroke-width', '2.4');
      const chevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      chevPath.setAttribute('d', 'M9 18l6-6-6-6');
      chev.appendChild(chevPath);
      nameWrap.appendChild(chev);
      nameWrap.appendChild(document.createTextNode(groupName));
      nameWrap.appendChild(el('span', 'mp-mat-group-count', items.length));
      header.appendChild(nameWrap);

      const totals = el('span', 'mp-mat-group-totals');
      totals.appendChild(el('span', 'mp-faint', `${formatNumber(groupVolume, 2)} m³`));
      totals.appendChild(el('span', null, formatISK(groupLocked)));
      header.appendChild(totals);

      header.addEventListener('click', () => {
        state.collapsedGroups[groupName] = !state.collapsedGroups[groupName];
        renderMaterials();
      });
      // A heading is not a data row: it spans every column.
      host.appendChild(fullWidthRow('mp-mat-group-row', header));

      grandVolume += groupVolume;
      grandLocked += groupLocked;

      if (collapsed) return;

      items.forEach((mat) => {
        const entry = state.drift[mat.typeId];
        const unitVolume = state.volumes[mat.typeId] || 0;
        const locked = effectivePrice(mat);
        const isOverridden = mat.planOverridePrice !== null
          && mat.planOverridePrice !== undefined;
        const row = el('tr', 'mp-materials-row');

        // The icon and text share a flex box INSIDE the cell, so the cell
        // itself is a plain table cell the browser can size normally.
        const nameCell = el('td', 'mp-col-name');
        const name = el('span', 'mp-mat-name');
        name.appendChild(typeIcon(mat.typeId));
        name.appendChild(truncatedCell(null, typeName(mat.typeId)));
        nameCell.appendChild(name);
        row.appendChild(nameCell);

        row.appendChild(el('td', 'mp-right mp-mono mp-muted', formatNumber(mat.quantity)));
        row.appendChild(el('td', 'mp-right mp-mono mp-muted', formatNumber(stillNeeded(mat))));

        if (state.showOwned) {
          row.appendChild(ownedCell(
            mat.ownedPersonal,
            mat.ownedPersonalDetails,
            (d) => d.characterName
          ));
          row.appendChild(ownedCell(
            mat.ownedCorp,
            mat.ownedCorpDetails,
            (d) => `${d.corporationName} - ${d.divisionName}`
          ));
        }

        row.appendChild(el('td', 'mp-right mp-mono mp-faint', formatNumber(unitVolume, 2)));
        row.appendChild(el(
          'td',
          'mp-right mp-mono mp-muted',
          formatNumber(unitVolume * mat.quantity, 2)
        ));

        // A plan-scoped override REPLACES the locked market price. Showing
        // basePrice here would misreport the plan's own cost basis.
        const priceCell = el('td', 'mp-right mp-mono mp-price-cell', formatISK(locked));
        priceCell.setAttribute('data-mp-price-type', String(mat.typeId));
        if (isOverridden) {
          priceCell.classList.add('mp-overridden');
          priceCell.title = `Plan override — market lock was ${formatISK(mat.basePrice)}. Click to edit.`;
        } else {
          priceCell.title = 'Click to set a plan price override';
        }
        priceCell.addEventListener('click', () => startPriceOverrideEdit(priceCell, mat));
        row.appendChild(priceCell);

        row.appendChild(el(
          'td',
          'mp-right mp-mono mp-accent',
          entry && Number.isFinite(entry.livePrice) ? formatISK(entry.livePrice) : '—'
        ));

        const drift = el('td', 'mp-center');
        drift.appendChild(driftCell(entry));
        row.appendChild(drift);

        row.appendChild(el('td', 'mp-right mp-mono', formatISK((locked || 0) * mat.quantity)));

        const acq = el('td', 'mp-acq-cell');
        // Two DIFFERENT sources, which read as duplicates when styled alike:
        //   - acquisitionMethod is a manual ledger entry - how YOU recorded
        //     obtaining it ("Purchased", "Manufactured", ...).
        //   - the match counts are confirmed ESI records - wallet
        //     transactions or industry jobs matched to this material.
        // Both can be true at once, so both are shown, but they are marked
        // apart and each says where it came from.
        if (mat.acquisitionMethod) {
          const pill = el('span', 'mp-acq-pill mp-acq-manual', mat.acquisitionMethod);
          pill.title = `Recorded manually in this plan's ledger as "${mat.acquisitionMethod}"`
            + `${mat.manuallyAcquiredQuantity
              ? ` — ${formatNumber(mat.manuallyAcquiredQuantity)} units` : ''}`;
          acq.appendChild(pill);
        }
        if (mat.purchaseMatchCount > 0) {
          const pill = el(
            'span',
            'mp-acq-pill mp-acq-esi',
            `${mat.purchaseMatchCount} bought`
          );
          pill.title = `${mat.purchaseMatchCount} confirmed wallet transaction`
            + `${mat.purchaseMatchCount === 1 ? '' : 's'} matched from ESI`
            + `${mat.purchasedQuantity
              ? ` — ${formatNumber(mat.purchasedQuantity)} units` : ''}`;
          acq.appendChild(pill);
        }
        if (mat.manufacturingMatchCount > 0) {
          const pill = el(
            'span',
            'mp-acq-pill mp-acq-esi',
            `${mat.manufacturingMatchCount} built`
          );
          pill.title = `${mat.manufacturingMatchCount} confirmed industry job`
            + `${mat.manufacturingMatchCount === 1 ? '' : 's'} matched from ESI`
            + `${mat.manufacturedQuantity
              ? ` — ${formatNumber(mat.manufacturedQuantity)} units` : ''}`;
          acq.appendChild(pill);
        }
        if (acq.children.length === 0) {
          acq.appendChild(el('span', 'mp-acq-none', 'Not Acquired'));
        }
        row.appendChild(acq);

        host.appendChild(row);

        if (entry && Number.isFinite(entry.livePrice)) {
          grandLive += entry.livePrice * mat.quantity;
          livePriced += 1;
        }
      });
    });

    $('mp-total-m3').textContent = `${formatNumber(grandVolume, 2)} m³`;
    $('mp-total-locked').textContent = formatISK(grandLocked);
    $('mp-total-live').textContent = livePriced > 0 ? formatISK(grandLive) : '—';

    const totalDrift = $('mp-total-drift');
    totalDrift.textContent = '';
    if (livePriced > 0 && grandLocked !== 0) {
      totalDrift.appendChild(driftCell({
        driftPercent: ((grandLive - grandLocked) / grandLocked) * 100,
        driftAbsolute: grandLive - grandLocked,
      }));
    }

    renderLockedMeta();
  }

  /* ------------------------------------------------------------ build list */

  const BUILD_SECTIONS = [
    { title: 'Blueprints', roles: ['blueprint'] },
    { title: 'Intermediates', roles: ['intermediate'] },
    { title: 'Reactions', roles: ['reaction', 'sub-reaction'] },
  ];

  async function loadBuildList() {
    if (!state.planId) return;

    // Facilities come from loadPlanData - the Build List EDITS them, so it
    // refetches to pick up anything changed on the Facilities screen since.
    const [items, facilities] = await Promise.all([
      loadSafely('build items', () => window.electronAPI.plans.getBuildItems(state.planId)),
      loadSafely('facilities', () => window.electronAPI.facilities.getFacilities()),
    ]);

    state.buildItems = items || [];
    if (facilities) state.facilities = facilities;
    renderSafely('build list', renderBuildList);
  }

  function facilityName(facilityId) {
    if (!facilityId) return 'No Facility';
    const facility = state.facilities.find((f) => String(f.id) === String(facilityId));
    return facility ? facility.name : 'Unknown facility';
  }

  /**
   * A field is MIXED when a type's instances disagree.
   *
   * getPlanBuildItems collapses per-instance values and returns the literal
   * object `{ mixed: true }` when they differ - not a value. Treating that as
   * a value renders "[object Object]" and would save it as one.
   */
  function isMixed(value) {
    return !!value && typeof value === 'object' && value.mixed === true;
  }

  function buildPlanLabel(value) {
    if (isMixed(value)) return '— Mixed —';
    return BUILD_PLAN_LABELS[value] || (value || '—');
  }

  /** Current value for a field, preferring an unsaved edit. */
  function editedValue(item, field) {
    const pending = state.buildEdits[item.blueprintTypeId];
    if (pending && Object.prototype.hasOwnProperty.call(pending, field)) {
      return pending[field];
    }
    return item[field];
  }

  function recordEdit(item, field, value) {
    if (!state.buildEdits[item.blueprintTypeId]) {
      state.buildEdits[item.blueprintTypeId] = {};
    }
    state.buildEdits[item.blueprintTypeId][field] = value;
    updateBulkCount();
  }

  function updateBulkCount() {
    const count = Object.keys(state.buildEdits).length;
    const label = $('mp-bulk-count');
    if (label) {
      label.textContent = count === 0
        ? 'No changes'
        : `${count} row${count === 1 ? '' : 's'} changed`;
    }
  }

  function isRowEditable(item) {
    return state.bulkEdit || state.editingRow === item.blueprintTypeId;
  }

  function renderBuildList() {
    const host = $('build-list-container');
    if (!host) return;
    host.textContent = '';

    if (state.buildItems.length === 0) {
      host.appendChild(el(
        'div',
        'mp-pending',
        'Nothing to build yet. Add blueprints and everything this plan uses appears here.'
      ));
      return;
    }

    BUILD_SECTIONS.forEach((section) => {
      const rows = state.buildItems.filter((i) => section.roles.includes(i.role));
      if (rows.length === 0) return;

      const card = el('div', 'mp-section');
      card.appendChild(el('div', 'mp-card-accent'));

      const head = el('div', 'mp-section-head');
      head.appendChild(el('span', 'mp-section-title', section.title));
      head.appendChild(el('span', 'mp-section-count', rows.length));
      card.appendChild(head);

      const scroll = el('div', 'mp-section-scroll');
      const table = el('div', 'mp-section-table');

      const header = el('div', 'mp-build-row mp-build-header');
      // "Uses" is the number of places in this plan that need the item - each
      // one a separate plan_blueprints row collapsed into this single row. It
      // is what makes ME/TE/Facility read "— Mixed —", so the header carries a
      // tooltip rather than leaving the number unexplained.
      [
        ['Item', null],
        ['Uses', 'How many places in this plan need this item. Rows with more than one use collapse their settings here — differing values show as “Mixed”.'],
        ['Runs', 'Total runs. Derived from the parent build for intermediates and reactions.'],
        ['Lines', null], ['ME', null], ['TE', null],
        ['Facility', null], ['Build Plan', null], ['Actions', null],
      ].forEach(([label, hint], i) => {
        const cell = el('span', i === 0 || i === 6 || i === 7 ? null : 'mp-right', label);
        if (hint) cell.title = hint;
        header.appendChild(cell);
      });
      table.appendChild(header);

      rows.forEach((item) => table.appendChild(buildRow(item)));

      scroll.appendChild(table);
      card.appendChild(scroll);
      host.appendChild(card);
    });

    updateBulkCount();
  }

  function buildRow(item) {
    const editable = isRowEditable(item);
    const row = el('div', 'mp-build-row');
    row.setAttribute('data-mp-build-type', String(item.blueprintTypeId));

    /* ---- item ---- */
    // No role pill and no product subtext: rows are already grouped under a
    // Blueprints/Intermediates/Reactions heading, and the blueprint name says
    // what it makes. Both only cost width on a table that cannot spare it.
    const cell = el('span', 'mp-build-item');
    const main = el('span', 'mp-build-item-main');
    // Build List rows are blueprints and reactions - both need the bp variant.
    main.appendChild(blueprintIcon(item.blueprintTypeId));
    main.appendChild(truncatedCell('mp-build-item-name', item.typeName));
    cell.appendChild(main);
    row.appendChild(cell);

    /* ---- uses ----
       How many separate places in the plan need this item. >1 is why the
       settings cells on this row can read "— Mixed —". */
    const usesCell = el('span', 'mp-right mp-mono mp-faint', formatNumber(item.instanceCount));
    usesCell.title = item.instanceCount > 1
      ? `Needed in ${formatNumber(item.instanceCount)} places in this plan; editing a setting here applies to all of them`
      : 'Needed in one place in this plan';
    row.appendChild(usesCell);

    /* ---- runs / lines ----
       Only a top-level instance has editable runs; an intermediate's or
       reaction's runs are derived from its parents, so they are shown
       read-only. Those rows carry runs: null, which numericCell renders as a
       bare "—" - the derived total is the useful number there, so pass it
       through as the display value. */
    if (item.runsEditable) {
      row.appendChild(numericCell(item, 'runs', editable));
    } else {
      row.appendChild(derivedRunsCell(item));
    }
    row.appendChild(numericCell(item, 'lines', editable && item.runsEditable));

    /* ---- ME / TE ----
       Reactions have no ME/TE, so those cells stay empty rather than showing 0. */
    const isReaction = item.role === 'reaction' || item.role === 'sub-reaction';
    row.appendChild(isReaction ? el('span') : numericCell(item, 'meLevel', editable));
    row.appendChild(isReaction ? el('span') : numericCell(item, 'teLevel', editable));

    /* ---- facility ---- */
    const facilityValue = editedValue(item, 'facilityId');
    const facilityCell = el('span');
    if (editable) {
      mountRowSelect(facilityCell, {
        options: [{ value: '', label: 'No Facility' }].concat(
          state.facilities.map((f) => ({ value: String(f.id), label: f.name }))
        ),
        // A mixed field starts unset: picking a value applies it to EVERY
        // instance, which is the documented behaviour of this screen.
        value: isMixed(facilityValue) ? null : String(facilityValue || ''),
        placeholder: isMixed(facilityValue) ? '— Mixed —' : 'No Facility',
        onChange: (e) => recordEdit(item, 'facilityId', e.target.value || null),
      });
    } else {
      facilityCell.className = 'mp-build-facility';
      facilityCell.textContent = isMixed(facilityValue)
        ? '— Mixed —'
        : facilityName(facilityValue);
      // Facility names truncate often; without this the full name is
      // unreachable.
      if (!isMixed(facilityValue)) facilityCell.title = facilityCell.textContent;
    }
    if (isMixed(facilityValue)) {
      facilityCell.title = 'Instances differ — picking a value applies it to all uses';
    }
    row.appendChild(facilityCell);

    /* ---- build plan ---- */
    const planValue = editedValue(item, 'useIntermediates');
    const planCell = el('span');
    if (editable) {
      mountRowSelect(planCell, {
        options: BUILD_PLAN_OPTIONS,
        value: isMixed(planValue) ? null : (planValue || 'raw_materials'),
        placeholder: isMixed(planValue) ? '— Mixed —' : 'Raw Materials',
        onChange: (e) => recordEdit(item, 'useIntermediates', e.target.value),
      });
    } else {
      const badge = el('span', 'mp-plan-badge', buildPlanLabel(planValue));
      badge.setAttribute('data-plan', isMixed(planValue) ? 'mixed' : (planValue || ''));
      planCell.appendChild(badge);
    }
    if (isMixed(planValue)) {
      planCell.title = 'Instances differ — picking a plan applies it to all uses';
    }
    row.appendChild(planCell);

    /* ---- actions ---- */
    const actions = el('span', 'mp-build-actions');
    if (state.bulkEdit) {
      // Bulk mode saves everything at once; per-row actions would be ambiguous.
      actions.appendChild(el('span', 'mp-faint', '—'));
    } else if (state.editingRow === item.blueprintTypeId) {
      const save = el('button', 'mp-link-action', 'Save');
      save.type = 'button';
      save.addEventListener('click', () => saveRow(item));
      const cancel = el('button', 'mp-link-action mp-link-muted', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => {
        delete state.buildEdits[item.blueprintTypeId];
        state.editingRow = null;
        renderBuildList();
      });
      actions.appendChild(save);
      actions.appendChild(cancel);
    } else {
      const edit = el('button', 'mp-link-action', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', () => {
        state.editingRow = item.blueprintTypeId;
        renderBuildList();
      });
      actions.appendChild(edit);
    }
    row.appendChild(actions);

    return row;
  }

  /**
   * Runs for a row whose runs are NOT directly editable - an intermediate, or a
   * reaction. Its run count is derived from whatever consumes it, summed across
   * every instance in the plan, so it is displayed read-only.
   *
   * Without this the column was blank (`runs` is null on these rows), which read
   * as "no runs" on exactly the rows a build plan is scheduled around.
   */
  function derivedRunsCell(item) {
    const cell = el('span', 'mp-right');
    const total = Number(item.totalRuns);
    if (!Number.isFinite(total) || total <= 0) {
      cell.appendChild(el('span', 'mp-build-static', '—'));
      return cell;
    }
    cell.appendChild(el('span', 'mp-build-static', formatNumber(total)));
    cell.title = item.instanceCount > 1
      ? `${formatNumber(total)} runs derived across ${formatNumber(item.instanceCount)} uses in this plan`
      : 'Runs derived from what consumes this item';
    return cell;
  }

  function numericCell(item, field, editable) {
    const cell = el('span', 'mp-right');
    const value = editedValue(item, field);

    // ME/TE can differ across a type's instances, in which case the backend
    // hands back { mixed: true } rather than a number.
    if (isMixed(value)) {
      cell.title = 'Instances differ — entering a value applies it to all uses';
      if (!editable) {
        cell.appendChild(el('span', 'mp-build-static', '—'));
        return cell;
      }
      const mixedInput = document.createElement('input');
      mixedInput.type = 'number';
      mixedInput.className = 'mp-build-input';
      mixedInput.placeholder = 'Mixed';
      mixedInput.addEventListener('change', () => {
        const parsed = parseInt(mixedInput.value, 10);
        if (Number.isFinite(parsed)) recordEdit(item, field, parsed);
      });
      cell.appendChild(mixedInput);
      return cell;
    }

    if (value === null || value === undefined) {
      // Genuinely not applicable (e.g. runs on a derived intermediate).
      cell.appendChild(el('span', 'mp-build-static', '—'));
      return cell;
    }

    if (!editable) {
      cell.appendChild(el('span', 'mp-build-static', formatNumber(value)));
      return cell;
    }

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'mp-build-input';
    input.value = value;
    input.min = field === 'runs' || field === 'lines' ? '1' : '0';
    input.addEventListener('change', () => {
      const parsed = parseInt(input.value, 10);
      if (Number.isFinite(parsed)) recordEdit(item, field, parsed);
    });
    cell.appendChild(input);
    return cell;
  }

  /**
   * A plain native select for an editable Build List cell.
   *
   * Native, not QFSearchSelect: these are short fixed lists, and the popover
   * rendered the current value unreadably in a table cell. A native select's
   * dropdown is drawn by the OS, so it may extend past the window rather than
   * being squeezed into the column.
   */
  function mountRowSelect(host, opts) {
    if (!host) return null;
    const select = el('select', 'qf-select mp-row-select');
    if (opts.placeholder) {
      const ph = el('option', null, opts.placeholder);
      ph.value = '';
      // Only reachable while the field is unset; picking a real option is
      // what a mixed field is for.
      ph.disabled = opts.value !== null && opts.value !== undefined;
      select.appendChild(ph);
    }
    (opts.options || []).forEach((opt) => {
      const option = el('option', null, opt.label);
      option.value = opt.value;
      select.appendChild(option);
    });

    select.value = opts.value === null || opts.value === undefined ? '' : String(opts.value);
    select.addEventListener('change', () => opts.onChange({ target: { value: select.value } }));

    host.appendChild(select);
    return select;
  }

  /**
   * Persist one build row.
   *
   * The Build List edits BY TYPE - a single row can stand for several plan
   * blueprints - so this goes through updateBuildItemsByType, which is
   * type-scoped. bulkUpdateBlueprints keys on planBlueprintId, which this
   * tab does not have and never edits.
   */
  function saveBuildItem(item) {
    return window.electronAPI.plans.updateBuildItemsByType(
      state.planId,
      item.itemType,
      item.blueprintTypeId,
      state.buildEdits[item.blueprintTypeId]
    );
  }

  /** Build items with a pending edit, in render order. */
  function editedBuildItems() {
    return state.buildItems.filter((item) => state.buildEdits[item.blueprintTypeId]);
  }

  async function saveRow(item) {
    const updates = state.buildEdits[item.blueprintTypeId];
    if (!updates) {
      state.editingRow = null;
      renderBuildList();
      return;
    }

    try {
      await saveBuildItem(item);
      delete state.buildEdits[item.blueprintTypeId];
      state.editingRow = null;
      toast('Build settings saved.', 'success');
      await reloadAfterBuildChange();
    } catch (error) {
      console.error('[plans] save build row failed:', error);
      toast(`Failed to save: ${error.message}`, 'error');
    }
  }

  async function saveBulkEdits() {
    const items = editedBuildItems();
    if (items.length === 0) {
      state.bulkEdit = false;
      setBulkChrome();
      renderBuildList();
      return;
    }

    try {
      // Sequential, not Promise.all: these all write the same rows, and a
      // half-applied batch is worse than a slow one.
      for (const item of items) {
        await saveBuildItem(item);
      }
      state.buildEdits = {};
      state.bulkEdit = false;
      setBulkChrome();
      toast(`Saved ${items.length} change${items.length === 1 ? '' : 's'}.`, 'success');
      await reloadAfterBuildChange();
    } catch (error) {
      console.error('[plans] bulk save failed:', error);
      toast(`Failed to save changes: ${error.message}`, 'error');
    }
  }

  /**
   * Changing ME/TE/runs changes what the plan needs, so materials and the
   * summary are stale. This does NOT re-price: locked prices stay locked
   * (binding rule 7) - only quantities move.
   */
  async function reloadAfterBuildChange() {
    await loadBuildList();
    await loadPlanData();
  }

  /**
   * "Rebuild Plan": repair stale stored state, then recalculate the plan.
   *
   * An ordinary recalculation reads the stored rows and recomputes from them, so
   * anything wrong IN those rows survives it. The repair pass re-resolves each
   * row's facility snapshot from the current facility settings first - that is
   * what fixes plans whose bonuses were silently dropped by an older version.
   *
   * Does NOT re-price. Plan prices are locked deliberately and only an explicit
   * "Re-lock Prices" action may adopt live ones - a quantity repair must not
   * become a backdoor that silently re-prices the plan.
   */
  async function rebuildPlan() {
    if (!state.planId) return;

    const btn = $('mp-recalc-all');
    // The label has its own span: setting textContent on the button itself
    // would delete the inline SVG icon and never bring it back.
    const label = $('mp-recalc-all-label');
    const original = label ? label.textContent : null;
    if (btn) {
      btn.disabled = true;
      if (label) label.textContent = 'Rebuilding…';
    }

    try {
      const result = await window.electronAPI.plans.repairAndRecalculate(state.planId, false);

      // The handler reports failure in the payload rather than throwing, so a
      // bare success assumption would show "done" over a plan that never rebuilt.
      if (!result || !result.success) {
        throw new Error((result && result.error) || 'Rebuild failed');
      }

      // A rebuild changes quantities everywhere, and this button lives in the
      // plan header rather than on one tab - so refresh the plan totals AND
      // whichever tab the user is actually looking at. showTab already owns the
      // tab -> loader mapping; re-showing the current tab reuses it rather than
      // duplicating a switch that would drift.
      await loadPlanData();
      showTab(state.tab);

      const repaired = result.facilitiesRepaired || 0;
      const cleared = result.facilitiesCleared || 0;
      const parts = [];
      if (repaired) parts.push(`${repaired} facility snapshot${repaired === 1 ? '' : 's'} refreshed`);
      if (cleared) parts.push(`${cleared} cleared`);
      toast(
        parts.length ? `Plan rebuilt — ${parts.join(', ')}.` : 'Plan rebuilt.',
        'success'
      );

      // A facility referenced by the plan but gone from settings leaves those
      // rows with no bonuses at all - the user has to re-pick one, so say so.
      if (result.missingFacilities && result.missingFacilities.length > 0) {
        toast(
          `${result.missingFacilities.length} row group(s) reference a facility that no longer `
          + 'exists. Re-select a facility on those rows.',
          'warning'
        );
      }
    } catch (error) {
      console.error('[plans] rebuild plan failed:', error);
      toast(`Rebuild failed: ${error.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        if (label && original !== null) label.textContent = original;
      }
    }
  }

  function setBulkChrome() {
    $('mp-bulk-edit').hidden = state.bulkEdit;
    $('mp-bulk-cancel').hidden = !state.bulkEdit;
    $('mp-bulk-save').hidden = !state.bulkEdit;
    $('mp-bulk-banner').hidden = !state.bulkEdit;
  }

  /* --------------------------------------------- blueprints / reactions */

  async function loadBlueprintsTab() {
    if (!state.planId) return;

    // getBlueprints returns the WHOLE plan - top-level entries and their
    // auto-created intermediates alike - so the tree is built from this one
    // call via parentBlueprintId. Intermediates are shown here, not filtered
    // out: they are what "Mark Built" applies to.
    const blueprints = await loadSafely('plan blueprints', () =>
      window.electronAPI.plans.getBlueprints(state.planId)
    );

    // Reactions are excluded: they have their own tab, where each is shown as
    // a chain with its inputs. Listing them here as blueprint rows - with
    // empty ME/TE, since reactions have neither - duplicated them badly.
    state.blueprints = flattenBlueprintTree(withoutReactions(blueprints || []));

    // getBlueprints returns type IDs only - both the blueprint and its product.
    await ensureNames(state.blueprints.flatMap((bp) => [
      bp.blueprintTypeId,
      bp.intermediateProductTypeId,
    ]));

    renderSafely('blueprints', renderBlueprintsTab);
  }

  /**
   * Drop every reaction, and everything hanging beneath one.
   *
   * A plain filter is not enough: a reaction's own children would then look
   * parentless, and flattenBlueprintTree deliberately promotes parentless
   * rows to roots - so they would reappear detached at the top level.
   */
  function withoutReactions(rows) {
    const removed = new Set(
      rows.filter((bp) => bp.blueprintType === 'reaction').map((bp) => bp.planBlueprintId)
    );
    if (removed.size === 0) return rows;

    // Repeat until nothing new is removed: a dropped row's children only
    // become droppable once their parent has gone.
    let changed = true;
    while (changed) {
      changed = false;
      rows.forEach((bp) => {
        if (removed.has(bp.planBlueprintId)) return;
        if (bp.parentBlueprintId && removed.has(bp.parentBlueprintId)) {
          removed.add(bp.planBlueprintId);
          changed = true;
        }
      });
    }

    return rows.filter((bp) => !removed.has(bp.planBlueprintId));
  }

  /**
   * Order the plan's blueprints parent-before-child, tagging each with its
   * depth so the table can indent it.
   *
   * Rows arrive flat with a parentBlueprintId, and an intermediate is only
   * meaningful underneath the thing that needs it. Any row whose parent is
   * missing is treated as a root, so a broken link still renders rather than
   * silently dropping the row and everything beneath it.
   */
  function flattenBlueprintTree(rows) {
    const byParent = new Map();
    const ids = new Set(rows.map((bp) => bp.planBlueprintId));

    rows.forEach((bp) => {
      const parent = bp.parentBlueprintId && ids.has(bp.parentBlueprintId)
        ? bp.parentBlueprintId
        : null;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(bp);
    });

    const ordered = [];
    const walk = (parentId, depth) => {
      (byParent.get(parentId) || []).forEach((bp) => {
        ordered.push({ ...bp, depth });
        walk(bp.planBlueprintId, depth + 1);
      });
    };
    walk(null, 0);

    return ordered;
  }

  async function loadReactionsTab() {
    if (!state.planId) return;
    const reactions = await loadSafely('plan reactions', () =>
      window.electronAPI.plans.getReactions(state.planId)
    );

    // PRIMARY reactions only. A sub-reaction - one whose product another
    // reaction consumes - already appears inside its parent's input tree, so
    // a card of its own would be the same chain listed twice.
    // isTopLevel is main's own classification; treat a missing flag as
    // top-level rather than hiding a card on absent data.
    state.reactions = (reactions || []).filter((r) => r.isTopLevel !== false);

    // The tab only exists when the plan actually has reactions.
    const tabBtn = $('reactions-tab-button');
    if (tabBtn) tabBtn.hidden = state.reactions.length === 0;

    // Reactions key on reactionTypeId, NOT blueprintTypeId.
    await ensureNames(state.reactions.flatMap((r) => [
      r.reactionTypeId,
      r.intermediateProductTypeId,
    ]));

    renderSafely('reactions', renderReactionsTab);
  }

  /**
   * Expand each reaction's input tree.
   *
   * Deliberately NOT part of loadReactionsTab: that runs on every plan open
   * just to decide whether the tab exists, and this is one full material
   * calculation per reaction. It only runs when the tab is actually viewed.
   */
  async function loadReactionTrees() {
    if (!state.planId || state.reactions.length === 0) return;

    const trees = await Promise.all(state.reactions.map((reaction) =>
      loadSafely('reaction tree', () =>
        window.electronAPI.plans.calculateReactionTree(
          reaction.planBlueprintId,
          reaction.runs,
          state.characterId,
          reaction.facilitySnapshot || reaction.facilityId,
          state.marketSet ? state.marketSet.id : null
        )
      )
    ));

    state.reactionTrees = {};
    state.reactions.forEach((reaction, i) => {
      state.reactionTrees[reaction.planBlueprintId] = trees[i] || null;
    });

    renderSafely('reactions', renderReactionsTab);
  }

  /**
   * How many units a row actually yields: runs x output per run.
   *
   * Null when the SDE could not supply an output per run - showing "Produces
   * 4x" for a blueprint that makes 100 per run would be worse than showing
   * nothing.
   */
  function totalProduced(bp) {
    const perRun = bp.productQuantityPerRun;
    if (!Number.isFinite(perRun) || perRun <= 0) return null;
    const runs = Number(bp.runs);
    if (!Number.isFinite(runs) || runs <= 0) return null;
    return runs * perRun;
  }

  /** Facility label for a plan blueprint, preferring its frozen snapshot. */
  function blueprintFacility(item) {
    // The snapshot is what the plan was costed against; the live facility may
    // since have been edited or deleted.
    if (item.facilitySnapshot && item.facilitySnapshot.name) return item.facilitySnapshot.name;
    return facilityName(item.facilityId);
  }

  function renderBlueprintsTab() {
    const host = $('blueprints-container');
    if (!host) return;
    host.textContent = '';

    if (state.blueprints.length === 0) {
      host.appendChild(el(
        'div',
        'mp-pending',
        'No blueprints yet. Click Add Blueprint to start building this plan.'
      ));
      return;
    }

    const card = el('div', 'mp-section');
    card.appendChild(el('div', 'mp-card-accent'));

    const header = el('div', 'mp-bp-row mp-build-header');
    ['Blueprint', 'Runs', 'Lines', 'ME', 'TE', 'Facility', 'Build Plan', '']
      .forEach((label, i) => {
        header.appendChild(el('span', [1, 2, 3, 4].includes(i) ? 'mp-right' : null, label));
      });
    card.appendChild(header);

    state.blueprints.forEach((bp) => {
      const row = el('div', 'mp-bp-row');
      row.setAttribute('data-mp-blueprint-id', String(bp.planBlueprintId));
      if (bp.isIntermediate) row.classList.add('mp-bp-intermediate');
      // Indent by tree depth rather than nesting the DOM, so every row stays a
      // direct child of the same grid and the columns line up across depths.
      if (bp.depth) row.style.setProperty('--mp-depth', String(bp.depth));

      // Name plus a "Produces" subtext, rather than a Product column: the
      // blueprint name already says WHAT is made, so the column only cost
      // width. What it did not say is HOW MANY.
      const nameCell = el('span', 'mp-bp-name-cell');
      const name = el('span', 'mp-mat-name');
      if (bp.depth) name.appendChild(el('span', 'mp-tree-marker', '↳'));
      name.appendChild(blueprintIcon(bp.blueprintTypeId));
      name.appendChild(truncatedCell(null, typeName(bp.blueprintTypeId)));
      nameCell.appendChild(name);

      // Badges live on the SUB-LINE, not beside the name: a pill next to a
      // long blueprint name ate the width the name needed and truncated it.
      const sub = el('span', 'mp-bp-subline');
      const produced = totalProduced(bp);
      if (produced !== null) {
        sub.appendChild(el('span', 'mp-bp-produces', `Produces ${formatNumber(produced)}x`));
      }
      const built = builtBadge(bp);
      if (built) sub.appendChild(built);
      if (sub.children.length > 0) nameCell.appendChild(sub);

      row.appendChild(nameCell);
      // Runs, with runs-per-line when the job is split across several lines -
      // 30 runs over 3 lines is 10 each, which is what governs the schedule.
      const perLine = runsPerLine(bp.runs, bp.lines);
      const runsCell = el('span', 'mp-right mp-mono', formatNumber(bp.runs));
      if (perLine !== null) {
        runsCell.title = `${formatNumber(perLine, perLine % 1 === 0 ? 0 : 1)} runs per line`;
        runsCell.appendChild(el(
          'span',
          'mp-faint mp-per-line',
          ` (${formatNumber(perLine, perLine % 1 === 0 ? 0 : 1)}/line)`
        ));
      }
      row.appendChild(runsCell);
      row.appendChild(el('span', 'mp-right mp-mono mp-muted', formatNumber(bp.lines)));
      row.appendChild(el('span', 'mp-right mp-mono mp-muted', formatNumber(bp.meLevel)));
      row.appendChild(el('span', 'mp-right mp-mono mp-muted', formatNumber(bp.teLevel)));
      row.appendChild(truncatedCell('mp-muted mp-build-facility', blueprintFacility(bp)));

      const badge = el('span', 'mp-plan-badge', buildPlanLabel(bp.useIntermediates));
      badge.setAttribute('data-plan', bp.useIntermediates || '');
      const planCell = el('span');
      planCell.appendChild(badge);
      row.appendChild(planCell);

      const actions = el('span', 'mp-build-actions');

      // Built tracking applies to things the plan MAKES. A top-level entry is
      // the plan's own output and is tracked through industry jobs instead.
      if (bp.isIntermediate) {
        const mark = el(
          'button',
          'mp-link-action',
          bp.builtRuns > 0 ? 'Edit Built Qty' : 'Mark Built'
        );
        mark.type = 'button';
        mark.setAttribute('data-mp-mark-built', String(bp.planBlueprintId));
        mark.addEventListener('click', () => openMarkBuiltModal(bp));
        actions.appendChild(mark);
      } else {
        const remove = el('button', 'mp-link-action mp-link-danger', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', () => removeBlueprint(bp));
        actions.appendChild(remove);
      }

      row.appendChild(actions);

      card.appendChild(row);
    });

    host.appendChild(card);
  }

  /**
   * Progress badge for something the user has started building.
   *
   * Only meaningful once something is built - a 0/24 badge on every row is
   * noise - and it turns green only at full completion. Reactions carry built
   * runs too without being intermediates, so the caller decides eligibility.
   */
  function builtBadge(bp) {
    if (!bp.builtRuns) return null;

    const total = bp.runs || 0;
    const pct = total > 0 ? Math.round((bp.builtRuns / total) * 100) : 0;
    const full = total > 0 && bp.builtRuns >= total;

    const badge = el(
      'span',
      `mp-built-badge${full ? ' mp-built-full' : ''}`,
      `${formatNumber(bp.builtRuns)}/${formatNumber(total)} Built (${pct}%)`
    );
    badge.setAttribute('data-mp-built-badge', String(bp.planBlueprintId));
    return badge;
  }

  function renderReactionsTab() {
    const host = $('reactions-container');
    if (!host) return;
    host.textContent = '';

    if (state.reactions.length === 0) {
      host.appendChild(el('div', 'mp-pending', 'This plan uses no reactions.'));
      return;
    }

    // Facility and build plan are EDITED on the Build List; this tab reports
    // them. Saying so stops the read-only values reading as broken controls.
    host.appendChild(el(
      'div',
      'mp-tab-note',
      'Reaction chains this plan produces as intermediates. '
        + 'Facility and build plan are edited on the Build List tab.'
    ));

    state.reactions.forEach((reaction) => {
      host.appendChild(renderReactionCard(reaction));
    });
  }

  function renderReactionCard(reaction) {
    const card = el('div', 'mp-section mp-reaction-card');
    card.setAttribute('data-mp-reaction-id', String(reaction.planBlueprintId));
    card.appendChild(el('div', 'mp-card-accent'));

    const head = el('div', 'mp-reaction-head');
    const info = el('div', 'mp-reaction-info');

    const title = el('div', 'mp-reaction-title');
    title.appendChild(typeIcon(reaction.intermediateProductTypeId || reaction.reactionTypeId));
    title.appendChild(el(
      'span',
      'mp-reaction-name',
      typeName(reaction.intermediateProductTypeId || reaction.reactionTypeId)
    ));
    const progress = builtBadge(reaction);
    if (progress) title.appendChild(progress);
    info.appendChild(title);

    // What the chain yields, which is the number the plan is really sized by.
    const tree = state.reactionTrees[reaction.planBlueprintId];
    const perRun = tree && tree.product ? tree.product.baseQuantity : null;
    const totalProduced = tree && tree.product ? tree.product.quantity : null;

    const stats = el('div', 'mp-reaction-stats');
    const stat = (label, value, cls) => {
      const box = el('span', 'mp-reaction-stat');
      box.appendChild(el('span', 'mp-reaction-stat-label', label));
      box.appendChild(el('span', `mp-reaction-stat-value${cls ? ` ${cls}` : ''}`, value));
      stats.appendChild(box);
    };
    stat('Runs', formatNumber(reaction.runs));
    stat('Per Run', perRun !== null ? formatNumber(perRun) : '—');
    stat(
      'Total Produced',
      totalProduced !== null ? formatNumber(totalProduced) : '—',
      'mp-reaction-stat-accent'
    );
    info.appendChild(stats);

    const meta = el('div', 'mp-reaction-meta');
    const facility = el('span', 'mp-reaction-meta-item');
    facility.appendChild(el('span', 'mp-faint', 'Facility'));
    facility.appendChild(truncatedCell('mp-muted', blueprintFacility(reaction)));
    meta.appendChild(facility);

    const plan = el('span', 'mp-reaction-meta-item');
    plan.appendChild(el('span', 'mp-faint', 'Build Plan'));
    const planBadge = el('span', 'mp-plan-badge', buildPlanLabel(reaction.useIntermediates));
    planBadge.setAttribute('data-plan', reaction.useIntermediates || '');
    plan.appendChild(planBadge);
    meta.appendChild(plan);
    info.appendChild(meta);

    head.appendChild(info);

    const mark = el(
      'button',
      'btn btn-secondary mp-reaction-built',
      reaction.builtRuns > 0 ? 'Edit Built Qty' : 'Mark Built'
    );
    mark.type = 'button';
    mark.setAttribute('data-mp-mark-built', String(reaction.planBlueprintId));
    // A reaction row is not a blueprint row: it keys on reactionTypeId and
    // routes to markReactionBuilt, so hand the modal the shape it expects.
    mark.addEventListener('click', () => openMarkBuiltModal({
      ...reaction,
      blueprintTypeId: reaction.reactionTypeId,
      blueprintType: 'reaction',
    }));
    head.appendChild(mark);

    card.appendChild(head);

    const scroll = el('div', 'mp-reaction-tree-scroll');
    const body = el('div', 'mp-reaction-tree');

    if (!tree) {
      body.appendChild(el('div', 'mp-pending', 'Calculating inputs…'));
    } else if (!tree.tree || tree.tree.length === 0) {
      body.appendChild(el('div', 'mp-pending', 'This reaction has no expanded inputs.'));
    } else {
      appendReactionNodes(body, tree.tree, 0);
    }

    scroll.appendChild(body);
    card.appendChild(scroll);
    return card;
  }

  /** Role of a node in a reaction's input tree, which drives its badge. */
  function reactionNodeRole(node) {
    if (node.isIntermediate) return { key: 'intermediate', label: 'Reaction' };
    if (node.isManufactured) return { key: 'manufactured', label: 'Built' };
    return { key: 'raw', label: 'Raw' };
  }

  function appendReactionNodes(host, nodes, depth) {
    nodes.forEach((node) => {
      const role = reactionNodeRole(node);
      const row = el('div', 'mp-reaction-node');
      row.setAttribute('data-mp-reaction-node', String(node.typeID));
      row.setAttribute('data-mp-node-role', role.key);
      row.style.setProperty('--mp-depth', String(depth));

      row.appendChild(el('span', `mp-node-glyph mp-node-${role.key}`, depth ? '↳' : '•'));
      row.appendChild(truncatedCell('mp-node-name', node.typeName || typeName(node.typeID)));

      if (node.runsNeeded != null) {
        row.appendChild(el(
          'span',
          'mp-faint mp-mono mp-node-runs',
          `${formatNumber(node.runsNeeded)} run${node.runsNeeded === 1 ? '' : 's'}`
        ));
      } else {
        row.appendChild(el('span'));
      }

      // Only a non-default sourcing is worth calling out; "raw_materials" is
      // what every node does unless told otherwise.
      const sourcing = el('span', 'mp-node-sourcing');
      if (node.buildPlan && node.buildPlan !== 'raw_materials') {
        const chip = el('span', 'mp-plan-badge', buildPlanLabel(node.buildPlan));
        chip.setAttribute('data-plan', node.buildPlan);
        sourcing.appendChild(chip);
      }
      row.appendChild(sourcing);

      row.appendChild(el('span', 'mp-mono mp-right mp-node-qty', `×${formatNumber(node.quantity)}`));
      row.appendChild(el('span', `mp-node-badge mp-node-${role.key}`, role.label));

      host.appendChild(row);

      if (node.children && node.children.length > 0) {
        appendReactionNodes(host, node.children, depth + 1);
      }
    });
  }

  async function removeBlueprint(bp) {
    try {
      await window.electronAPI.plans.removeBlueprint(bp.planBlueprintId);
      await loadBlueprintsTab();
      // Removing a blueprint changes what the plan needs.
      await loadPlanData();
      toast('Blueprint removed.', 'success');
    } catch (error) {
      console.error('[plans] remove blueprint failed:', error);
      toast(`Failed to remove blueprint: ${error.message}`, 'error');
    }
  }

  /* --------------------------------------------------------- material tree */

  async function loadTree() {
    if (!state.planId) return;
    const tree = await loadSafely('material tree', () =>
      window.electronAPI.plans.getMaterialTree(state.planId)
    );
    state.tree = tree;
    renderSafely('tree', renderTree);
  }

  /**
   * Material tree.
   *
   * NOTE: getMaterialTree is the one plan IPC that resolves its own names, and
   * it uses `quantityNeeded` where the materials LIST uses `quantity`. Both
   * verified in docs/plan-ipc-shapes.md.
   */
  function renderTree() {
    const host = $('blueprint-tree-container');
    if (!host) return;
    host.textContent = '';

    const roots = Array.isArray(state.tree) ? state.tree : [];
    if (roots.length === 0) {
      host.appendChild(el('div', 'mp-pending', 'No tree to show yet.'));
      return;
    }

    const bar = el('div', 'mp-tree-bar');
    bar.appendChild(el(
      'span',
      'mp-tab-note',
      'Full manufacturing and reaction dependency tree. '
        + 'Expand a buildable node for its stats and inputs.'
    ));
    const barActions = el('span', 'mp-tree-bar-actions');
    const expandAll = el('button', 'mp-link-action', 'Expand all');
    expandAll.type = 'button';
    expandAll.setAttribute('data-mp-tree-expand-all', '');
    expandAll.addEventListener('click', () => setAllTreeCollapsed(false));
    const collapseAll = el('button', 'mp-link-action', 'Collapse all');
    collapseAll.type = 'button';
    collapseAll.setAttribute('data-mp-tree-collapse-all', '');
    collapseAll.addEventListener('click', () => setAllTreeCollapsed(true));
    barActions.appendChild(expandAll);
    barActions.appendChild(el('span', 'mp-faint', '·'));
    barActions.appendChild(collapseAll);
    bar.appendChild(barActions);
    host.appendChild(bar);

    const card = el('div', 'mp-section');
    card.appendChild(el('div', 'mp-card-accent'));

    const scroll = el('div', 'mp-tree-scroll');
    const body = el('div', 'mp-tree-body');

    // No Item column: the name is its own full-width line above each row.
    const header = el('div', 'mp-tree-grid mp-build-header');
    ['Quantity', 'Runs', 'ME', 'Source', 'Price/ea', 'Total', 'Type', '']
      .forEach((label, i) => {
        // Numeric columns right, the type chip centred, actions flush right.
        const cls = [0, 1, 2, 4, 5].includes(i) ? 'mp-right'
          : i === 6 ? 'mp-center' : null;
        header.appendChild(el('span', cls, label));
      });
    body.appendChild(header);

    const walk = (node, depth) => {
      const key = treeNodeKey(node);
      const hasChildren = treeChildren(node).length > 0;
      const collapsed = state.treeCollapsed[key] === true;

      // The NAME is decoupled from the data row: it gets its own full-width
      // line, indented to show the tree, while the figures below it stay in
      // fixed columns starting at the left edge. Indentation therefore costs
      // the name nothing - it can run the full width of the card - and the
      // table never widens as the tree deepens.
      const name = el('div', 'mp-tree-name-line');
      name.setAttribute('data-mp-tree-name', key);
      name.style.paddingLeft = `${18 + depth * 20}px`;

      if (hasChildren) {
        const caret = el('button', 'mp-tree-caret', collapsed ? '▸' : '▾');
        caret.type = 'button';
        caret.setAttribute('data-mp-tree-toggle', key);
        caret.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        caret.addEventListener('click', () => {
          state.treeCollapsed[key] = !collapsed;
          renderSafely('tree', renderTree);
        });
        name.appendChild(caret);
      } else {
        // A leaf keeps the same 16px gutter so names stay aligned with the
        // nodes above them instead of jumping left.
        name.appendChild(el('span', 'mp-tree-caret-spacer'));
      }

      if (node.typeId) name.appendChild(typeIcon(node.typeId));
      name.appendChild(el('span', 'mp-tree-name-text', node.typeName));
      body.appendChild(name);

      const row = el('div', 'mp-tree-grid');
      row.setAttribute('data-mp-tree-type', String(node.typeId));
      row.setAttribute('data-mp-tree-key', key);
      // Tints the figures belonging to a deeper node, so a row is still
      // visually tied to the name above it.
      row.style.setProperty('--mp-depth', String(depth));

      row.appendChild(el('span', 'mp-right mp-mono', formatNumber(node.quantityNeeded)));
      row.appendChild(el(
        'span',
        'mp-right mp-mono mp-muted',
        node.runsNeeded ? formatNumber(node.runsNeeded) : '—'
      ));
      row.appendChild(el(
        'span',
        'mp-right mp-mono mp-muted',
        node.meLevel === null || node.meLevel === undefined ? '—' : formatNumber(node.meLevel)
      ));

      // Source is how this node is obtained: its build plan, or the market.
      const source = el('span', 'mp-muted mp-tree-source');
      if (node.buildPlan) {
        const badge = el('span', 'mp-plan-badge', buildPlanLabel(node.buildPlan));
        badge.setAttribute('data-plan', node.buildPlan);
        source.appendChild(badge);
      } else {
        source.appendChild(el('span', 'mp-faint', 'Market'));
      }
      row.appendChild(source);

      row.appendChild(el('span', 'mp-right mp-mono mp-tree-price', formatISK(node.priceEach)));
      row.appendChild(el(
        'span',
        'mp-right mp-mono',
        formatISK((node.priceEach || 0) * (node.quantityNeeded || 0))
      ));

      const typeCell = el('span', 'mp-center');
      const role = treeNodeRole(node);
      const chip = el('span', `mp-node-badge mp-node-${role.key}`, role.label);
      typeCell.appendChild(chip);
      row.appendChild(typeCell);

      // Only a node with a producer HAS stats to show; a raw material bought
      // from the market has nothing behind it to expand.
      const actions = el('span', 'mp-tree-actions');
      if (node.sourcePlanBlueprintId) {
        const open = state.treeDetailOpen === key;
        const detail = el('button', 'mp-link-action', open ? 'Hide' : 'Details');
        detail.type = 'button';
        detail.setAttribute('data-mp-tree-detail', key);
        detail.addEventListener('click', () => toggleTreeDetail(node, key));
        actions.appendChild(detail);
      }
      row.appendChild(actions);

      body.appendChild(row);

      if (state.treeDetailOpen === key) {
        body.appendChild(renderTreeDetail(node, depth));
      }

      if (!collapsed) {
        treeChildren(node).forEach((child) => walk(child, depth + 1));
      }
    };

    roots.forEach((node) => walk(node, 0));
    scroll.appendChild(body);
    card.appendChild(scroll);
    host.appendChild(card);
  }

  /**
   * A node's children, minus its own buy-mode echo.
   *
   * A node set to "Buy Intermediate" gets a material leaf of the SAME type
   * pushed underneath it, because getPlanMaterials only reads node_type
   * 'material' rows and the item would otherwise vanish from the shopping
   * list. That echo is a storage detail: on the tree it reads as the item
   * being an input to itself, so it is hidden here rather than removed from
   * the data.
   */
  function treeChildren(node) {
    const children = node.children || [];
    if (node.buildPlan !== 'buy') return children;
    return children.filter((child) => child.typeId !== node.typeId);
  }

  /**
   * Stable identity for a tree node.
   *
   * typeId alone is not unique - the same material can appear under several
   * parents - so collapsing one would collapse its twins elsewhere.
   */
  function treeNodeKey(node) {
    return node.nodeId != null
      ? String(node.nodeId)
      : `${node.sourcePlanBlueprintId || 'n'}:${node.typeId}`;
  }

  function treeNodeRole(node) {
    if (node.isReaction) return { key: 'intermediate', label: 'Reaction' };
    if (node.sourcePlanBlueprintId) return { key: 'manufactured', label: 'Built' };
    return { key: 'raw', label: 'Raw' };
  }

  function setAllTreeCollapsed(collapsed) {
    state.treeCollapsed = {};
    if (collapsed) {
      const walk = (nodes) => {
        nodes.forEach((node) => {
          if ((node.children || []).length > 0) {
            state.treeCollapsed[treeNodeKey(node)] = true;
            walk(node.children);
          }
        });
      };
      walk(Array.isArray(state.tree) ? state.tree : []);
    }
    renderSafely('tree', renderTree);
  }

  /**
   * Per-node stats and direct inputs, fetched on demand.
   *
   * One node at a time: this is a full material calculation per node, and
   * the panel only shows one anyway.
   */
  async function toggleTreeDetail(node, key) {
    if (state.treeDetailOpen === key) {
      state.treeDetailOpen = null;
      renderSafely('tree', renderTree);
      return;
    }

    state.treeDetailOpen = key;
    renderSafely('tree', renderTree);

    // `undefined` is "not fetched yet"; a stored `null` is "fetched, nothing
    // there" and must not be retried on every open.
    if (state.treeDetails[key] === undefined) {
      const detail = await loadSafely('tree node detail', () =>
        window.electronAPI.plans.getMaterialTreeNodeDetail(node.sourcePlanBlueprintId)
      );
      // The user may have closed it, or opened another, while this was in
      // flight - only the still-open node may repaint.
      state.treeDetails[key] = detail || null;
      if (state.treeDetailOpen !== key) return;
      renderSafely('tree', renderTree);
    }
  }

  function renderTreeDetail(node, depth) {
    const key = treeNodeKey(node);
    const panel = el('div', 'mp-tree-detail');
    panel.setAttribute('data-mp-tree-detail-panel', key);
    panel.style.paddingLeft = `${20 + depth * 20}px`;

    const detail = state.treeDetails[key];
    if (detail === undefined) {
      panel.appendChild(el('div', 'mp-pending', 'Loading details…'));
      return panel;
    }
    if (detail === null) {
      panel.appendChild(el('div', 'mp-pending', 'No details available for this node.'));
      return panel;
    }

    const stats = el('div', 'mp-reaction-stats');
    const stat = (label, value) => {
      const box = el('span', 'mp-reaction-stat');
      box.appendChild(el('span', 'mp-reaction-stat-label', label));
      box.appendChild(el('span', 'mp-reaction-stat-value', value));
      stats.appendChild(box);
    };
    stat('Runs', formatNumber(detail.runs));
    // A reaction has no ME/TE at all - rendering 0 would imply it does.
    if (detail.blueprintType !== 'reaction') {
      stat('ME', formatNumber(detail.meLevel || 0));
      stat('TE', formatNumber(detail.teLevel || 0));
    }
    stat('Time', formatDuration(detail.time));
    stat('Job Cost', formatISK(detail.jobCost));
    panel.appendChild(stats);

    panel.appendChild(el('div', 'mp-detail-heading', 'Direct Material Inputs'));
    const list = el('div', 'mp-detail-materials');
    (detail.materials || []).forEach((mat) => {
      const line = el('div', 'mp-detail-material');
      line.setAttribute('data-mp-detail-material', String(mat.typeId));
      line.appendChild(truncatedCell('mp-muted', mat.typeName));
      line.appendChild(el('span', 'mp-mono mp-right', `×${formatNumber(mat.quantity)}`));
      list.appendChild(line);
    });
    panel.appendChild(list);

    return panel;
  }

  /* ---------------------------------------------------------- products */

  async function loadProducts() {
    if (!state.planId) return;
    const products = await loadSafely('products', () =>
      window.electronAPI.plans.getProducts(state.planId)
    );
    state.products = products || [];

    const typeIds = state.products.map((p) => p.typeId);
    // getProducts returns type IDs only - and volumes are fetched for
    // MATERIALS elsewhere, so products need their own lookup or the Total m³
    // column reads as empty.
    await ensureNames(typeIds);
    if (typeIds.length > 0) {
      const volumes = await loadSafely('product volumes', () =>
        window.electronAPI.sde.getItemVolumes(typeIds)
      );
      Object.assign(state.volumes, volumes || {});
    }

    renderSafely('products', renderProducts);
  }

  function renderProducts() {
    const host = $('products-container');
    if (!host) return;
    host.textContent = '';

    if (state.products.length === 0) {
      host.appendChild(el('div', 'mp-pending', 'No products yet.'));
      return;
    }

    // Final products vs intermediates are listed separately: only a final
    // product is sold, so only it contributes revenue. An intermediate is a
    // cascading INPUT the plan consumes.
    const finals = state.products.filter((p) => !p.isIntermediate);
    const intermediates = state.products.filter((p) => p.isIntermediate);

    const section = (title, items, note) => {
      if (items.length === 0) return;
      const card = el('div', 'mp-section');
      card.appendChild(el('div', 'mp-card-accent'));

      const head = el('div', 'mp-section-head');
      head.appendChild(el('span', 'mp-section-title', title));
      head.appendChild(el('span', 'mp-section-count', items.length));
      if (note) head.appendChild(el('span', 'mp-buildlist-hint', note));
      card.appendChild(head);

      // Columns per the mockup: Product, Quantity, Total m³, Price, Total Value.
      const header = el('div', 'mp-product-row mp-build-header');
      ['Product', 'Quantity', 'Total m³', 'Price (Locked)', 'Total Value']
        .forEach((label, i) => {
          header.appendChild(el('span', i === 0 ? null : 'mp-right', label));
        });
      card.appendChild(header);

      let sectionTotal = 0;
      let sectionVolume = 0;

      items.forEach((product) => {
        const price = effectivePrice(product);
        const lineTotal = (price || 0) * (product.quantity || 0);
        const lineVolume = (state.volumes[product.typeId] || 0) * (product.quantity || 0);
        sectionTotal += lineTotal;
        sectionVolume += lineVolume;

        const row = el('div', 'mp-product-row');
        const name = el('span', 'mp-mat-name');
        name.appendChild(typeIcon(product.typeId));
        name.appendChild(truncatedCell(null, typeName(product.typeId)));
        row.appendChild(name);
        row.appendChild(el('span', 'mp-right mp-mono mp-muted', formatNumber(product.quantity)));
        row.appendChild(el(
          'span',
          'mp-right mp-mono mp-faint',
          lineVolume ? `${formatNumber(lineVolume, 2)} m³` : '—'
        ));

        const priceCell = el('span', 'mp-right mp-mono', formatISK(price));
        if (product.planOverridePrice !== null && product.planOverridePrice !== undefined) {
          priceCell.classList.add('mp-overridden');
          priceCell.title = `Plan override — market lock was ${formatISK(product.basePrice)}`;
        }
        row.appendChild(priceCell);

        row.appendChild(el('span', 'mp-right mp-mono', formatISK(lineTotal)));
        card.appendChild(row);
      });

      // Only FINAL products are revenue; totalling intermediates alongside
      // them would imply the plan sells what it consumes.
      const totalRow = el('div', 'mp-product-row mp-materials-total');
      totalRow.appendChild(el('span', 'mp-total-label', `Total ${title.toLowerCase()}`));
      totalRow.appendChild(el('span'));
      totalRow.appendChild(el(
        'span',
        'mp-right mp-mono mp-muted',
        sectionVolume ? `${formatNumber(sectionVolume, 2)} m³` : '—'
      ));
      totalRow.appendChild(el('span'));
      totalRow.appendChild(el('span', 'mp-right mp-mono mp-total-value', formatISK(sectionTotal)));
      card.appendChild(totalRow);

      host.appendChild(card);
    };

    section('Final Products', finals);
    section('Intermediate Components', intermediates, 'Consumed by this plan, not sold');
  }

  /* ------------------------------------------------------- jobs & matches */

  async function loadJobs() {
    if (!state.planId) return;

    const [pending, confirmed] = await Promise.all([
      loadSafely('pending matches', () =>
        window.electronAPI.plans.getPendingMatches(state.planId)
      ),
      loadSafely('confirmed job matches', () =>
        window.electronAPI.plans.getConfirmedJobMatches(state.planId)
      ),
    ]);

    state.pendingJobs = (pending && pending.jobMatches) || [];
    state.linkedJobs = confirmed || [];

    const allJobMatches = [...state.pendingJobs, ...state.linkedJobs];

    // Blueprint type ids live under `job`, and nothing resolves names for us.
    await ensureNames(allJobMatches.flatMap((m) => [
      m.job && m.job.blueprintTypeId,
      m.planBlueprint && m.planBlueprint.blueprintTypeId,
    ]));

    // Facility names come from the shared location resolver (SDE for NPC
    // stations, ESI for player structures, cached in main).
    await ensureFacilityNames(allJobMatches.map((m) => m.job));

    updateMatchBadges();
    renderSafely('jobs', renderJobs);
  }

  async function loadTransactions() {
    if (!state.planId) return;

    const [pending, confirmed] = await Promise.all([
      loadSafely('pending matches', () =>
        window.electronAPI.plans.getPendingMatches(state.planId)
      ),
      loadSafely('confirmed transaction matches', () =>
        window.electronAPI.plans.getConfirmedTransactionMatches(state.planId)
      ),
    ]);

    state.pendingTransactions = (pending && pending.transactionMatches) || [];
    state.linkedTransactions = confirmed || [];

    await ensureNames(
      [...state.pendingTransactions, ...state.linkedTransactions].map((m) => m.typeId)
    );

    updateMatchBadges();
    renderSafely('transactions', renderTransactions);
  }

  /**
   * Read just the pending counts, without the confirmed lists.
   *
   * Runs on plan load so the Jobs/Transactions badges are correct before those
   * tabs are ever opened - the badge is the only cue that a decision is
   * waiting.
   */
  async function loadPendingCounts() {
    const pending = await loadSafely('pending matches', () =>
      window.electronAPI.plans.getPendingMatches(state.planId)
    );
    state.pendingJobs = (pending && pending.jobMatches) || [];
    state.pendingTransactions = (pending && pending.transactionMatches) || [];
    updateMatchBadges();
  }

  /** Tab badges show how much is waiting for a decision. */
  function updateMatchBadges() {
    const jobsBadge = $('mp-jobs-badge');
    if (jobsBadge) {
      jobsBadge.hidden = state.pendingJobs.length === 0;
      jobsBadge.textContent = String(state.pendingJobs.length);
    }
    const txBadge = $('mp-transactions-badge');
    if (txBadge) {
      txBadge.hidden = state.pendingTransactions.length === 0;
      txBadge.textContent = String(state.pendingTransactions.length);
    }
  }

  /**
   * Confidence badge.
   *
   * Thresholds match the shared .confidence-badge scheme: a match is only
   * "high" when the heuristics broadly agree, and the number is shown so the
   * user can judge rather than trusting a colour.
   */
  function confidenceBadge(confidence) {
    const pct = Math.round((confidence || 0) * 100);
    const level = pct >= 80 ? 'high' : pct >= 50 ? 'medium' : 'low';
    const badge = el('span', `confidence-badge ${level}`, `${pct}%`);
    badge.title = `Match confidence: ${pct}%`;
    return badge;
  }

  function matchSection(title, count, countClass, rows, emptyText, columns, rowClass) {
    const card = el('div', 'mp-section');
    card.appendChild(el('div', 'mp-card-accent'));

    const head = el('div', 'mp-section-head');
    head.appendChild(el('span', 'mp-section-title', title));
    const badge = el('span', `mp-section-count ${countClass || ''}`.trim(), count);
    head.appendChild(badge);
    card.appendChild(head);

    if (rows.length === 0) {
      card.appendChild(el('div', 'mp-pending', emptyText));
      return card;
    }

    // Column headers, so the figures are identifiable without guessing.
    if (columns) {
      const header = el('div', `${rowClass} mp-build-header`);
      columns.forEach((col) => {
        header.appendChild(el('span', col.align ? `mp-${col.align}` : null, col.label));
      });
      card.appendChild(header);
    }

    rows.forEach((row) => card.appendChild(row));
    return card;
  }

  const JOB_COLUMNS = [
    { label: 'Blueprint' },
    { label: 'Character' },
    { label: 'Job ID' },
    { label: 'Runs', align: 'right' },
    { label: 'Status' },
    { label: 'Facility' },
    { label: 'Started' },
    { label: 'Conf.', align: 'center' },
    { label: 'Actions', align: 'right' },
  ];

  const TRANSACTION_COLUMNS = [
    { label: 'Item' },
    { label: 'Character' },
    { label: 'Tx ID' },
    { label: 'Date' },
    { label: 'Qty', align: 'right' },
    { label: 'Price', align: 'right' },
    { label: 'Total', align: 'right' },
    { label: 'Type' },
    { label: 'Conf.', align: 'center' },
    { label: 'Actions', align: 'right' },
  ];

  function renderJobs() {
    const host = $('jobs-container');
    if (!host) return;
    host.textContent = '';

    // Columns per the mockup: Blueprint, Character, Job ID, Runs, Status,
    // Facility, Started, Conf., Actions.
    //
    // Job identity lives under `match.job`; the plan side under
    // `match.planBlueprint`. Nothing is flattened.
    const jobRow = (match, linked) => {
      const job = match.job || {};
      const typeId = job.blueprintTypeId
        || (match.planBlueprint && match.planBlueprint.blueprintTypeId);

      const row = el('div', 'mp-job-row');
      row.setAttribute('data-mp-match-id', String(match.matchId));

      const name = el('span', 'mp-mat-name');
      if (typeId) name.appendChild(blueprintIcon(typeId));
      name.appendChild(truncatedCell(null, typeId ? typeName(typeId) : '—'));
      row.appendChild(name);

      row.appendChild(truncatedCell('mp-muted', job.characterName || '—'));
      row.appendChild(el('span', 'mp-mono mp-faint', job.jobId || '—'));
      row.appendChild(el('span', 'mp-right mp-mono mp-muted', formatNumber(job.runs)));

      const status = el('span', 'mp-job-status', job.status || match.status || '—');
      status.setAttribute('data-status', job.status || match.status || '');
      const statusCell = el('span');
      statusCell.appendChild(status);
      row.appendChild(statusCell);

      row.appendChild(truncatedCell('mp-muted mp-build-facility', facilityLabel(job)));

      row.appendChild(truncatedCell('mp-faint', formatDateTime(job.startDate)));

      if (linked) {
        row.appendChild(el('span', 'mp-center mp-faint', 'linked'));
      } else {
        const conf = el('span', 'mp-center');
        conf.appendChild(confidenceBadge(match.confidence));
        // The heuristics behind the score, so the number is auditable.
        if (match.matchReason) conf.title = match.matchReason;
        row.appendChild(conf);
      }

      const actions = el('span', 'mp-build-actions');
      if (linked) {
        const unlink = el('button', 'mp-link-action mp-link-danger', 'Unlink');
        unlink.type = 'button';
        unlink.addEventListener('click', () => decideJob(match, 'unlink'));
        actions.appendChild(unlink);
      } else {
        const confirm = el('button', 'mp-link-action', 'Confirm');
        confirm.type = 'button';
        confirm.addEventListener('click', () => decideJob(match, 'confirm'));
        const reject = el('button', 'mp-link-action mp-link-danger', 'Reject');
        reject.type = 'button';
        reject.addEventListener('click', () => decideJob(match, 'reject'));
        actions.appendChild(confirm);
        actions.appendChild(reject);
      }
      row.appendChild(actions);

      return row;
    };

    const pendingRows = state.pendingJobs.map((m) => jobRow(m, false));

    host.appendChild(matchSection(
      'Pending Job Matches',
      state.pendingJobs.length,
      'mp-count-warning',
      pendingRows,
      'No pending job matches. Click Match Jobs to scan your ESI industry jobs.',
      JOB_COLUMNS,
      'mp-job-row'
    ));

    const linkedRows = state.linkedJobs.map((m) => jobRow(m, true));

    if (state.linkedJobs.length > 0) {
      host.appendChild(matchSection(
        'Linked Jobs',
        state.linkedJobs.length,
        'mp-count-success',
        linkedRows,
        '',
        JOB_COLUMNS,
        'mp-job-row'
      ));
    }
  }

  function renderTransactions() {
    const host = $('transactions-container');
    if (!host) return;
    host.textContent = '';

    // Columns per the mockup: Item, Character, Tx ID, Date, Qty, Price,
    // Total, Type, Conf., Actions.
    const buildRow = (match, linked) => {
      // Transaction details nest under `match.transaction`; the match's own
      // typeId and quantity are top-level.
      const tx = match.transaction || {};
      const row = el('div', 'mp-tx-row');
      row.setAttribute('data-mp-match-id', String(match.matchId));

      const name = el('span', 'mp-mat-name');
      if (match.typeId) name.appendChild(typeIcon(match.typeId));
      name.appendChild(truncatedCell(null, match.typeId ? typeName(match.typeId) : '—'));
      row.appendChild(name);

      row.appendChild(truncatedCell('mp-muted', tx.characterName || '—'));
      row.appendChild(el('span', 'mp-mono mp-faint', match.transactionId || '—'));
      row.appendChild(truncatedCell('mp-faint', formatDateTime(tx.date)));
      row.appendChild(el('span', 'mp-right mp-mono mp-muted', formatNumber(match.quantity)));
      row.appendChild(el('span', 'mp-right mp-mono mp-muted', formatISK(tx.unitPrice)));

      // A BUY is money out, a SELL money in - coloured so the direction of
      // each line is readable at a glance.
      const isBuy = match.matchType === 'material_buy' || tx.isBuy;
      const total = Number.isFinite(tx.unitPrice)
        ? tx.unitPrice * (match.quantity || 0)
        : null;
      row.appendChild(el(
        'span',
        `mp-right mp-mono ${isBuy ? 'mp-negative' : 'mp-positive'}`,
        formatISK(total)
      ));

      const typeBadge = el('span', 'mp-tx-type', isBuy ? 'Buy' : 'Sell');
      typeBadge.setAttribute('data-tx-type', isBuy ? 'buy' : 'sell');
      const typeCell = el('span');
      typeCell.appendChild(typeBadge);
      row.appendChild(typeCell);

      if (linked) {
        row.appendChild(el('span', 'mp-center mp-faint', 'linked'));
      } else {
        const conf = el('span', 'mp-center');
        conf.appendChild(confidenceBadge(match.confidence));
        if (match.matchReason) conf.title = match.matchReason;
        row.appendChild(conf);
      }

      const actions = el('span', 'mp-build-actions');
      if (linked) {
        const unlink = el('button', 'mp-link-action mp-link-danger', 'Unlink');
        unlink.type = 'button';
        unlink.addEventListener('click', () => decideTransaction(match, 'unlink'));
        actions.appendChild(unlink);
      } else {
        const confirm = el('button', 'mp-link-action', 'Confirm');
        confirm.type = 'button';
        confirm.addEventListener('click', () => decideTransaction(match, 'confirm'));
        const reject = el('button', 'mp-link-action mp-link-danger', 'Reject');
        reject.type = 'button';
        reject.addEventListener('click', () => decideTransaction(match, 'reject'));
        actions.appendChild(confirm);
        actions.appendChild(reject);
      }
      row.appendChild(actions);
      return row;
    };

    host.appendChild(matchSection(
      'Pending Transaction Matches',
      state.pendingTransactions.length,
      'mp-count-warning',
      state.pendingTransactions.map((m) => buildRow(m, false)),
      'No pending transaction matches. Click Match Transactions to scan your ESI wallet.',
      TRANSACTION_COLUMNS,
      'mp-tx-row'
    ));

    if (state.linkedTransactions.length > 0) {
      host.appendChild(matchSection(
        'Linked Transactions',
        state.linkedTransactions.length,
        'mp-count-success',
        state.linkedTransactions.map((m) => buildRow(m, true)),
        '',
        TRANSACTION_COLUMNS,
        'mp-tx-row'
      ));
    }
  }

  async function decideJob(match, action) {
    const api = window.electronAPI.plans;
    const fn = action === 'confirm' ? api.confirmJobMatch
      : action === 'reject' ? api.rejectJobMatch
        : api.unlinkJobMatch;
    try {
      await fn(match.matchId);
      // Confirming a job changes what the plan has ACTUALLY done, so analytics
      // and the ledger-backed actuals are stale. Locked prices are not touched.
      await loadJobs();
      if (state.tab === 'analytics') await loadAnalytics();
    } catch (error) {
      console.error(`[plans] ${action} job match failed:`, error);
      toast(`Failed to ${action} match: ${error.message}`, 'error');
    }
  }

  async function decideTransaction(match, action) {
    const api = window.electronAPI.plans;
    const fn = action === 'confirm' ? api.confirmTransactionMatch
      : action === 'reject' ? api.rejectTransactionMatch
        : api.unlinkTransactionMatch;
    try {
      await fn(match.matchId);
      await loadTransactions();
      if (state.tab === 'analytics') await loadAnalytics();
    } catch (error) {
      console.error(`[plans] ${action} transaction match failed:`, error);
      toast(`Failed to ${action} match: ${error.message}`, 'error');
    }
  }

  async function runMatchJobs() {
    try {
      const matches = await window.electronAPI.plans.matchJobs(state.planId, {});
      if (matches && matches.length > 0) {
        await window.electronAPI.plans.saveJobMatches(matches);
      }
      await loadJobs();
      toast(
        matches && matches.length
          ? `Found ${matches.length} job match${matches.length === 1 ? '' : 'es'}.`
          : 'No new job matches found.',
        matches && matches.length ? 'success' : 'info'
      );
    } catch (error) {
      console.error('[plans] match jobs failed:', error);
      toast(`Failed to match jobs: ${error.message}`, 'error');
    }
  }

  async function runMatchTransactions() {
    try {
      const matches = await window.electronAPI.plans.matchTransactions(state.planId, {});
      if (matches && matches.length > 0) {
        await window.electronAPI.plans.saveTransactionMatches(matches);
      }
      await loadTransactions();
      toast(
        matches && matches.length
          ? `Found ${matches.length} transaction match${matches.length === 1 ? '' : 'es'}.`
          : 'No new transaction matches found.',
        matches && matches.length ? 'success' : 'info'
      );
    } catch (error) {
      console.error('[plans] match transactions failed:', error);
      toast(`Failed to match transactions: ${error.message}`, 'error');
    }
  }

  /* -------------------------------------------------------------- analytics */

  async function loadAnalytics() {
    if (!state.planId) return;

    // Cost by Category is built from the ledger, so Analytics needs it too -
    // otherwise that section is missing unless the user happened to visit the
    // Ledger tab first.
    const [analytics] = await Promise.all([
      loadSafely('analytics', () => window.electronAPI.plans.getAnalytics(state.planId)),
      state.ledger ? Promise.resolve() : loadLedger(),
    ]);

    state.analytics = analytics;
    renderSafely('analytics', renderAnalytics);
  }

  /**
   * Planned vs actual comparison.
   *
   * `betterWhenHigher` decides which direction is good: spending LESS than
   * planned is good, earning MORE than planned is good. Colouring both the
   * same way would mislead.
   */
  function comparisonCard(title, group, betterWhenHigher, options) {
    // ROI is a percentage, not ISK - formatting it as currency would read as
    // an amount of money.
    const format = (options && options.percent)
      ? (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : '—')
      : formatISK;

    const card = el('div', 'mp-card');
    card.appendChild(el('div', 'mp-card-accent'));
    const body = el('div', 'mp-card-body');

    body.appendChild(el('div', 'mp-stat-label', title));

    const rows = el('div', 'mp-compare-rows');
    const addRow = (label, value, cls) => {
      const row = el('div', 'mp-compare-row');
      row.appendChild(el('span', 'mp-muted', label));
      row.appendChild(el('span', `mp-mono ${cls || ''}`.trim(), format(value)));
      rows.appendChild(row);
    };

    addRow('Planned', group.planned);
    addRow('Actual', group.actual, 'mp-accent');

    const delta = group.delta || 0;
    const good = betterWhenHigher ? delta >= 0 : delta <= 0;
    const deltaRow = el('div', 'mp-compare-row mp-compare-delta');
    deltaRow.appendChild(el('span', 'mp-faint', 'Difference'));
    const deltaValue = el(
      'span',
      `mp-mono ${good ? 'mp-positive' : 'mp-negative'}`,
      `${delta >= 0 ? '+' : ''}${format(delta)}` +
      (!options?.percent && Number.isFinite(group.deltaPercent)
        ? ` (${group.deltaPercent.toFixed(1)}%)`
        : '')
    );
    deltaRow.appendChild(deltaValue);
    rows.appendChild(deltaRow);

    body.appendChild(rows);
    card.appendChild(body);
    return card;
  }

  /** One progress card: label, bar, and the figures behind it. */
  function progressCard(label, done, total, percent) {
    const card = el('div', 'mp-card');
    card.appendChild(el('div', 'mp-card-accent'));
    const body = el('div', 'mp-analytics-card-body');

    body.appendChild(el('div', 'mp-progress-card-label', label));

    const track = el('div', 'mp-progress-track');
    const fill = el('div', 'mp-progress-fill');
    // Clamped: over-acquisition exceeds 100% and would overflow the track.
    fill.style.width = `${Math.min(100, Math.max(0, percent || 0))}%`;
    track.appendChild(fill);
    body.appendChild(track);

    body.appendChild(el(
      'div',
      'mp-progress-card-value mp-mono',
      `${formatNumber(done)} / ${formatNumber(total)} · ${(percent || 0).toFixed(1)}%`
    ));

    card.appendChild(body);
    return card;
  }

  function renderAnalytics() {
    const host = $('mp-analytics');
    if (!host) return;
    host.textContent = '';

    if (!state.analytics) {
      host.appendChild(el('div', 'mp-pending', 'No analytics available yet.'));
      return;
    }

    const a = state.analytics;
    const progress = a.progress || {};

    /* ---- progress ---- */
    host.appendChild(el('div', 'mp-analytics-label', 'Progress'));

    const progressGrid = el('div', 'mp-analytics-grid');
    if (progress.jobs) {
      progressGrid.appendChild(progressCard(
        'Jobs completed', progress.jobs.completed, progress.jobs.total, progress.jobs.percent
      ));
    }
    if (progress.materials) {
      progressGrid.appendChild(progressCard(
        'Materials acquired',
        progress.materials.purchased,
        progress.materials.total,
        progress.materials.percent
      ));
    }
    if (progress.products) {
      progressGrid.appendChild(progressCard(
        'Products sold', progress.products.sold, progress.products.total, progress.products.percent
      ));
    }
    if (progress.overall !== undefined && progress.overall !== null) {
      progressGrid.appendChild(progressCard('Overall', null, null, progress.overall));
    }
    host.appendChild(progressGrid);

    /* ---- planned vs actual ---- */
    const headRow = el('div', 'mp-analytics-head');
    headRow.appendChild(el('span', 'mp-analytics-label', 'Planned vs Actual'));
    headRow.appendChild(el(
      'span',
      'mp-analytics-sub',
      'Locked estimate vs. recorded ESI jobs & wallet activity'
    ));
    host.appendChild(headRow);

    const grid = el('div', 'mp-analytics-grid');
    // Spending less than planned is GOOD; earning more is GOOD.
    if (a.materialCosts) grid.appendChild(comparisonCard('Material Cost', a.materialCosts, false));
    if (a.productValue) grid.appendChild(comparisonCard('Product Value', a.productValue, true));
    if (a.profit) grid.appendChild(comparisonCard('Profit', a.profit, true));

    // ROI arrives as two top-level numbers under `summary`, not as a
    // {planned, actual, delta} group like the others - so the group is built
    // here rather than read.
    if (a.summary) {
      const planned = a.summary.plannedROI;
      const actual = a.summary.actualROI;
      grid.appendChild(comparisonCard(
        'ROI',
        {
          planned,
          actual,
          delta: (Number.isFinite(actual) ? actual : 0) - (Number.isFinite(planned) ? planned : 0),
        },
        true,
        { percent: true }
      ));
    }

    host.appendChild(grid);

    /* ---- cost by category ----
       Built from the LEDGER, which is the record of what was actually spent.
       Only rendered when the ledger has been read; the Analytics payload
       carries no category breakdown of its own. */
    renderSafely('cost by category', renderCostByCategory);
  }

  function renderCostByCategory() {
    const host = $('mp-analytics');
    const totals = state.ledger && state.ledger.totals;
    if (!totals) return;

    const rows = [
      { name: 'Materials', value: totals.materialPurchases || 0 },
      { name: 'Job installation', value: totals.jobInstallation || 0 },
      { name: 'Market fees', value: totals.marketFees || 0 },
      { name: 'Other', value: totals.other || 0 },
    ].filter((r) => r.value > 0);

    if (rows.length === 0) return;

    const spend = rows.reduce((sum, r) => sum + r.value, 0);

    const card = el('div', 'mp-card');
    const head = el('div', 'mp-section-head');
    head.appendChild(el('span', 'mp-section-title', 'Cost by Category'));
    card.appendChild(head);

    const body = el('div', 'mp-cost-cat-body');
    rows.forEach((row) => {
      const percent = spend > 0 ? (row.value / spend) * 100 : 0;
      const item = el('div');

      const line = el('div', 'mp-cost-cat-line');
      line.appendChild(el('span', 'mp-cost-cat-name', row.name));
      const value = el('span', 'mp-cost-cat-value mp-mono', formatISK(row.value));
      value.appendChild(el('span', 'mp-faint', ` · ${percent.toFixed(1)}%`));
      line.appendChild(value);
      item.appendChild(line);

      const track = el('div', 'mp-progress-track');
      const fill = el('div', 'mp-progress-fill');
      fill.style.width = `${Math.min(100, percent)}%`;
      track.appendChild(fill);
      item.appendChild(track);

      body.appendChild(item);
    });

    card.appendChild(body);
    host.appendChild(card);
  }

  /* ----------------------------------------------------------------- ledger */

  /** Cost rows carry no item, so their category names them instead. */
  const LEDGER_CATEGORY_LABELS = {
    job_install: 'Job installation',
    broker_fee: "Broker's fee",
    sales_tax: 'Sales tax',
    job_tax: 'Job tax',
    shipping: 'Shipping',
    other: 'Other cost',
  };

  const LEDGER_SECTIONS = [
    { key: 'materialPurchases', title: 'Material Purchases', spend: true },
    { key: 'jobInstallation', title: 'Job Installation', spend: true },
    { key: 'marketFees', title: 'Market Fees', spend: true },
    { key: 'other', title: 'Other Costs', spend: true },
    { key: 'productSales', title: 'Product Sales', spend: false },
  ];

  async function loadLedger() {
    if (!state.planId) return;
    const ledger = await loadSafely('ledger', () =>
      window.electronAPI.plans.getLedger(state.planId)
    );
    state.ledger = ledger;

    // Ledger rows carry type ids only. Cost rows use type_id 0 (no item), so
    // filter those out rather than asking the SDE for type 0.
    if (ledger && ledger.categories) {
      const typeIds = Object.values(ledger.categories)
        .flatMap((group) => (group && group.items) || [])
        .map((entry) => entry.typeId)
        .filter((id) => id);
      await ensureNames(typeIds);
    }

    renderSafely('ledger', renderLedger);
  }

  function renderLedger() {
    const host = $('ledger-container');
    if (!host) return;
    host.textContent = '';

    const ledger = state.ledger;
    const totals = (ledger && ledger.totals) || {};
    const categories = (ledger && ledger.categories) || {};

    const hasAnything = LEDGER_SECTIONS.some(
      (s) => ((categories[s.key] && categories[s.key].items) || []).length > 0
    );

    if (!hasAnything) {
      const empty = el('div', 'mp-pending');
      empty.appendChild(el('div', null, 'No spend recorded yet.'));
      empty.appendChild(el(
        'div',
        'mp-faint',
        'Confirm purchase or job matches, or add a manual cost to start tracking spend.'
      ));
      host.appendChild(empty);
      return;
    }

    /* ---- summary cards ---- */
    const cards = el('div', 'mp-ledger-cards');
    const addCard = (label, value, tone, tag) => {
      const card = el('div', 'mp-card');
      card.appendChild(el('div', 'mp-card-accent'));
      const body = el('div', 'mp-ledger-card-body');
      const head = el('div', 'mp-stat-label', label);
      if (tag) head.appendChild(el('span', 'mp-ledger-tag', tag));
      body.appendChild(head);
      body.appendChild(el('div', `mp-ledger-value ${tone || ''}`.trim(), formatISK(value)));
      card.appendChild(body);
      cards.appendChild(card);
    };

    addCard('Materials', totals.materialPurchases);
    // Job installation may be ESTIMATED when no job rows exist yet - saying so
    // is the difference between a figure and a guess.
    addCard(
      'Job Installation',
      totals.jobInstallation,
      null,
      categories.jobInstallation && categories.jobInstallation.estimated ? 'est.' : null
    );
    addCard('Market Fees', totals.marketFees);
    addCard('Other', totals.other);
    addCard('Total Spend', totals.totalSpend, 'mp-negative');
    addCard('Product Sales', totals.productSales, 'mp-positive');
    host.appendChild(cards);

    /* ---- reconciliation ---- */
    const recon = (ledger && ledger.reconciliation) || {};
    if (recon.plannedCost !== null && recon.plannedCost !== undefined) {
      const bar = el('div', 'mp-recon');
      const planned = el('span', 'mp-muted', 'Planned cost ');
      planned.appendChild(el('span', 'mp-mono mp-strong', formatISK(recon.plannedCost)));
      bar.appendChild(planned);

      const actual = el('span', 'mp-muted', 'Actual spend ');
      actual.appendChild(el('span', 'mp-mono mp-strong', formatISK(recon.actualSpend)));
      bar.appendChild(actual);

      bar.appendChild(el('span', 'mp-spacer'));

      const delta = recon.delta || 0;
      // Spending MORE than planned is bad; under budget is good. Distinct from
      // the profit deltas on Analytics, where higher is better - the direction
      // depends on what is being measured.
      //
      // The dedicated class matters: this bar holds three .mp-mono spans
      // (planned, actual, delta) and only this one carries a verdict.
      const deltaSpan = el(
        'span',
        `mp-mono mp-recon-delta ${delta > 0 ? 'mp-negative' : 'mp-positive'}`,
        `Delta ${delta >= 0 ? '+' : ''}${formatISK(delta)}`
      );
      bar.appendChild(deltaSpan);
      host.appendChild(bar);
    }

    /* ---- sections ---- */
    LEDGER_SECTIONS.forEach((section) => {
      const group = categories[section.key];
      const items = (group && group.items) || [];
      if (items.length === 0) return;

      const card = el('div', 'mp-section');
      card.appendChild(el('div', 'mp-card-accent'));

      const head = el('div', 'mp-section-head');
      const left = el('span', 'mp-ledger-section-left');
      left.appendChild(el('span', 'mp-section-title', section.title));
      left.appendChild(el('span', 'mp-section-count', items.length));
      head.appendChild(left);
      head.appendChild(el(
        'span',
        `mp-mono mp-ledger-total ${section.spend ? 'mp-negative' : 'mp-positive'}`,
        formatISK(group.total)
      ));
      card.appendChild(head);

      const header = el('div', 'mp-ledger-row mp-build-header');
      ['Item', 'Detail', 'Amount', 'Note', 'Source', 'Actions'].forEach((label, i) => {
        header.appendChild(el('span', i === 2 || i === 5 ? 'mp-right' : null, label));
      });
      card.appendChild(header);

      items.forEach((entry) => {
        const row = el('div', 'mp-ledger-row');
        row.setAttribute('data-mp-ledger-id', String(entry.ledgerId));

        // A cost row has no item (type_id 0), so it is labelled by its
        // category instead of showing a blank cell.
        const name = el('span', 'mp-mat-name');
        if (entry.typeId) {
          name.appendChild(typeIcon(entry.typeId));
          name.appendChild(truncatedCell(null, typeName(entry.typeId)));
        } else {
          name.appendChild(truncatedCell(
            'mp-muted',
            LEDGER_CATEGORY_LABELS[entry.category] || section.title
          ));
        }
        row.appendChild(name);

        // Detail is the quantity × unit price breakdown behind the amount.
        // Cost rows have neither, so they show an em dash rather than "0 × —".
        const detail = entry.quantity
          ? `${formatNumber(entry.quantity)} × ${formatISK(entry.unitPrice)}`
          : '—';
        row.appendChild(truncatedCell('mp-muted', detail));

        row.appendChild(el(
          'span',
          `mp-right mp-mono ${section.spend ? '' : 'mp-positive'}`.trim(),
          formatISK(entry.amount)
        ));
        row.appendChild(truncatedCell('mp-faint', entry.note || '—'));

        // `editable` is the authority on whether a row is manual - it is true
        // when source_type is null OR 'manual'. Displaying `sourceType ||
        // 'manual'` made a null-source row READ as manual while the button
        // said "Unlink", because the label and the button consulted different
        // things. Both now derive from `editable`.
        const sourceLabel = entry.editable ? 'manual' : (entry.sourceType || 'esi');
        row.appendChild(el('span', 'mp-faint', sourceLabel));

        const actions = el('span', 'mp-build-actions');
        if (!entry.ledgerId) {
          // A DERIVED row (the job-install estimate) is not stored, so there
          // is nothing to remove or unlink - offering either would fail.
          actions.appendChild(el('span', 'mp-faint', 'estimated'));
        } else if (entry.editable) {
          const remove = el('button', 'mp-link-action mp-link-danger', 'Remove');
          remove.type = 'button';
          remove.addEventListener('click', () => unlinkLedgerEntry(entry));
          actions.appendChild(remove);
        } else {
          // An ESI-sourced row records something that happened; it is unlinked
          // from the plan rather than deleted.
          const unlink = el('button', 'mp-link-action mp-link-muted', 'Unlink');
          unlink.type = 'button';
          unlink.addEventListener('click', () => unlinkLedgerEntry(entry));
          actions.appendChild(unlink);
        }
        row.appendChild(actions);

        card.appendChild(row);
      });

      host.appendChild(card);
    });
  }

  async function unlinkLedgerEntry(entry) {
    try {
      await window.electronAPI.plans.unlinkLedgerEntry(entry.ledgerId);
      await loadLedger();
      // The ledger IS the actuals, so analytics is stale.
      if (state.tab === 'analytics') await loadAnalytics();
      toast('Ledger entry removed.', 'success');
    } catch (error) {
      console.error('[plans] unlink ledger entry failed:', error);
      toast(`Failed to remove entry: ${error.message}`, 'error');
    }
  }

  /* --------------------------------------------------------------- settings */

  async function loadSettings() {
    if (!state.planId) return;

    const [settings, characters, overrides] = await Promise.all([
      loadSafely('plan industry settings', () =>
        window.electronAPI.plans.getIndustrySettings(state.planId)
      ),
      loadSafely('characters', () => window.electronAPI.esi.getCharacters()),
      loadSafely('price overrides', () =>
        window.electronAPI.plans.getPriceOverrides(state.planId)
      ),
    ]);

    // Real corp division names, per character - the same source Settings >
    // Industry uses. Without this the grid shows "Division 1..7" even when the
    // corporation's actual names have been fetched.
    await Promise.all((characters || []).map(async (character) => {
      const divisionSettings = await loadSafely(
        `division names ${character.characterId}`,
        () => window.electronAPI.divisions.getSettings(character.characterId)
      );
      state.divisionNames[character.characterId] =
        (divisionSettings && divisionSettings.divisionNames) || {};
    }));

    state.planSettings = settings;
    state.overrides = overrides || [];

    // Overrides carry type ids only.
    await ensureNames(state.overrides.map((o) => o.typeId));

    const planNameEl = $('mp-settings-plan-name');
    if (planNameEl && state.plan) planNameEl.textContent = state.plan.planName;

    renderSafely('plan characters', () => renderPlanCharacters(characters || []));
    renderSafely('plan divisions', () => renderPlanDivisions(characters || []));
    renderSafely('reactions toggle', () => {
      const toggle = $('mp-reactions-as-intermediates');
      if (toggle && settings) toggle.checked = !!settings.reactionsAsIntermediates;
    });
    renderSafely('price overrides', renderPriceOverrides);
  }

  /**
   * Two INDEPENDENT axes per character: whose ASSETS this plan may use, and
   * whose BLUEPRINTS supply ME/TE. Ported from the plan Settings tab built
   * during the blueprint-source work - the grids must stay structurally
   * identical to Settings > Industry.
   */
  function renderPlanCharacters(characters) {
    const host = $('plan-default-characters-container');
    if (!host) return;
    host.textContent = '';

    const settings = state.planSettings || {};
    const assetIds = settings.defaultCharacters || [];
    const blueprintIds = settings.blueprintCharacters || [];

    if (characters.length === 0) {
      host.appendChild(el('div', 'mp-pending', 'No characters authenticated.'));
      return;
    }

    const grid = el('div', 'mp-axis-grid');

    const header = el('div', 'mp-axis-row mp-axis-head');
    header.appendChild(el('span'));
    header.appendChild(el('span', 'mp-axis-label', 'Assets'));
    header.appendChild(el('span', 'mp-axis-label', 'Blueprints'));
    grid.appendChild(header);

    characters.forEach((character) => {
      const row = el('div', 'mp-axis-row');
      row.setAttribute('data-mp-character', String(character.characterId));

      // Portrait + name, matching the redesign's character treatment.
      const nameCell = el('span', 'mp-axis-name');
      if (character.portrait) {
        const avatar = document.createElement('img');
        avatar.className = 'mp-axis-avatar';
        avatar.src = `${character.portrait}?size=64`;
        avatar.alt = '';
        avatar.addEventListener('error', () => { avatar.style.visibility = 'hidden'; });
        nameCell.appendChild(avatar);
      }
      nameCell.appendChild(truncatedCell(null, character.characterName));
      row.appendChild(nameCell);

      row.appendChild(axisCheckbox(
        'mp-axis-assets',
        assetIds.includes(character.characterId),
        (checked) => togglePlanCharacter('defaultCharacters', character.characterId, checked)
      ));
      row.appendChild(axisCheckbox(
        'mp-axis-blueprints',
        blueprintIds.includes(character.characterId),
        (checked) => togglePlanCharacter('blueprintCharacters', character.characterId, checked)
      ));

      grid.appendChild(row);
    });

    host.appendChild(grid);
  }

  function renderPlanDivisions(characters) {
    const host = $('plan-character-divisions-container');
    if (!host) return;
    host.textContent = '';

    const settings = state.planSettings || {};
    const assetDivisions = settings.enabledDivisions || {};
    const blueprintDivisions = settings.blueprintDivisions || {};

    if (characters.length === 0) {
      host.appendChild(el('div', 'mp-pending', 'No characters authenticated.'));
      return;
    }

    characters.forEach((character) => {
      const section = el('div', 'mp-division-section');
      section.setAttribute('data-mp-character', String(character.characterId));

      const charHead = el('div', 'mp-division-character');
      if (character.portrait) {
        const avatar = document.createElement('img');
        avatar.className = 'mp-axis-avatar';
        avatar.src = `${character.portrait}?size=64`;
        avatar.alt = '';
        avatar.addEventListener('error', () => { avatar.style.visibility = 'hidden'; });
        charHead.appendChild(avatar);
      }
      charHead.appendChild(el('span', null, character.characterName));

      // Names are cached with a TTL, so a way to re-fetch belongs here for the
      // same reason it exists on Settings > Industry.
      const refresh = el('button', 'mp-link-action mp-refresh-names', 'Refresh Names');
      refresh.type = 'button';
      refresh.setAttribute('data-mp-refresh-names', String(character.characterId));
      refresh.addEventListener('click', (e) => {
        e.stopPropagation();
        refreshDivisionNames(character.characterId);
      });
      charHead.appendChild(refresh);

      // A per-character summary of what is enabled, so the state is legible
      // without expanding every row.
      const charAssetCount = (assetDivisions[character.characterId] || []).length;
      const charBpCount = (blueprintDivisions[character.characterId] || []).length;
      charHead.appendChild(el('span', 'mp-spacer'));
      charHead.appendChild(el(
        'span',
        'mp-division-summary',
        charAssetCount + charBpCount === 0
          ? 'None selected'
          : `${charAssetCount} asset · ${charBpCount} blueprint`
      ));
      section.appendChild(charHead);

      const grid = el('div', 'mp-axis-grid');
      const header = el('div', 'mp-axis-row mp-axis-head');
      header.appendChild(el('span'));
      header.appendChild(el('span', 'mp-axis-label', 'Assets'));
      header.appendChild(el('span', 'mp-axis-label', 'Blueprints'));
      grid.appendChild(header);

      const charAssets = assetDivisions[character.characterId] || [];
      const charBlueprints = blueprintDivisions[character.characterId] || [];

      const charNames = state.divisionNames[character.characterId] || {};

      for (let division = 1; division <= 7; division += 1) {
        const row = el('div', 'mp-axis-row');
        row.setAttribute('data-mp-division', String(division));

        // A corporation's real division name when it has been fetched;
        // otherwise the generic label.
        const custom = charNames[division];
        const nameCell = el('span', 'mp-axis-name');
        nameCell.appendChild(truncatedCell(null, custom || `Division ${division}`));
        if (custom) {
          nameCell.appendChild(el('span', 'mp-custom-badge', 'Custom'));
        }
        row.appendChild(nameCell);

        row.appendChild(axisCheckbox(
          'mp-axis-assets',
          charAssets.includes(division),
          (checked) => togglePlanDivision('asset', character.characterId, division, checked)
        ));
        row.appendChild(axisCheckbox(
          'mp-axis-blueprints',
          charBlueprints.includes(division),
          (checked) => togglePlanDivision('blueprint', character.characterId, division, checked)
        ));

        grid.appendChild(row);
      }

      section.appendChild(grid);
      host.appendChild(section);
    });
  }

  /** Re-fetch a corporation's division names from ESI. */
  async function refreshDivisionNames(characterId) {
    try {
      const result = await window.electronAPI.divisions.fetchNames(characterId);
      if (result && result.success === false) {
        // The character may lack the Director role the endpoint requires -
        // worth saying plainly rather than failing silently.
        toast(result.error || 'Could not fetch division names.', 'warning');
        return;
      }
      await loadSettings();
      toast('Division names refreshed.', 'success');
    } catch (error) {
      console.error('[plans] refresh division names failed:', error);
      toast(`Failed to refresh division names: ${error.message}`, 'error');
    }
  }

  function axisCheckbox(cls, checked, onToggle) {
    const label = el('label', 'mp-axis-cell');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = cls;
    input.checked = !!checked;
    input.addEventListener('change', () => onToggle(input.checked));
    label.appendChild(input);
    return label;
  }

  async function togglePlanCharacter(field, characterId, enabled) {
    const settings = state.planSettings || {};
    const current = settings[field] || [];
    settings[field] = enabled
      ? current.concat(current.includes(characterId) ? [] : [characterId])
      : current.filter((id) => id !== characterId);
    state.planSettings = settings;

    try {
      await window.electronAPI.plans.updateIndustrySettings(state.planId, settings);
    } catch (error) {
      console.error('[plans] update plan characters failed:', error);
      toast('Failed to save character sources.', 'error');
    }
  }

  async function togglePlanDivision(axis, characterId, division, enabled) {
    const settings = state.planSettings || {};
    // The two axes write DIFFERENT fields - neither may touch the other's.
    const field = axis === 'blueprint' ? 'blueprintDivisions' : 'enabledDivisions';
    const byCharacter = settings[field] || {};
    const current = byCharacter[characterId] || [];

    byCharacter[characterId] = enabled
      ? current.concat(current.includes(division) ? [] : [division]).sort((a, b) => a - b)
      : current.filter((d) => d !== division);
    settings[field] = byCharacter;
    state.planSettings = settings;

    try {
      if (axis === 'blueprint') {
        await window.electronAPI.plans.updateCharacterBlueprintDivisions(
          state.planId,
          characterId,
          byCharacter[characterId]
        );
      } else {
        await window.electronAPI.plans.updateCharacterDivisions(
          state.planId,
          characterId,
          byCharacter[characterId]
        );
      }
    } catch (error) {
      console.error('[plans] update plan divisions failed:', error);
      toast('Failed to save division sources.', 'error');
    }
  }

  function trashIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', '3 6 5 6 21 6');
    const body = document.createElementNS(NS, 'path');
    body.setAttribute(
      'd',
      'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'
    );
    svg.appendChild(line);
    svg.appendChild(body);
    return svg;
  }

  function renderPriceOverrides() {
    const host = $('mp-price-overrides');
    if (!host) return;
    host.textContent = '';

    if (state.overrides.length === 0) {
      host.appendChild(el('div', 'mp-faint', 'No price overrides for this plan.'));
      return;
    }

    const header = el('div', 'mp-override-row mp-build-header');
    ['Item', 'Override', 'Market Lock', 'Drift', 'Updated', '']
      .forEach((label, i) => {
        header.appendChild(el('span', i >= 1 && i <= 3 ? 'mp-right' : null, label));
      });
    host.appendChild(header);

    state.overrides.forEach((override) => {
      const row = el('div', 'mp-override-row');
      row.setAttribute('data-mp-override-type', String(override.typeId));

      const name = el('span', 'mp-mat-name');
      name.appendChild(typeIcon(override.typeId));
      name.appendChild(truncatedCell(null, typeName(override.typeId)));
      row.appendChild(name);

      row.appendChild(el('span', 'mp-right mp-mono mp-overridden', formatISK(override.price)));

      // The market snapshot this override replaced, when one exists.
      const hasSnapshot = override.lastMarketPrice !== null
        && override.lastMarketPrice !== undefined;
      row.appendChild(el(
        'span',
        'mp-right mp-mono mp-faint',
        hasSnapshot ? formatISK(override.lastMarketPrice) : '—'
      ));

      // How far the pinned price sits from the market lock it replaced.
      // Without a snapshot there is no basis, so "—" rather than 0%.
      const driftCellEl = el('span', 'mp-right');
      if (hasSnapshot && override.lastMarketPrice !== 0) {
        const pct = ((override.price - override.lastMarketPrice) / override.lastMarketPrice) * 100;
        const badge = el('span', 'mp-drift', `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`);
        badge.classList.toggle('is-up', pct > 0.05);
        badge.classList.toggle('is-down', pct < -0.05);
        badge.classList.toggle('is-flat', Math.abs(pct) <= 0.05);
        driftCellEl.appendChild(badge);
      } else {
        driftCellEl.appendChild(el('span', 'mp-faint', '—'));
      }
      row.appendChild(driftCellEl);

      row.appendChild(truncatedCell('mp-faint', formatDateTime(override.updatedAt)));

      const actions = el('span', 'mp-build-actions');
      const remove = el('button', 'mp-icon-btn mp-icon-btn-danger');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove override for ${typeName(override.typeId)}`);
      remove.title = 'Remove override';
      remove.appendChild(trashIcon());
      remove.addEventListener('click', () => removeOverride(override));
      actions.appendChild(remove);
      row.appendChild(actions);

      host.appendChild(row);
    });
  }

  async function removeOverride(override) {
    try {
      await window.electronAPI.plans.removePriceOverride(state.planId, override.typeId);
      await loadSettings();
      // Removing an override restores the locked market snapshot, so the
      // materials figures change.
      await loadPlanData();
      toast('Price override removed.', 'success');
    } catch (error) {
      console.error('[plans] remove override failed:', error);
      toast(`Failed to remove override: ${error.message}`, 'error');
    }
  }

  /* ----------------------------------------------------------------- modals */

  /**
   * Modal-scoped QFSearchSelect instances.
   *
   * Kept separate from the row selects: a modal's dropdown is created on open
   * and must be destroyed on close, independently of the Build List re-render
   * cycle. Each owns a document listener and a body-mounted popover, so
   * hiding the modal is NOT enough.
   */
  let modalSelects = [];

  function destroyModalSelects() {
    modalSelects.forEach((sel) => {
      try {
        sel.destroy();
      } catch (error) {
        console.error('[plans] modal select destroy failed:', error);
      }
    });
    modalSelects = [];
  }

  function openModal(id) {
    const modal = $(id);
    if (modal) modal.hidden = false;
  }

  function closeModal(id) {
    const modal = $(id);
    if (modal) modal.hidden = true;
    // Every close path routes through here - X, Cancel, backdrop and Escape -
    // so the teardown cannot be skipped by closing a different way.
    destroyModalSelects();
    // Dropping the selection is what makes an in-flight asset lookup abandon
    // its render instead of painting into the next thing opened.
    if (id === 'mp-built-modal') state.builtBlueprint = null;
  }

  function closeAllModals() {
    // Through closeModal, not a bare hidden = true: this is one of the close
    // paths, and per-modal teardown must not depend on which one was used.
    ['mp-create-modal', 'mp-cost-modal', 'mp-acquire-modal', 'mp-blueprint-modal',
      'mp-built-modal']
      .forEach(closeModal);
  }

  /* ---- create plan ---- */

  function openCreateModal() {
    $('mp-create-name').value = '';
    $('mp-create-description').value = '';
    openModal('mp-create-modal');
  }

  async function confirmCreatePlan() {
    if (!state.characterId) {
      toast('Select a character first.', 'warning');
      return;
    }

    const name = $('mp-create-name').value.trim() || null;
    const description = $('mp-create-description').value.trim() || null;

    try {
      const created = await window.electronAPI.plans.create(state.characterId, name, description);
      closeModal('mp-create-modal');
      await loadPlans();
      if (created && created.planId) await selectPlan(created.planId);
      toast('Plan created.', 'success');
    } catch (error) {
      console.error('[plans] create plan failed:', error);
      toast(`Failed to create plan: ${error.message}`, 'error');
    }
  }

  /* ---- add cost ---- */

  function openCostModal() {
    $('mp-cost-category').value = 'other';
    $('mp-cost-amount').value = '';
    $('mp-cost-note').value = '';
    openModal('mp-cost-modal');
  }

  async function confirmAddCost() {
    const amount = parseFloat($('mp-cost-amount').value);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast('Enter an amount greater than zero.', 'warning');
      return;
    }

    try {
      await window.electronAPI.plans.addLedgerCost(state.planId, {
        category: $('mp-cost-category').value,
        amount,
        note: $('mp-cost-note').value.trim() || null,
      });
      closeModal('mp-cost-modal');
      await loadLedger();
      // The ledger IS the actuals behind Analytics.
      if (state.tab === 'analytics') await loadAnalytics();
      toast('Cost recorded.', 'success');
    } catch (error) {
      console.error('[plans] add cost failed:', error);
      toast(`Failed to add cost: ${error.message}`, 'error');
    }
  }

  /* ---- mark built ---- */

  async function openMarkBuiltModal(bp) {
    state.builtBlueprint = bp;

    const total = bp.runs || 0;
    $('mp-built-title').textContent = bp.builtRuns > 0 ? 'Edit Built Qty' : 'Mark Built';

    // The PRODUCT is what gets built and what the user holds in a hangar; the
    // blueprint is only how it is made.
    const productTypeId = bp.intermediateProductTypeId || bp.blueprintTypeId;

    const item = $('mp-built-item');
    item.textContent = '';
    item.appendChild(typeIcon(productTypeId));
    const meta = el('span', 'mp-built-item-meta');
    meta.appendChild(el('span', 'mp-built-item-name', typeName(productTypeId)));
    meta.appendChild(el(
      'span',
      'mp-built-item-total',
      `Total runs needed: ${formatNumber(total)}`
    ));
    item.appendChild(meta);

    const input = $('mp-built-runs');
    input.max = String(total);
    input.value = String(bp.builtRuns || 0);

    // Percentages rather than fixed counts, so the same five buttons work for
    // a 4-run job and a 4,000-run one.
    const quick = $('mp-built-quick');
    quick.textContent = '';
    [0, 25, 50, 75, 100].forEach((percent) => {
      const runs = Math.round((percent / 100) * total);
      const btn = el('button', 'btn btn-secondary mp-built-quick-btn', `${percent}%`);
      btn.type = 'button';
      btn.setAttribute('data-mp-built-quick', String(percent));
      btn.addEventListener('click', () => {
        input.value = String(runs);
        updateBuiltProgress();
      });
      quick.appendChild(btn);
    });

    updateBuiltProgress();
    // Render the modal before the assets land: the user came here to type a
    // number, and that must not wait on an asset query.
    $('mp-built-assets').textContent = '';
    openModal('mp-built-modal');

    await renderBuiltOwnedAssets(productTypeId);
  }

  /**
   * "How many do I already have?" - the question that decides what to enter.
   *
   * Scoped to the plan's own configured sources, so it reflects the hangars
   * this plan actually draws from rather than every asset the user owns.
   */
  async function renderBuiltOwnedAssets(productTypeId) {
    const host = $('mp-built-assets');
    if (!host) return;

    const owned = await loadSafely('product owned assets', () =>
      window.electronAPI.plans.getProductOwnedAssets(state.planId, productTypeId)
    );
    if (!owned) return;

    // A late response for a modal the user already closed, or reopened on a
    // different item, must not overwrite what is on screen now.
    const current = state.builtBlueprint;
    if (!current) return;
    const currentProduct = current.intermediateProductTypeId || current.blueprintTypeId;
    if (currentProduct !== productTypeId) return;

    host.textContent = '';

    const totalOwned = (owned.ownedPersonal || 0) + (owned.ownedCorp || 0);
    const head = el('div', 'mp-built-assets-head');
    head.appendChild(el('span', 'mp-field-label', 'Owned assets'));
    head.appendChild(el('span', 'mp-mono mp-built-owned-total', formatNumber(totalOwned)));
    host.appendChild(head);

    const personal = owned.personalDetails || [];
    const corp = owned.corpDetails || [];

    if (personal.length === 0 && corp.length === 0) {
      host.appendChild(el(
        'div',
        'mp-faint mp-built-no-assets',
        'No assets found in this plan’s configured hangars.'
      ));
      return;
    }

    const group = (label, rows) => {
      if (rows.length === 0) return;
      host.appendChild(el('div', 'mp-built-assets-group', label));
      rows.forEach((row) => {
        const line = el('div', 'mp-built-asset-row');
        line.appendChild(truncatedCell('mp-muted', row.name));
        line.appendChild(el('span', 'mp-mono mp-right', formatNumber(row.quantity)));
        host.appendChild(line);
      });
    };

    group(
      `Personal hangars (${formatNumber(owned.ownedPersonal || 0)})`,
      personal.map((d) => ({ name: d.characterName, quantity: d.quantity }))
    );
    group(
      `Corporation hangars (${formatNumber(owned.ownedCorp || 0)})`,
      corp.map((d) => ({
        name: `${d.corporationName} – ${d.divisionName}`,
        quantity: d.quantity,
      }))
    );
  }

  function updateBuiltProgress() {
    const bp = state.builtBlueprint;
    if (!bp) return;
    const total = bp.runs || 0;
    const runs = Number($('mp-built-runs').value) || 0;
    const pct = total > 0 ? Math.round((Math.min(runs, total) / total) * 100) : 0;
    $('mp-built-pct').textContent = `${pct}%`;
    $('mp-built-bar-fill').style.width = `${pct}%`;
  }

  async function confirmMarkBuilt() {
    const bp = state.builtBlueprint;
    if (!bp) return;

    const total = bp.runs || 0;
    const runs = Number($('mp-built-runs').value);

    // Main validates this too and throws, but a rejected save reads as a
    // failure rather than as "that number is out of range".
    if (!Number.isFinite(runs) || runs < 0 || runs > total) {
      toast(`Enter a number of runs between 0 and ${formatNumber(total)}.`, 'warning');
      return;
    }

    try {
      // markIntermediateBuilt and markReactionBuilt each reject the other's
      // type outright, so the blueprint's own type decides which one applies.
      if (bp.blueprintType === 'reaction') {
        await window.electronAPI.plans.markReactionBuilt(bp.planBlueprintId, runs);
      } else {
        await window.electronAPI.plans.markIntermediateBuilt(bp.planBlueprintId, runs);
      }

      closeModal('mp-built-modal');

      // Marking runs built credits the materials they consumed, so the
      // materials and summary are stale the moment this succeeds.
      // loadPlanData refreshes both, and the reactions tab with them.
      await loadBlueprintsTab();
      await loadPlanData();
      toast('Built quantity updated.', 'success');
    } catch (error) {
      console.error('[plans] mark built failed:', error);
      toast(`Failed to update built quantity: ${error.message}`, 'error');
    }
  }

  /* ---- acquire item ---- */

  function openAcquireModal() {
    $('mp-acquire-quantity').value = '';
    $('mp-acquire-price').value = '';
    $('mp-acquire-note').value = '';
    state.acquireTypeId = null;

    const host = $('mp-acquire-host');
    if (host && window.QFSearchSelect) {
      host.textContent = '';
      // Only this plan's materials can be acquired for it, so the list is the
      // plan's own materials rather than a global item search.
      const sel = new window.QFSearchSelect(host, {
        options: state.materials.map((mat) => ({
          value: String(mat.typeId),
          label: state.names[mat.typeId] || `Type ${mat.typeId}`,
        })),
        placeholder: 'Select a material…',
        onChange: (e) => { state.acquireTypeId = parseInt(e.target.value, 10); },
      });
      modalSelects.push(sel);
    }

    openModal('mp-acquire-modal');
  }

  async function confirmAcquire() {
    if (!state.acquireTypeId) {
      toast('Select a material.', 'warning');
      return;
    }
    const quantity = parseInt($('mp-acquire-quantity').value, 10);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      toast('Enter a quantity greater than zero.', 'warning');
      return;
    }

    const priceInput = $('mp-acquire-price').value.trim();
    const unitPrice = priceInput === '' ? null : parseFloat(priceInput);

    try {
      await window.electronAPI.plans.addItemAcquisition(state.planId, state.acquireTypeId, {
        quantity,
        unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
        note: $('mp-acquire-note').value.trim() || null,
      });
      closeModal('mp-acquire-modal');
      await loadLedger();
      // Acquiring changes what is still needed on the shopping list.
      await loadPlanData();
      toast('Acquisition recorded.', 'success');
    } catch (error) {
      // The backend rejects over-acquiring, and that message is worth showing
      // verbatim rather than replacing with something generic.
      console.error('[plans] acquire failed:', error);
      toast(`Failed to record: ${error.message}`, 'error');
    }
  }

  /* ---- add blueprint ---- */

  function openBlueprintModal() {
    $('mp-blueprint-runs').value = '1';
    $('mp-blueprint-lines').value = '1';
    $('mp-blueprint-me').value = '0';
    $('mp-blueprint-te').value = '0';
    $('mp-blueprint-owned-note').hidden = true;
    $('mp-blueprint-runs-note').hidden = true;
    state.blueprintTypeId = null;

    const host = $('mp-blueprint-host');
    if (host && window.QFSearchSelect) {
      host.textContent = '';
      const sel = new window.QFSearchSelect(host, {
        onSearch: async (query) => {
          const results = await window.electronAPI.calculator.searchBlueprints(query, 50);
          return (results || []).map((bp) => ({
            value: String(bp.typeID),
            label: bp.typeName,
          }));
        },
        minQueryLength: 2,
        debounceMs: 300,
        placeholder: 'Search blueprints…',
        searchPrompt: 'Type at least 2 characters',
        emptyText: 'No blueprints found',
        onChange: async (e) => {
          state.blueprintTypeId = parseInt(e.target.value, 10);
          await applyOwnedBlueprintDefaults(state.blueprintTypeId);
        },
      });
      modalSelects.push(sel);
    }

    updateRunsPerLine();
    openModal('mp-blueprint-modal');
  }

  /**
   * Seed ME/TE from the best owned blueprint, per the source rules.
   *
   * Same resolver the Blueprint Calculator uses: BPO before BPC, then highest
   * ME, across every enabled blueprint source. Defaulting to 0 when the user
   * owns an ME 10 copy would silently overstate the plan's material cost.
   */
  async function applyOwnedBlueprintDefaults(blueprintTypeId) {
    const owned = await loadSafely('owned blueprint', () =>
      window.electronAPI.calculator.resolveOwnedBlueprint(blueprintTypeId)
    );

    const meInput = $('mp-blueprint-me');
    const teInput = $('mp-blueprint-te');
    const note = $('mp-blueprint-owned-note');

    if (owned) {
      meInput.value = Number.isFinite(owned.me) ? owned.me : 0;
      teInput.value = Number.isFinite(owned.te) ? owned.te : 0;
      if (note) {
        note.hidden = false;
        note.textContent = owned.isCopy
          ? `From your owned BPC (ME ${owned.me} / TE ${owned.te})`
          : `From your owned BPO (ME ${owned.me} / TE ${owned.te})`;
      }
    } else {
      meInput.value = '0';
      teInput.value = '0';
      if (note) {
        note.hidden = false;
        note.textContent = 'You do not own this blueprint — defaulting to ME 0 / TE 0.';
      }
    }
  }

  /**
   * Runs are split across production lines, so what matters for scheduling is
   * runs PER LINE - 30 runs over 3 lines is 10 each.
   */
  function runsPerLine(runs, lines) {
    const r = Number(runs) || 0;
    const l = Number(lines) || 1;
    if (l <= 1) return null;
    return r / l;
  }

  function updateRunsPerLine() {
    const note = $('mp-blueprint-runs-note');
    if (!note) return;
    const perLine = runsPerLine($('mp-blueprint-runs').value, $('mp-blueprint-lines').value);
    note.hidden = perLine === null;
    if (perLine !== null) {
      note.textContent = `${formatNumber(perLine, perLine % 1 === 0 ? 0 : 1)} runs per line`;
    }
  }

  async function confirmAddBlueprint() {
    if (!state.blueprintTypeId) {
      toast('Select a blueprint.', 'warning');
      return;
    }

    try {
      await window.electronAPI.plans.addBlueprint(state.planId, {
        blueprintTypeId: state.blueprintTypeId,
        runs: parseInt($('mp-blueprint-runs').value, 10) || 1,
        // The handler destructures `lines`. Sent as `productionLines` this
        // was never read, so the Production Lines input silently did nothing
        // and every blueprint went in on a single line.
        lines: parseInt($('mp-blueprint-lines').value, 10) || 1,
        meLevel: parseInt($('mp-blueprint-me').value, 10) || 0,
        teLevel: parseInt($('mp-blueprint-te').value, 10) || 0,
      });
      closeModal('mp-blueprint-modal');
      await loadPlanData();
      await loadBlueprintsTab();
      toast('Blueprint added.', 'success');
    } catch (error) {
      console.error('[plans] add blueprint failed:', error);
      toast(`Failed to add blueprint: ${error.message}`, 'error');
    }
  }

  /* ------------------------------------------------------------------ tabs */

  function showTab(tab) {
    state.tab = tab;

    document.querySelectorAll('#mp-view .tab-button').forEach((btn) => {
      const active = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    document.querySelectorAll('#mp-view .tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `${tab}-tab`);
    });

    // Tabs load their data on first open rather than up front - the Build List
    // and tree are expensive and most sessions never open them.
    if (!state.planId) return;
    if (tab === 'build-list') loadBuildList();
    else if (tab === 'blueprints') loadBlueprintsTab();
    // The reaction rows are already loaded (the tab's visibility depends on
    // them); opening the tab is what buys the input trees.
    else if (tab === 'reactions') loadReactionTrees();
    else if (tab === 'blueprint-tree') loadTree();
    else if (tab === 'products') loadProducts();
    else if (tab === 'jobs') loadJobs();
    else if (tab === 'transactions') loadTransactions();
    else if (tab === 'analytics') loadAnalytics();
    else if (tab === 'ledger') loadLedger();
    else if (tab === 'settings') loadSettings();
  }

  /* -------------------------------------------------------------- mounting */

  async function mount(container, params, ctx) {
    const fragment = await loadTemplate();
    if (!fragment) {
      container.appendChild(el('div', 'empty-state', 'Failed to load Manufacturing Plans.'));
      return {};
    }
    container.appendChild(fragment);

    searchSelects = [];

    await initCharacters();
    await initMarketSet();

    /* ---- sidebar ---- */
    ctx.on($('plan-search'), 'input', (e) => {
      state.search = e.target.value;
      renderPlansList();
    });

    document.querySelectorAll('#mp-status-filters .mp-status-filter').forEach((btn) => {
      ctx.on(btn, 'click', () => {
        state.statusFilter = btn.getAttribute('data-mp-status');
        document.querySelectorAll('#mp-status-filters .mp-status-filter').forEach((b) => {
          b.classList.toggle('is-active', b === btn);
        });
        renderPlansList();
      });
    });

    /* ---- plan header ---- */
    ctx.on($('mp-recalc-all'), 'click', () => rebuildPlan());
    ctx.on($('mp-complete-plan'), 'click', () => togglePlanComplete());
    ctx.on($('delete-plan-btn'), 'click', () => deleteCurrentPlan());
    ctx.on($('mp-rename-plan'), 'click', () => openRenamePlan());
    ctx.on($('mp-rename-confirm'), 'click', () => confirmRenamePlan());

    /* ---- tabs ---- */
    document.querySelectorAll('#mp-view .tab-button').forEach((btn) => {
      ctx.on(btn, 'click', () => showTab(btn.getAttribute('data-tab')));
    });

    /* ---- materials ---- */
    ctx.on($('mp-show-owned'), 'change', async (e) => {
      state.showOwned = e.target.checked;
      await loadPlanData();
    });

    ctx.on($('mp-drift-review'), 'click', () => showTab('materials'));
    ctx.on($('mp-relock'), 'click', () => relockAllPrices());

    /* ---- build list ---- */
    ctx.on($('mp-bulk-edit'), 'click', () => {
      state.bulkEdit = true;
      state.editingRow = null;
      setBulkChrome();
      renderBuildList();
    });

    ctx.on($('mp-bulk-cancel'), 'click', () => {
      // Cancel is a genuine discard - edits were never written.
      state.bulkEdit = false;
      state.buildEdits = {};
      setBulkChrome();
      renderBuildList();
    });

    ctx.on($('mp-bulk-save'), 'click', () => saveBulkEdits());

    /* ---- matching ---- */
    ctx.on($('mp-match-jobs'), 'click', () => runMatchJobs());
    ctx.on($('mp-match-transactions'), 'click', () => runMatchTransactions());

    /* ---- settings ---- */
    ctx.on($('mp-reactions-as-intermediates'), 'change', async (e) => {
      const settings = state.planSettings || {};
      settings.reactionsAsIntermediates = e.target.checked;
      state.planSettings = settings;
      try {
        await window.electronAPI.plans.updateIndustrySettings(state.planId, settings);
        // This changes whether reactions expand into intermediates, so what the
        // plan NEEDS changes. Locked prices are untouched.
        await loadPlanData();
        await loadReactionsTab();
      } catch (error) {
        console.error('[plans] update reactions setting failed:', error);
        toast('Failed to save reactions setting.', 'error');
      }
    });

    /* ---- modals ---- */
    ctx.on($('mp-new-plan'), 'click', openCreateModal);
    ctx.on($('mp-create-confirm'), 'click', () => confirmCreatePlan());
    ctx.on($('mp-add-cost'), 'click', openCostModal);
    ctx.on($('mp-cost-confirm'), 'click', () => confirmAddCost());
    ctx.on($('mp-acquire-item'), 'click', openAcquireModal);
    ctx.on($('mp-acquire-confirm'), 'click', () => confirmAcquire());
    ctx.on($('add-blueprint-btn'), 'click', openBlueprintModal);
    ctx.on($('mp-blueprint-confirm'), 'click', () => confirmAddBlueprint());
    ctx.on($('mp-blueprint-runs'), 'input', updateRunsPerLine);
    ctx.on($('mp-blueprint-lines'), 'input', updateRunsPerLine);
    ctx.on($('mp-built-confirm'), 'click', () => confirmMarkBuilt());
    ctx.on($('mp-built-runs'), 'input', updateBuiltProgress);

    // Every close affordance routes through closeModal so the dropdown
    // teardown cannot be bypassed - closing via X, Cancel, backdrop or Escape
    // must all dispose the same way.
    document.querySelectorAll('#mp-view [data-mp-close]').forEach((btn) => {
      ctx.on(btn, 'click', () => closeModal(btn.getAttribute('data-mp-close')));
    });

    document.querySelectorAll('#mp-view .modal').forEach((modal) => {
      ctx.on(modal, 'click', (e) => {
        if (e.target === modal) closeModal(modal.id);
      });
    });

    ctx.on(document, 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelector('#mp-view .modal:not([hidden])');
      if (open) closeModal(open.id);
    });

    // Unmount must not leave a popover attached to <body>.
    ctx.track(() => destroyModalSelects());

    /* ---- live data ---- */
    ctx.track(
      window.electronAPI.esi.onDefaultCharacterChanged(async () => {
        // The open plan belongs to the OLD character, so it goes with them.
        clearPlanSelection();
        await initCharacters();
        await loadPlans();
      })
    );

    await loadPlans();

    // Opened with a specific plan (e.g. from the dashboard).
    if (params && params.planId) {
      await selectPlan(params.planId);
    }

    return {
      destroy: destroySearchSelects,

      /**
       * State to carry into a popped-out window: which character, which plan,
       * which tab.
       *
       * Deliberately NOT the tab's DATA. Every tab lazy-loads on open
       * (`showTab` drives loadBuildList / loadTree / loadLedger and the rest),
       * and those reads are per-plan database queries rather than the
       * multi-second market sweeps the other screens carry. Re-driving the load
       * also guarantees the popped window shows current data rather than a
       * snapshot that a job or transaction may already have invalidated.
       */
      getHandoff() {
        if (!state.characterId && !state.planId) return null;
        return {
          characterId: state.characterId,
          planId: state.planId,
          tab: state.tab,
        };
      },

      /**
       * Adopt a popped-out window's character, plan and tab.
       *
       * Order matters: the character owns the plan list, so it must be set and
       * its plans loaded before a plan id can resolve - and the tab is restored
       * last, because selectPlan renders the detail pane on the default tab.
       */
      async applyHandoff(payload) {
        if (!payload) return;

        if (payload.characterId && payload.characterId !== state.characterId) {
          state.characterId = payload.characterId;

          // Drive the CONTROL too. The picker is seeded from the DEFAULT
          // character on mount, so setting state alone leaves it naming
          // someone else while the plans below belong to this one.
          const entry = searchSelects.find((s) => s.host === $('mp-character-host'));
          if (entry) entry.sel.setValue(String(payload.characterId));

          renderCharacterPortrait();
          await loadPlans();
        }

        if (payload.planId) {
          await selectPlan(payload.planId);
        }

        // Last: selectPlan renders the detail pane on whatever tab is current,
        // and showTab is what triggers the chosen tab's lazy load.
        if (payload.tab) showTab(payload.tab);
      },
    };
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('manufacturing-plans', {
      title: 'Manufacturing Plans',
      mount,
    });
  }
})();
