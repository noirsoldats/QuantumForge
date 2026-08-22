/**
 * Blueprint Manager — native shell view.
 *
 * Ported from "Character Blueprints (1a).dc.html". Replaces the flat list in
 * blueprints-renderer.js with grouped cards, inline ME/TE editing, faceted
 * filtering and a summary strip.
 *
 * Behaviours carried over from the live screen (all still here):
 *   - identical blueprints GROUPED, keyed on typeId + BPO/BPC + runs +
 *     EFFECTIVE ME/TE, expandable to the individual copies
 *   - ME/TE overrides, where setting a value back to the blueprint's real value
 *     removes the override rather than storing a redundant one
 *   - manual blueprint add via SDE search, and per-copy removal
 *   - Originals/Copies/Overridden/Manual and Character/Corporation filters,
 *     with the same precedence: ownership first, then status, then type
 *   - corp ownership inferred from `isCorporation` OR a CorpSAG/CorpDeliveries
 *     location flag - ESI does not always set the former
 *   - search by blueprint name OR type id
 *   - Refresh from API with a cache countdown on the button
 *
 * The mockup puts the ME/TE editors on the GROUP. A group shares one effective
 * ME/TE by definition, so an edit there fans out to every copy in it - see
 * setGroupEfficiency.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------- state

  const state = {
    characterId: null,
    character: null,
    blueprints: [],
    loading: true,

    query: '',
    type: { bpo: true, bpc: true, overridden: false, manual: false },
    own: { character: true, corporation: false },
    expanded: {},

    addQuery: '',
    addResults: [],
    addSearchToken: 0,
    pendingDelete: null,
  };

  let els = {};
  let cacheCountdown = null;
  let cacheLabel = null;
  let addSearchTimer = null;

  /** ESI caps ME at 10 and TE at 20. */
  const MAX_ME = 10;
  const MAX_TE = 20;

  // ------------------------------------------------------------ formatting

  function fmtNumber(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
  }

  // --------------------------------------------------------------- helpers

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function svg(children, size, extraClass) {
    const ns = 'http://www.w3.org/2000/svg';
    const node = document.createElementNS(ns, 'svg');
    node.setAttribute('width', size);
    node.setAttribute('height', size);
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.8');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    if (extraClass) node.setAttribute('class', extraClass);
    children.forEach(([tag, attrs]) => {
      const child = document.createElementNS(ns, tag);
      Object.entries(attrs).forEach(([k, v]) => child.setAttribute(k, v));
      node.appendChild(child);
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
   * per-type method. Calling one is a silent TypeError.
   */
  function toast(message, type = 'info') {
    if (window.QFToast && typeof window.QFToast.show === 'function') {
      window.QFToast.show(message, type);
    } else {
      console.log(`[blueprints] ${message}`);
    }
  }

  /**
   * Full location breadcrumb for one blueprint: "Cargo → Golem → Sotiyo".
   *
   * Resolved locations are cached per location id and shared by everything
   * there, but `location_flag` belongs to the ITEM ("Cargo", "CorpSAG2"), so
   * the innermost hop can only be completed here.
   *
   * Only the ITEM's flag appears - naming the containers already says where it
   * is, and interleaving their own flags produced confusing repetition.
   * A blueprint sitting directly in a station gets just the station, with no
   * misleading "Hangar → " prefix.
   *
   * Mirrors buildChainLabel() in location-resolver.js and the Assets view;
   * keep the three in step.
   */
  function buildChainLabel(locationInfo, itemFlag) {
    if (!locationInfo) return 'Unknown location';

    const place = locationInfo.stationName || locationInfo.systemName || 'Unknown location';
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

  // ------------------------------------------------------------ data model

  /**
   * Corporation ownership.
   *
   * ESI does not always set `isCorporation`, so the location flag is the
   * fallback the live screen relies on - corp hangar divisions are CorpSAG1-7
   * and deliveries are CorpDeliveries.
   */
  function isCorporationBlueprint(bp) {
    if (bp.isCorporation) return true;
    const flag = bp.locationFlag || '';
    return flag.startsWith('CorpSAG') || flag.startsWith('CorpDeliveries');
  }

  function isManualBlueprint(bp) {
    return !!bp.manuallyAdded || bp.source === 'manual';
  }

  /** Effective ME/TE, where an override wins over the stored value. */
  function effectiveValues(bp) {
    const overrides = bp.overrides || {};
    const hasMe = overrides.materialEfficiency !== undefined;
    const hasTe = overrides.timeEfficiency !== undefined;
    return {
      me: hasMe ? overrides.materialEfficiency : bp.materialEfficiency,
      te: hasTe ? overrides.timeEfficiency : bp.timeEfficiency,
      hasMeOverride: hasMe,
      hasTeOverride: hasTe,
    };
  }

  async function loadBlueprints() {
    state.loading = true;
    render();

    let rows = [];
    try {
      rows = await window.electronAPI.blueprints.getAll(state.characterId);
    } catch (error) {
      console.error('[blueprints] Could not load blueprints:', error);
      rows = [];
    }

    rows = Array.isArray(rows) ? rows : [];

    // Names and locations: TWO batched calls for the whole set, whatever its
    // size. A character can hold thousands of blueprints, so a per-blueprint
    // lookup is the pattern that made the Assets screen exhaust ESI's error
    // budget. location.resolveMany dedupes by location id in main.
    let names = {};
    let locations = {};

    if (rows.length > 0) {
      const typeIds = [...new Set(rows.map((bp) => bp.typeId))];

      // Corp blueprints live in the corporation asset scope, so they resolve
      // against a different asset tree than personal ones.
      const personalLocationIds = rows.filter((bp) => !isCorporationBlueprint(bp))
        .map((bp) => bp.locationId);
      const corpLocationIds = rows.filter((bp) => isCorporationBlueprint(bp))
        .map((bp) => bp.locationId);

      const [nameResult, personalLocations, corpLocations] = await Promise.all([
        window.electronAPI.sde.getBlueprintNames(typeIds).catch((error) => {
          console.error('[blueprints] Could not load blueprint names:', error);
          return {};
        }),
        personalLocationIds.length
          ? window.electronAPI.location.resolveMany(personalLocationIds, state.characterId, false)
            .catch((error) => {
              console.error('[blueprints] Could not resolve locations:', error);
              return {};
            })
          : Promise.resolve({}),
        corpLocationIds.length
          ? window.electronAPI.location.resolveMany(corpLocationIds, state.characterId, true)
            .catch((error) => {
              console.error('[blueprints] Could not resolve corp locations:', error);
              return {};
            })
          : Promise.resolve({}),
      ]);

      names = nameResult;
      locations = { personal: personalLocations, corp: corpLocations };
    }

    const UNKNOWN_LOCATION = {
      systemName: 'Unknown', stationName: 'Unknown',
      containerNames: [], containerPath: [], fullPath: 'Unknown location',
      locationType: 'error',
    };

    state.blueprints = rows.map((bp) => {
      const eff = effectiveValues(bp);
      const isCorp = isCorporationBlueprint(bp);
      const scope = isCorp ? (locations.corp || {}) : (locations.personal || {});
      const locationInfo = scope[bp.locationId] || UNKNOWN_LOCATION;

      return {
        ...bp,
        blueprintName: names[bp.typeId] || `Blueprint ${bp.typeId}`,
        locationInfo,
        // Full breadcrumb for the tooltip: "Cargo → Golem → Sotiyo". Built per
        // blueprint because location_flag belongs to the item, while
        // locationInfo is cached per location and shared by everything there.
        chainLabel: buildChainLabel(locationInfo, bp.locationFlag),
        effectiveMe: eff.me,
        effectiveTe: eff.te,
        hasMeOverride: eff.hasMeOverride,
        hasTeOverride: eff.hasTeOverride,
        hasOverride: eff.hasMeOverride || eff.hasTeOverride,
        isCorpOwned: isCorp,
        isManual: isManualBlueprint(bp),
      };
    });

    state.loading = false;
    render();
  }

  // ---------------------------------------------------------- filter logic

  function passesFilters(bp) {
    const q = state.query.trim().toLowerCase();
    if (q) {
      const matchesName = bp.blueprintName.toLowerCase().includes(q);
      const matchesId = String(bp.typeId).includes(q);
      if (!matchesName && !matchesId) return false;
    }

    // Ownership first - the live screen applies this before anything else, so
    // a corp blueprint stays hidden regardless of the status filters.
    const ownershipOk = (!bp.isCorpOwned && state.own.character)
      || (bp.isCorpOwned && state.own.corporation);
    if (!ownershipOk) return false;

    // Status filters are EXCLUSIVE: with either on, only matching blueprints
    // show, whatever the type filters say.
    const anyStatus = state.type.overridden || state.type.manual;
    if (anyStatus) {
      const matches = (state.type.overridden && bp.hasOverride)
        || (state.type.manual && bp.isManual);
      if (!matches) return false;
    }

    const typeOk = (!bp.isCopy && state.type.bpo) || (bp.isCopy && state.type.bpc);
    if (!typeOk) return false;

    return true;
  }

  /**
   * Group identical blueprints.
   *
   * Keyed on typeId + BPO/BPC + runs + EFFECTIVE ME/TE, so two copies that
   * differ only by an override are listed separately - which is the point:
   * the group's single ME/TE editor would otherwise be lying about one of them.
   */
  function groupBlueprints(list) {
    const groups = new Map();

    list.forEach((bp) => {
      const key = [
        bp.typeId,
        bp.isCopy ? 'bpc' : 'bpo',
        bp.runs,
        bp.effectiveMe,
        bp.effectiveTe,
      ].join('_');

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          typeId: bp.typeId,
          blueprintName: bp.blueprintName,
          isCopy: bp.isCopy,
          runs: bp.runs,
          me: bp.effectiveMe,
          te: bp.effectiveTe,
          hasMeOverride: bp.hasMeOverride,
          hasTeOverride: bp.hasTeOverride,
          hasOverride: bp.hasOverride,
          isManual: bp.isManual,
          blueprints: [],
        });
      }

      const group = groups.get(key);
      group.blueprints.push(bp);
      // A group is "manual" if any copy in it was added by hand.
      if (bp.isManual) group.isManual = true;
    });

    return [...groups.values()].sort(
      (a, b) => a.blueprintName.localeCompare(b.blueprintName)
    );
  }

  function visibleGroups() {
    return groupBlueprints(state.blueprints.filter(passesFilters));
  }

  // ------------------------------------------------------------- rendering

  function render() {
    if (!els.root) return;
    try {
      renderHeader();
      renderSummary();
      renderFilters();
      renderGroups();
      renderStatusLine();
    } catch (error) {
      // Renderer failures are swallowed into console.error by default, which is
      // how a whole view can silently blank. Surfacing it keeps that visible.
      console.error('[blueprints] Render failed:', error);
    }
  }

  function renderHeader() {
    const character = state.character;
    if (character) {
      if (els.portrait && character.portrait) {
        els.portrait.src = `${character.portrait}?size=128`;
        els.portrait.alt = character.characterName || '';
      }
      if (els.name) els.name.textContent = character.characterName || 'Unknown Character';
    }
    els.headerCount.textContent = fmtNumber(state.blueprints.length);
  }

  function renderSummary() {
    const all = state.blueprints;
    const originals = all.filter((bp) => !bp.isCopy).length;
    const copies = all.filter((bp) => bp.isCopy).length;
    const overrides = all.filter((bp) => bp.hasOverride).length;

    const stats = [
      { label: 'Total Blueprints', value: fmtNumber(all.length), accent: true },
      { label: 'Originals', value: fmtNumber(originals), success: true },
      { label: 'Copies', value: fmtNumber(copies) },
      { label: 'Overrides', value: fmtNumber(overrides), accent: overrides > 0 },
    ];

    els.summary.replaceChildren(...stats.map((s) => {
      const wrap = el('div', 'bp-stat');
      wrap.appendChild(el('div', 'bp-stat-label', s.label));
      const cls = `bp-stat-value${s.accent ? ' is-accent' : ''}${s.success ? ' is-success' : ''}`;
      wrap.appendChild(el('div', cls, s.value));
      return wrap;
    }));
  }

  function facetRow(label, count, on, onToggle) {
    const row = el('div', `bp-facet${on ? ' is-on' : ''}`);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-pressed', on ? 'true' : 'false');
    row.appendChild(checkbox(on));
    row.appendChild(el('span', 'bp-facet-label', label));
    row.appendChild(el('span', 'bp-facet-count', fmtNumber(count)));
    row.addEventListener('click', onToggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
    });
    return row;
  }

  function renderFilters() {
    const all = state.blueprints;
    const counts = {
      bpo: all.filter((bp) => !bp.isCopy).length,
      bpc: all.filter((bp) => bp.isCopy).length,
      overridden: all.filter((bp) => bp.hasOverride).length,
      manual: all.filter((bp) => bp.isManual).length,
      character: all.filter((bp) => !bp.isCorpOwned).length,
      corporation: all.filter((bp) => bp.isCorpOwned).length,
    };

    const TYPES = [
      ['bpo', 'Originals (BPO)'],
      ['bpc', 'Copies (BPC)'],
      ['overridden', 'Overridden'],
      ['manual', 'Manual'],
    ];

    els.typeFilters.replaceChildren(...TYPES.map(([key, label]) => facetRow(
      label, counts[key], !!state.type[key],
      () => { state.type[key] = !state.type[key]; render(); }
    )));

    const OWNERS = [['character', 'Character'], ['corporation', 'Corporation']];

    els.ownFilters.replaceChildren(...OWNERS.map(([key, label]) => facetRow(
      label, counts[key], !!state.own[key],
      () => {
        state.own[key] = !state.own[key];
        // Mutually exclusive, matching the live screen: a blueprint is owned by
        // one or the other, so showing both is what "no filter" would mean.
        if (key === 'character' && state.own.character) state.own.corporation = false;
        if (key === 'corporation' && state.own.corporation) state.own.character = false;
        render();
      }
    )));
  }

  /** One ME or TE editor for a group. */
  function efficiencyEditor(group, field) {
    const isMe = field === 'me';
    const value = isMe ? group.me : group.te;
    const overridden = isMe ? group.hasMeOverride : group.hasTeOverride;
    const max = isMe ? MAX_ME : MAX_TE;

    const wrap = el('div', 'bp-eff');
    wrap.appendChild(el('span', 'bp-eff-label', isMe ? 'ME' : 'TE'));

    const row = el('div', 'bp-eff-row');

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(max);
    input.value = String(value);
    input.className = `bp-eff-input${overridden ? ' is-override' : ''}`;
    input.setAttribute('aria-label', `${group.blueprintName} ${isMe ? 'material' : 'time'} efficiency`);

    input.addEventListener('change', () => {
      const raw = parseInt(input.value, 10);
      const clamped = Math.max(0, Math.min(max, Number.isNaN(raw) ? 0 : raw));
      input.value = String(clamped);
      setGroupEfficiency(group, field, clamped);
    });

    row.appendChild(input);

    if (overridden) {
      const reset = el('button', 'bp-eff-reset', 'Reset');
      reset.type = 'button';
      reset.title = `Remove the ${isMe ? 'ME' : 'TE'} override`;
      reset.addEventListener('click', () => resetGroupEfficiency(group, field));
      row.appendChild(reset);
    }

    wrap.appendChild(row);
    return wrap;
  }

  function copyRow(bp) {
    const row = el('div', 'bp-copy');

    const info = el('div', 'bp-copy-info');

    // The resolved place, not a raw id. The flag ("Cargo", "CorpSAG2") says
    // WHERE inside that place, so it belongs in the chain, not on its own -
    // "#1050504970154 · Cargo" told the user nothing about where the blueprint
    // actually is.
    const place = bp.locationInfo ? bp.locationInfo.fullPath : null;
    const location = el('span', 'bp-copy-location', place || 'Unknown location');

    if (bp.chainLabel) {
      location.title = bp.chainLabel;
      const nested = (bp.locationInfo.containerPath || []).length > 0;
      if (nested) {
        location.classList.add('bp-has-chain');
        location.setAttribute('aria-label', bp.chainLabel);
        location.tabIndex = 0;
      }
    }
    info.appendChild(location);

    if (bp.isManual) {
      info.appendChild(document.createTextNode(' · '));
      info.appendChild(el('span', 'bp-badge is-manual', 'Manual'));
    }
    row.appendChild(info);

    const remove = el('button', 'bp-copy-delete', '×');
    remove.type = 'button';
    remove.title = 'Remove this blueprint';
    remove.setAttribute('aria-label', `Remove ${bp.blueprintName} #${bp.itemId}`);
    remove.addEventListener('click', () => openDeleteModal(bp));
    row.appendChild(remove);

    return row;
  }

  function groupCard(group) {
    const card = el('div', `bp-group${group.hasOverride ? ' is-overridden' : ''}`);
    card.dataset.groupKey = group.key;
    card.appendChild(el('div', 'bp-group-accent'));

    const head = el('div', 'bp-group-head');

    const img = document.createElement('img');
    img.className = 'bp-group-icon';
    img.loading = 'lazy';
    img.alt = '';
    img.src = `https://images.evetech.net/types/${group.typeId}/bp?size=64`;
    head.appendChild(img);

    const info = el('div', 'bp-group-info');

    const title = el('div', 'bp-group-title');
    title.appendChild(el('span', 'bp-group-name', group.blueprintName));
    title.appendChild(el(
      'span', `bp-badge ${group.isCopy ? 'is-bpc' : 'is-bpo'}`, group.isCopy ? 'BPC' : 'BPO'
    ));
    if (group.isManual) title.appendChild(el('span', 'bp-badge is-manual', 'Manual'));
    if (group.hasOverride) title.appendChild(el('span', 'bp-badge is-override', 'Overridden'));
    info.appendChild(title);

    const meta = el('div', 'bp-group-meta');
    const runsLabel = el('span', null, 'Runs: ');
    // A BPO has unlimited runs; ESI reports that as -1.
    runsLabel.appendChild(el(
      'span', 'bp-mono-muted', group.isCopy ? String(group.runs) : 'Infinite'
    ));
    meta.appendChild(runsLabel);

    const qtyLabel = el('span', null, 'Qty: ');
    qtyLabel.appendChild(el('span', 'bp-mono-muted', fmtNumber(group.blueprints.length)));
    meta.appendChild(qtyLabel);

    info.appendChild(meta);
    head.appendChild(info);

    head.appendChild(efficiencyEditor(group, 'me'));
    head.appendChild(efficiencyEditor(group, 'te'));

    // Open in the Blueprint Calculator, carrying the effective ME so the
    // calculator opens with the numbers shown here.
    const calc = el('button', 'bp-icon-btn');
    calc.type = 'button';
    calc.title = 'Open in Blueprint Calculator';
    calc.setAttribute('aria-label', `Open ${group.blueprintName} in the Blueprint Calculator`);
    calc.appendChild(svg([
      ['rect', { x: 4, y: 2, width: 16, height: 20, rx: 2 }],
      ['line', { x1: 8, y1: 6, x2: 16, y2: 6 }],
      ['line', { x1: 8, y1: 10, x2: 16, y2: 10 }],
      ['line', { x1: 8, y1: 14, x2: 16, y2: 14 }],
      ['line', { x1: 8, y1: 18, x2: 12, y2: 18 }],
    ], 16));
    calc.addEventListener('click', () => openInCalculator(group));
    head.appendChild(calc);

    // Expand to the individual copies. Always offered, even for a single copy,
    // because that is where per-blueprint removal lives.
    const open = !!state.expanded[group.key];
    const expand = el('button', `bp-icon-btn${open ? ' is-open' : ''}`);
    expand.type = 'button';
    expand.title = open ? 'Hide individual copies' : 'Show individual copies';
    expand.setAttribute('aria-expanded', open ? 'true' : 'false');
    expand.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} copies of ${group.blueprintName}`);
    expand.appendChild(svg([['polyline', { points: '6 9 12 15 18 9' }]], 18, 'bp-chevron'));
    expand.addEventListener('click', () => {
      state.expanded[group.key] = !state.expanded[group.key];
      render();
    });
    head.appendChild(expand);

    card.appendChild(head);

    if (open) {
      const copies = el('div', 'bp-copies');
      group.blueprints.forEach((bp) => copies.appendChild(copyRow(bp)));
      card.appendChild(copies);
    }

    return card;
  }

  function renderGroups() {
    els.loading.hidden = !state.loading;
    if (state.loading) {
      els.groups.hidden = true;
      els.empty.hidden = true;
      return;
    }

    const groups = visibleGroups();

    if (groups.length === 0) {
      els.groups.hidden = true;
      els.empty.hidden = false;

      if (state.blueprints.length === 0) {
        els.emptyTitle.textContent = 'No blueprints loaded';
        els.emptyText.textContent =
          'Add one manually, or click "Refresh from API" to fetch this character\'s blueprints from Eve Online.';
      } else {
        els.emptyTitle.textContent = 'No blueprints match';
        els.emptyText.textContent =
          'Adjust your search or filters, add one manually, or click "Refresh from API" to fetch blueprints from Eve Online.';
      }
      return;
    }

    els.groups.hidden = false;
    els.empty.hidden = true;
    els.groups.replaceChildren(...groups.map(groupCard));
  }

  function renderStatusLine() {
    const groups = visibleGroups();
    els.shownCount.textContent =
      `${fmtNumber(groups.length)} groups shown · ${fmtNumber(state.blueprints.length)} blueprints`;
  }

  // --------------------------------------------------------------- actions

  /**
   * Apply an ME/TE change to every copy in a group.
   *
   * Overrides are stored PER BLUEPRINT (per itemId), but the editor sits on the
   * group. Every copy in a group shares the same effective value by definition,
   * so the edit fans out - otherwise the displayed number would apply to only
   * one of them and the group would immediately split.
   */
  async function setGroupEfficiency(group, field, value) {
    const dbField = field === 'me' ? 'materialEfficiency' : 'timeEfficiency';

    try {
      await Promise.all(group.blueprints.map((bp) => {
        // Setting a value back to the blueprint's REAL value clears the
        // override rather than storing a redundant one - the only way back to
        // "no override" from the UI.
        const actual = bp[dbField];
        const next = value === actual ? null : value;
        return window.electronAPI.blueprints.setOverride(
          state.characterId, bp.itemId, dbField, next
        );
      }));

      await loadBlueprints();
    } catch (error) {
      console.error('[blueprints] Could not set efficiency:', error);
      toast(`Could not update ${field.toUpperCase()}: ${error.message}`, 'error');
      await loadBlueprints();
    }
  }

  async function resetGroupEfficiency(group, field) {
    const dbField = field === 'me' ? 'materialEfficiency' : 'timeEfficiency';

    try {
      await Promise.all(group.blueprints.map((bp) =>
        window.electronAPI.blueprints.setOverride(state.characterId, bp.itemId, dbField, null)
      ));
      await loadBlueprints();
      toast(`${field.toUpperCase()} override removed`, 'info');
    } catch (error) {
      console.error('[blueprints] Could not reset efficiency:', error);
      toast(`Could not reset ${field.toUpperCase()}: ${error.message}`, 'error');
    }
  }

  /** Clear the search box and return focus to it, ready for the next query. */
  function clearSearch() {
    state.query = '';
    els.search.value = '';
    els.searchClear.hidden = true;
    els.search.focus();
    render();
  }

  async function openInCalculator(group) {
    try {
      await window.electronAPI.blueprints.openInCalculator(group.typeId, group.me);
    } catch (error) {
      console.error('[blueprints] Could not open the calculator:', error);
      toast('Could not open the Blueprint Calculator', 'error');
    }
  }

  // ---------------------------------------------------------- delete modal

  function openDeleteModal(bp) {
    state.pendingDelete = bp;
    els.deleteText.textContent = bp.isManual
      ? `Remove the manually added "${bp.blueprintName}"?`
      : `Remove "${bp.blueprintName}" (#${bp.itemId}) from the local list?`;
    els.deleteModal.hidden = false;
    els.deleteOk.focus();
  }

  function closeDeleteModal() {
    state.pendingDelete = null;
    els.deleteModal.hidden = true;
  }

  async function confirmDelete() {
    const bp = state.pendingDelete;
    closeDeleteModal();
    if (!bp) return;

    try {
      const ok = await window.electronAPI.blueprints.remove(state.characterId, bp.itemId);
      if (!ok) throw new Error('The blueprint was not removed');

      await loadBlueprints();
      toast(`Removed ${bp.blueprintName}`, 'success');
    } catch (error) {
      console.error('[blueprints] Could not remove blueprint:', error);
      toast(`Could not remove the blueprint: ${error.message}`, 'error');
    }
  }

  // ------------------------------------------------------------- add modal

  function openAddModal() {
    state.addQuery = '';
    state.addResults = [];
    els.addSearch.value = '';
    renderAddResults();
    els.addModal.hidden = false;
    els.addSearch.focus();
  }

  function closeAddModal() {
    els.addModal.hidden = true;
    if (addSearchTimer) {
      clearTimeout(addSearchTimer);
      addSearchTimer = null;
    }
  }

  function renderAddResults() {
    const query = state.addQuery.trim();

    if (query.length < 2) {
      els.addResults.replaceChildren(
        el('div', 'bp-add-prompt', 'Enter at least 2 characters to search…')
      );
      return;
    }

    if (state.addResults.length === 0) {
      els.addResults.replaceChildren(el('div', 'bp-add-prompt', 'No blueprints found.'));
      return;
    }

    els.addResults.replaceChildren(...state.addResults.map((result) => {
      const row = el('button', 'bp-add-result');
      row.type = 'button';

      const img = document.createElement('img');
      img.className = 'bp-add-result-icon';
      img.loading = 'lazy';
      img.alt = '';
      img.src = `https://images.evetech.net/types/${result.typeID}/bp?size=64`;
      row.appendChild(img);

      const info = el('div', null);
      info.appendChild(el('div', 'bp-add-result-name', result.typeName));
      if (result.groupName) {
        info.appendChild(el('div', 'bp-add-result-group', result.groupName));
      }
      row.appendChild(info);

      row.addEventListener('click', () => addManualBlueprint(result));
      return row;
    }));
  }

  function onAddSearchInput() {
    state.addQuery = els.addSearch.value;

    if (addSearchTimer) clearTimeout(addSearchTimer);

    const query = state.addQuery.trim();
    if (query.length < 2) {
      state.addResults = [];
      renderAddResults();
      return;
    }

    // Debounced, and guarded against out-of-order responses: a slower earlier
    // query must not overwrite the results of a later one.
    addSearchTimer = setTimeout(async () => {
      const token = ++state.addSearchToken;
      try {
        const results = await window.electronAPI.sde.searchBlueprints(query);
        if (token !== state.addSearchToken) return;
        state.addResults = Array.isArray(results) ? results : [];
      } catch (error) {
        if (token !== state.addSearchToken) return;
        console.error('[blueprints] Blueprint search failed:', error);
        state.addResults = [];
      }
      renderAddResults();
    }, 200);
  }

  async function addManualBlueprint(result) {
    try {
      const ok = await window.electronAPI.blueprints.addManual({
        typeId: result.typeID,
        characterId: state.characterId,
        materialEfficiency: 0,
        timeEfficiency: 0,
        runs: -1, // a manually added blueprint is an original
        isCopy: false,
      });

      if (!ok) throw new Error('The blueprint was not added');

      closeAddModal();
      await loadBlueprints();
      toast(`Added ${result.typeName}`, 'success');
    } catch (error) {
      console.error('[blueprints] Could not add blueprint:', error);
      toast(`Could not add the blueprint: ${error.message}`, 'error');
    }
  }

  // --------------------------------------------------------------- refresh

  async function handleRefresh() {
    if (!els.refreshBtn) return;
    if (QFUI.isBusy(els.refreshBtn)) return;

    // Gated by the ESI cache. Say so immediately rather than round-tripping to
    // main just to be told the same thing.
    if (els.refreshBtn.classList.contains('is-gated')) {
      toast(
        cacheLabel
          ? `Blueprints are already up to date. ESI has nothing newer for another ${cacheLabel}.`
          : 'Blueprints are already up to date.',
        'info'
      );
      return;
    }

    await QFUI.withButtonBusy(els.refreshBtn, 'Refreshing…', async () => {
      try {
        const result = await window.electronAPI.blueprints.fetch(state.characterId);
        if (!result || !result.success) {
          throw new Error((result && result.error) || 'Unknown error');
        }

        // Gated: ESI was never asked, so the stored blueprints are unchanged.
        if (result.skipped) {
          toast(result.reason || 'Blueprints are already up to date', 'info');
          return;
        }

        await loadBlueprints();
        toast('Blueprints refreshed', 'success');
      } catch (error) {
        console.error('[blueprints] Refresh failed:', error);
        toast(`Failed to refresh blueprints: ${error.message}`, 'error');
      }
    });

    // After the restore: startCacheCountdown rewrites the label, and the busy
    // restore would otherwise land on top of it.
    startCacheCountdown();
  }

  /**
   * Drives the Refresh button's label from the ESI cache.
   *
   * The button stays ENABLED while gated - a disabled <button> swallows the
   * click, so the user would get no explanation at all.
   */
  function startCacheCountdown() {
    if (cacheCountdown) {
      cacheCountdown();
      cacheCountdown = null;
    }

    if (!window.QFCacheCountdown) return;

    cacheCountdown = window.QFCacheCountdown.attach({
      getStatus: () => window.electronAPI.blueprints.getCacheStatus(state.characterId),
      endpointTypes: ['blueprints'],
      render: ({ cached, label }) => {
        if (!els.refreshBtn) return;
        els.refreshBtn.classList.toggle('is-gated', cached);
        // This ticks once a second, so it must not stomp the in-flight label
        // while a refresh is running (Assets already guarded this; here it did
        // not, so the busy label was overwritten within a second).
        if (!QFUI.isBusy(els.refreshBtn)) {
          els.refreshLabel.textContent = cached ? `Cached (${label})` : 'Refresh from API';
        }
        els.refreshBtn.title = cached
          ? `ESI has no newer blueprints yet - cache expires in ${label}`
          : 'Fetch the latest blueprints from ESI';
        els.cacheStatus.textContent = cached ? `Cache expires in ${label}` : 'Cache expired';
        cacheLabel = cached ? label : null;
      },
    });
  }

  // ----------------------------------------------------------------- mount

  /**
   * @param {HTMLElement} container
   * @param {Object} params - { characterId }
   * @param {Object} ctx - ViewContext; every subscription goes through it so a
   *   remount cannot leave a duplicate behind.
   */
  async function mount(container, params, ctx) {
    // `state` is module-level and survives unmount, so a remount - especially
    // for a DIFFERENT character - would otherwise inherit the previous one's
    // blueprints and filters.
    state.character = null;
    state.blueprints = [];
    state.loading = true;
    state.query = '';
    state.type = { bpo: true, bpc: true, overridden: false, manual: false };
    state.own = { character: true, corporation: false };
    state.expanded = {};
    state.addQuery = '';
    state.addResults = [];
    state.pendingDelete = null;

    await QFUI.loadViewTemplate(container, 'blueprints.view.html');

    els = {
      root: container.querySelector('#blueprints-view'),
      portrait: container.querySelector('#bp-portrait'),
      name: container.querySelector('#bp-character-name'),
      headerCount: container.querySelector('#bp-header-count'),
      addBtn: container.querySelector('#bp-add-btn'),
      refreshBtn: container.querySelector('#bp-refresh-btn'),
      refreshLabel: container.querySelector('#bp-refresh-label'),
      summary: container.querySelector('#bp-summary'),
      search: container.querySelector('#bp-search'),
      searchClear: container.querySelector('#bp-search-clear'),
      typeFilters: container.querySelector('#bp-type-filters'),
      ownFilters: container.querySelector('#bp-own-filters'),
      loading: container.querySelector('#bp-loading'),
      groups: container.querySelector('#bp-groups'),
      empty: container.querySelector('#bp-empty'),
      emptyTitle: container.querySelector('#bp-empty-title'),
      emptyText: container.querySelector('#bp-empty-text'),
      shownCount: container.querySelector('#bp-shown-count'),
      cacheStatus: container.querySelector('#bp-cache-status'),
      addModal: container.querySelector('#bp-add-modal'),
      addSearch: container.querySelector('#bp-add-search'),
      addResults: container.querySelector('#bp-add-results'),
      addClose: container.querySelector('#bp-add-close'),
      deleteModal: container.querySelector('#bp-delete-modal'),
      deleteText: container.querySelector('#bp-delete-text'),
      deleteClose: container.querySelector('#bp-delete-close'),
      deleteCancel: container.querySelector('#bp-delete-cancel'),
      deleteOk: container.querySelector('#bp-delete-ok'),
    };

    // Character id comes from the mount params, so this view is window-agnostic:
    // it works mounted in the main window or opened via openView, unchanged.
    state.characterId = params && params.characterId
      ? params.characterId
      : await window.electronAPI.esi.getDefaultCharacter()
        .then((c) => (c ? c.characterId : null))
        .catch(() => null);

    if (!state.characterId) {
      state.loading = false;
      els.loading.hidden = true;
      els.empty.hidden = false;
      els.emptyTitle.textContent = 'No character selected';
      els.emptyText.textContent =
        'Open the Blueprint Manager from a character to see their blueprints.';
      return {};
    }

    state.character = await window.electronAPI.esi.getCharacter(state.characterId)
      .catch((error) => {
        console.error('[blueprints] Could not load character:', error);
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

    ctx.on(els.refreshBtn, 'click', handleRefresh);
    ctx.on(els.addBtn, 'click', openAddModal);

    ctx.on(els.addSearch, 'input', onAddSearchInput);
    ctx.on(els.addClose, 'click', closeAddModal);
    ctx.on(els.addModal, 'click', (e) => {
      if (e.target === els.addModal) closeAddModal();
    });

    ctx.on(els.deleteClose, 'click', closeDeleteModal);
    ctx.on(els.deleteCancel, 'click', closeDeleteModal);
    ctx.on(els.deleteOk, 'click', confirmDelete);
    ctx.on(els.deleteModal, 'click', (e) => {
      if (e.target === els.deleteModal) closeDeleteModal();
    });

    // One Escape handler for both modals. Every close path - X, Cancel,
    // backdrop, Escape - goes through the same teardown.
    ctx.on(document, 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!els.deleteModal.hidden) closeDeleteModal();
      else if (!els.addModal.hidden) closeAddModal();
    });

    await loadBlueprints();
    startCacheCountdown();

    // Live updates: reload when the background cycle lands new blueprint data,
    // rather than polling for it.
    const api = window.electronAPI.data;
    if (api && api.onChanged) {
      ctx.track(api.onChanged((info) => {
        const type = String(info && info.endpointType || '');
        if (type !== 'blueprints' && type !== 'corporation_blueprints') return;
        loadBlueprints().catch((error) =>
          console.error('[blueprints] Live reload failed:', error));
      }));
    }

    return {};
  }

  function destroy() {
    // The cache countdown owns a timer and a data subscription of its own, so
    // it is disposed explicitly - it is not routed through ctx.
    if (cacheCountdown) {
      cacheCountdown();
      cacheCountdown = null;
    }
    if (addSearchTimer) {
      clearTimeout(addSearchTimer);
      addSearchTimer = null;
    }
    els = {};
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('blueprints', {
      title: 'Blueprint Manager',
      mount,
      destroy,
    });
  }
})();
