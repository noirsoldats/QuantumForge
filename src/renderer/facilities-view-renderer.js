/**
 * Facilities Manager — native shell view.
 *
 * Ported from the framed public/facilities.html. Presentation follows
 * "Facilities Manager (1a).dc.html"; every IPC call and validation rule is
 * carried over from the legacy renderer unchanged.
 *
 * Behaviours that are NOT visible in the mockup and must not be lost:
 *   - Rigs are filtered in TWO stages: fetched per structure TYPE
 *     (engineering/refinery), then filtered by the structure's RIG SIZE.
 *   - securityStatus is derived from the selected system and saved with the
 *     facility; downstream cost maths reads it.
 *   - Facility tax is structure-only. NPC stations fall back to main's own
 *     default (0.25%) rather than storing one here.
 *   - Only one facility may have usage 'default', and names are unique
 *     case-insensitively. Both rules live in settings-manager and THROW;
 *     this view surfaces the thrown message rather than duplicating them.
 */
(function () {
  'use strict';

  const TEMPLATE_URL = 'facilities.view.html';

  /** Usage values main accepts. Must match settings-manager's validUsageTypes. */
  const USAGES = [
    ['default', 'Default'],
    ['components', 'Components'],
    ['subsystems', 'Subsystems'],
    ['t3-ships', 'T3 Ships'],
    ['capitals', 'Capitals'],
    ['super-capitals', 'Super Capitals'],
    ['t2-invention', 'T2 Invention'],
    ['t3-invention', 'T3 Invention'],
    ['copy', 'Copy'],
    ['boosters', 'Boosters'],
    ['reactions', 'Reactions'],
    ['reactions-basic', 'Reactions - Basic'],
    ['reactions-advanced', 'Reactions - Advanced'],
    ['reactions-composite', 'Reactions - Composite'],
    ['reprocessing', 'Reprocessing'],
    ['reprocessing-moon', 'Reprocessing - Moon Ore'],
  ];

  const state = {
    facilities: [],
    regions: [],
    /** Every system in the game, for naming facilities in any region. */
    allSystems: [],
    /** The selected region's systems - what the form's dropdown offers. */
    systems: [],
    structureTypes: [],
    /** Every rig, for naming rigs on saved facilities. */
    allRigs: [],
    /** Rigs for the CURRENT structure type, before size filtering. */
    structureRigs: [],
    /** Rig size of the selected structure, so rebuilds keep the same filter. */
    rigSize: null,
    /**
     * structureTypeId -> bonuses, for the facility cards.
     *
     * Keyed by TYPE, not by facility: ten Raitarus share one lookup. The SDE
     * does not change while the app runs, so this is never invalidated.
     */
    bonusCache: {},
    editingId: null,
    /** Form selections that live in QFSearchSelect rather than the DOM. */
    form: {
      usage: '',
      type: 'station',
      regionId: '',
      systemId: '',
      structureTypeId: '',
      rigs: ['', '', ''],
    },
  };

  let templateCache = null;
  let searchSelects = [];
  /* Pending two-step delete: the arm timer must be cancellable on unmount. */
  let armedTimer = null;
  let armedButton = null;
  let armedLabel = null;

  /* --------------------------------------------------------------- helpers */

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /**
   * A cell whose text may be ellipsised, carrying its full value as a title.
   *
   * Anything given a max-width and `text-overflow: ellipsis` needs this, or
   * the truncated part becomes unreachable.
   */
  function truncatedCell(cls, text) {
    const node = el('span', cls, text);
    if (text !== undefined && text !== null && String(text) !== '') {
      node.title = String(text);
    }
    return node;
  }

  function usageLabel(value) {
    const found = USAGES.find((u) => u[0] === value);
    return found ? found[1] : value || '—';
  }

  function toast(message, type) {
    if (window.QFToast) window.QFToast.show(message, type);
    else console.log(`[facilities] ${type}: ${message}`);
  }

  /** Run a loader, log and swallow its failure, and return null. */
  async function loadSafely(label, fn) {
    try {
      return await fn();
    } catch (error) {
      console.error(`[facilities] load failed: ${label}`, error);
      return null;
    }
  }

  /** Render step isolated so one throw cannot blank the rest of the view. */
  function renderSafely(label, fn) {
    try {
      fn();
    } catch (error) {
      console.error(`[facilities] render failed: ${label}`, error);
    }
  }

  /**
   * Mount a QFSearchSelect, replacing any previous instance in that host.
   *
   * These hosts are rebuilt whenever their option list changes, and a bare
   * `new QFSearchSelect(host, ...)` APPENDS - leaving two dropdowns stacked
   * and the old one still holding a document listener and a body popover.
   */
  function mountSelect(host, opts) {
    if (!host || !window.QFSearchSelect) return null;

    searchSelects = searchSelects.filter((entry) => {
      if (entry.host !== host) return true;
      try {
        entry.sel.destroy();
      } catch (error) {
        console.error('[facilities] select destroy failed:', error);
      }
      return false;
    });
    host.textContent = '';

    const sel = new window.QFSearchSelect(host, opts);
    searchSelects.push({ host, sel });
    return sel;
  }

  function destroySelects() {
    searchSelects.forEach(({ sel }) => {
      try {
        sel.destroy();
      } catch (error) {
        console.error('[facilities] select destroy failed:', error);
      }
    });
    searchSelects = [];
  }

  /* ------------------------------------------------------------ data load */

  async function loadInitialData() {
    // ALL systems, not per-region: the facility cards resolve names for
    // whatever region each one is in, so a region-scoped list would render
    // "Unknown System" for every facility outside the current selection.
    const [regions, allSystems, structureTypes, allRigs] = await Promise.all([
      loadSafely('regions', () => window.electronAPI.facilities.getAllRegions()),
      loadSafely('systems', () => window.electronAPI.sde.getAllSystems()),
      loadSafely('structure types', () => window.electronAPI.facilities.getStructureTypes()),
      loadSafely('structure rigs', () => window.electronAPI.facilities.getStructureRigs()),
    ]);

    state.regions = regions || [];
    // getAllSystems returns raw SDE column names.
    state.allSystems = (allSystems || []).map((s) => ({
      systemId: s.solarSystemID,
      systemName: s.solarSystemName,
      security: s.security,
      regionId: s.regionID,
    }));
    state.structureTypes = structureTypes || [];
    // Unfiltered pool, so cards can name rigs on any structure. The form's
    // own pool is replaced per structure type in handleStructureChange.
    state.allRigs = allRigs || [];
    // The FORM's pool stays empty until a structure type is chosen; this
    // unfiltered list exists only so saved facilities can name their rigs.
    state.structureRigs = [];

    renderSafely('usage select', mountUsageSelect);
    renderSafely('region select', mountRegionSelect);
    renderSafely('system select', mountSystemSelect);
    renderSafely('structure select', mountStructureSelect);
    renderSafely('rig selects', () => mountRigSelects());
  }

  async function loadFacilities() {
    const facilities = await loadSafely('facilities', () =>
      window.electronAPI.facilities.getFacilities()
    );
    state.facilities = facilities || [];

    await ensureBonusesFor(state.facilities);
    renderSafely('facility list', renderFacilities);
  }

  /**
   * Fetch structure bonuses for any structure type not already cached.
   *
   * Deduped by structureTypeId, so a hangar full of Raitarus costs one
   * lookup. getStructureBonuses is two indexed reads against the local SDE
   * and the values are a fixed table per structure class, so this is cheap -
   * but it is still one IPC round-trip per distinct type, hence the cache.
   */
  async function ensureBonusesFor(facilities) {
    const missing = [...new Set(
      facilities
        .filter((f) => f.facilityType === 'structure' && f.structureTypeId)
        .map((f) => String(f.structureTypeId))
    )].filter((typeId) => !(typeId in state.bonusCache));

    if (missing.length === 0) return;

    const results = await Promise.all(missing.map((typeId) =>
      loadSafely('structure bonuses', () =>
        window.electronAPI.facilities.getStructureBonuses(typeId)
      )
    ));

    missing.forEach((typeId, i) => {
      // Cache the miss too: a null here means the SDE has nothing for this
      // type, and retrying it on every reload would not change that.
      state.bonusCache[typeId] = results[i] || null;
    });
  }

  /* ----------------------------------------------------------- form: selects */

  function mountUsageSelect() {
    mountSelect($('fac-usage-host'), {
      options: USAGES.map(([value, label]) => ({ value, label })),
      value: state.form.usage || null,
      placeholder: 'Select usage',
      onChange: (e) => { state.form.usage = e.target.value; },
    });
  }

  function mountRegionSelect() {
    mountSelect($('fac-region-host'), {
      options: state.regions.map((r) => ({
        value: String(r.regionId),
        label: r.regionName,
      })),
      value: state.form.regionId || null,
      placeholder: 'Select region',
      onChange: (e) => handleRegionChange(e.target.value),
    });
  }

  function mountSystemSelect() {
    // Systems only exist once a region is chosen, so an empty list is the
    // normal state rather than an error.
    mountSelect($('fac-system-host'), {
      options: state.systems.map((s) => ({
        value: String(s.systemId),
        label: `${s.systemName} (${Number(s.security).toFixed(1)})`,
      })),
      value: state.form.systemId || null,
      placeholder: state.form.regionId ? 'Select system' : 'Select a region first',
      onChange: (e) => handleSystemChange(e.target.value),
    });
  }

  /**
   * Structure dropdown: a plain select with non-selectable category headers.
   *
   * Matches the live app - "Azbel (L-Set)" grouped under "Engineering
   * Complexes (Manufacturing)" - which <optgroup> gives natively. Five fixed
   * options do not warrant a searchable combobox (binding rule 5).
   */
  function mountStructureSelect() {
    const select = $('fac-structure');
    if (!select) return;

    select.textContent = '';

    const placeholder = el('option', null, 'Select Structure Type');
    placeholder.value = '';
    select.appendChild(placeholder);

    const addGroup = (label, members) => {
      if (members.length === 0) return;
      const group = document.createElement('optgroup');
      group.label = label;
      members.forEach((s) => {
        const option = el('option', null, `${s.name} (${s.size}-Set)`);
        option.value = String(s.typeId);
        group.appendChild(option);
      });
      select.appendChild(group);
    };

    addGroup(
      'Engineering Complexes (Manufacturing)',
      state.structureTypes.filter((s) => s.structureType === 'engineering')
    );
    addGroup(
      'Refineries (Reactions/Reprocessing)',
      state.structureTypes.filter((s) => s.structureType === 'refinery')
    );

    select.value = state.form.structureTypeId || '';
  }

  /**
   * Rig dropdowns, optionally narrowed to one rig size.
   *
   * Two-stage filtering, carried over from the legacy renderer: rigs are
   * fetched for the structure's TYPE (engineering vs refinery), then reduced
   * to those matching its RIG SIZE. Skipping either stage offers rigs that
   * cannot physically be fitted.
   */
  function mountRigSelects(filterBySize) {
    // Rigs are meaningless until a structure is chosen: the pool depends on
    // its TYPE (engineering vs refinery) and its RIG SIZE, so offering the
    // full list first would let a user pick a rig that cannot be fitted.
    const noStructure = !state.form.structureTypeId;

    const pool = noStructure
      ? []
      : (filterBySize
        ? state.structureRigs.filter((rig) => rig.rigSize === filterBySize)
        : state.structureRigs);

    // getStructureRigs returns `name`, NOT `typeName`, and tags each rig with
    // rigCategory (engineering/refinery). The pool is already scoped to one
    // category by then, so no [E]/[R] prefix is needed.
    const options = [{ value: '', label: 'No rig' }].concat(
      pool.map((rig) => ({ value: String(rig.typeId), label: rig.name }))
    );

    [0, 1, 2].forEach((i) => {
      const host = $(`fac-rig${i + 1}-host`);
      mountSelect(host, {
        options,
        value: state.form.rigs[i] || '',
        placeholder: noStructure ? 'Select a structure type first' : 'No rig',
        disabled: noStructure,
        onChange: (e) => {
          state.form.rigs[i] = e.target.value;
          handleRigChange();
        },
      });
    });
  }

  /* ---------------------------------------------------------- form: handlers */

  function handleTypeChange(value) {
    state.form.type = value;
    const isStructure = value === 'structure';

    $('fac-structure-field').hidden = !isStructure;
    $('fac-structure-extras').hidden = !isStructure;

    if (isStructure) {
      // Player structures default to 0% until the owner's rate is entered.
      if (!$('fac-tax').value) $('fac-tax').value = '0.00';
    } else {
      // NPC stations take main's own default rate, so store nothing here.
      $('fac-tax').value = '';
      state.form.structureTypeId = '';
      state.form.rigs = ['', '', ''];
      // Drop the pool too, so switching back to Structure starts from
      // "choose a structure" rather than the previous one's rigs.
      state.structureRigs = [];
      state.rigSize = null;
      $('fac-bonus-panel').hidden = true;
      $('fac-rig-panel').hidden = true;
      updateInfoVisibility();
      // The selects are hidden but not destroyed, so rebuild them from the
      // now-empty pool rather than leaving the old structure's rigs staged.
      mountStructureSelect();
      mountRigSelects();
    }
  }

  function handleRegionChange(regionId) {
    state.form.regionId = regionId;
    // A region change invalidates the chosen system and its cost indices.
    state.form.systemId = '';
    $('fac-cost-panel').hidden = true;
    updateInfoVisibility();

    // Filtered from the full list rather than refetched - every system is
    // already loaded, and the SDE call is not cheap.
    state.systems = regionId
      ? state.allSystems
        .filter((s) => String(s.regionId) === String(regionId))
        .sort((a, b) => a.systemName.localeCompare(b.systemName))
      : [];

    renderSafely('system select', mountSystemSelect);
  }

  async function handleSystemChange(systemId) {
    state.form.systemId = systemId;
    if (!systemId) {
      $('fac-cost-panel').hidden = true;
      updateInfoVisibility();
      return;
    }

    const indices = await loadSafely('cost indices', () =>
      window.electronAPI.facilities.getCostIndices(parseInt(systemId, 10))
    );
    renderSafely('cost indices', () => renderCostIndices(indices));
  }

  /**
   * @param {string} structureTypeId
   * @param {boolean} [keepRigs] - true only when restoring a saved facility,
   *   whose rigs were already valid for this structure.
   */
  async function handleStructureChange(structureTypeId, keepRigs) {
    const changed = String(state.form.structureTypeId) !== String(structureTypeId);
    state.form.structureTypeId = structureTypeId;

    // A different structure means a different rig pool, so selections made
    // against the previous one are no longer valid.
    if (changed && !keepRigs) state.form.rigs = ['', '', ''];

    if (!structureTypeId) {
      // Whatever rigs were chosen belonged to the OLD structure, and its pool
      // no longer applies - keeping either would let an unfittable rig be
      // saved against the next structure picked.
      state.structureRigs = [];
      state.rigSize = null;
      state.form.rigs = ['', '', ''];
      $('fac-bonus-panel').hidden = true;
      $('fac-rig-panel').hidden = true;
      updateInfoVisibility();
      mountRigSelects();
      return;
    }

    const bonuses = await loadSafely('structure bonuses', () =>
      window.electronAPI.facilities.getStructureBonuses(structureTypeId)
    );
    if (!bonuses) return;

    renderSafely('structure bonuses', () => renderBonuses(bonuses));

    // Stage 1: rigs for this structure's type. Stage 2: its rig size.
    const rigs = await loadSafely('structure rigs', () =>
      window.electronAPI.facilities.getStructureRigs(bonuses.structureType)
    );
    state.structureRigs = rigs || [];
    state.rigSize = bonuses.rigSize || null;
    mountRigSelects(state.rigSize);

    handleRigChange();
  }

  async function handleRigChange() {
    const rigIds = state.form.rigs.filter(Boolean);
    if (rigIds.length === 0) {
      $('fac-rig-panel').hidden = true;
      updateInfoVisibility();
      return;
    }

    // getRigEffects takes ONE rig id, so this is a call per selected rig.
    const effects = await loadSafely('rig effects', () =>
      Promise.all(rigIds.map((id) => window.electronAPI.facilities.getRigEffects(id)))
    );
    renderSafely('rig effects', () => renderRigEffects(rigIds, effects || []));
  }

  /* ---------------------------------------------------------- info panels */

  /** The info block only exists when at least one panel inside it does. */
  function updateInfoVisibility() {
    const anyVisible = ['fac-cost-panel', 'fac-bonus-panel', 'fac-rig-panel']
      .some((id) => $(id) && !$(id).hidden);
    $('fac-info').hidden = !anyVisible;
  }

  /** `manufacturing_jobs` -> `Manufacturing Jobs`. */
  function formatActivityName(activity) {
    return String(activity || '')
      .replace(/_/g, ' ')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  function renderCostIndices(indices) {
    const host = $('fac-cost-indices');
    host.textContent = '';

    const rows = Array.isArray(indices) ? indices : [];
    if (rows.length === 0) {
      // Shown rather than hidden: "this system has no index data" is a real
      // answer, and hiding the panel would read as "still loading".
      host.appendChild(el(
        'div',
        'fac-index-empty',
        'No cost index data available for this system.'
      ));
      $('fac-cost-panel').hidden = false;
      updateInfoVisibility();
      return;
    }

    rows.forEach((entry) => {
      const box = el('div', 'fac-index');
      box.appendChild(el('span', 'fac-index-label', formatActivityName(entry.activity)));
      box.appendChild(el(
        'span',
        'fac-index-value',
        `${(Number(entry.costIndex) * 100).toFixed(2)}%`
      ));
      host.appendChild(box);
    });

    $('fac-cost-panel').hidden = false;
    updateInfoVisibility();
  }

  function renderBonuses(bonuses) {
    const host = $('fac-bonuses');
    host.textContent = '';

    $('fac-structure-name').textContent = bonuses.structureName || '';

    // A zero bonus is shown faint rather than hidden: "this structure gives
    // nothing here" is information.
    const rows = [
      ['Material Eff.', bonuses.materialEfficiency],
      ['Time Eff.', bonuses.timeEfficiency],
      ['Cost Reduction', bonuses.costReduction],
    ];

    rows.forEach(([label, raw]) => {
      const value = Number(raw) || 0;
      const box = el('div', `fac-bonus${value ? '' : ' is-zero'}`);
      box.appendChild(el('span', 'fac-bonus-label', label));
      box.appendChild(el('span', 'fac-bonus-value', value ? `-${value.toFixed(1)}%` : '0%'));
      host.appendChild(box);
    });

    $('fac-bonus-panel').hidden = false;
    updateInfoVisibility();
  }

  /**
   * Which raw SDE attributes are worth showing for a rig.
   *
   * getRigEffects returns every dogma attribute on the type, most of which are
   * fitting metadata. This keeps the manufacturing-relevant ones and drops the
   * meta attributes - carried over verbatim from the legacy renderer, since
   * the filter is what makes the panel readable at all.
   */
  function isRelevantRigEffect(effect) {
    if (!effect.displayName && !effect.attributeName) return false;
    const name = (effect.displayName || effect.attributeName || '').toLowerCase();

    if (name.includes('rig size')
      || name.includes('tech level')
      || name.includes('calibration')
      || name.includes('can be fitted')) {
      return false;
    }

    return name.includes('bonus')
      || name.includes('reduction')
      || name.includes('multiplier')
      || name.includes('material')
      || name.includes('time')
      || name.includes('cost');
  }

  /** Format one attribute value the way its own name implies. */
  function formatRigEffect(effect) {
    const label = effect.displayName || effect.attributeName || 'Unknown';
    const lower = label.toLowerCase();
    const value = effect.value;

    if (lower.includes('multiplier')) return { label, value: `${value}x` };

    if (lower.includes('reduction') || lower.includes('bonus')
      || lower.includes('time') || lower.includes('material')) {
      // Negative is a reduction (good); positive is an increase.
      return { label, value: `${value < 0 ? '' : '+'}${value}%` };
    }

    return { label, value: String(value) };
  }

  function renderRigEffects(rigIds, effectsPerRig) {
    const host = $('fac-rig-effects');
    host.textContent = '';

    rigIds.forEach((rigId, index) => {
      // The rig's NAME comes from the rig list, not the effects payload.
      const rig = state.structureRigs.find((r) => String(r.typeId) === String(rigId));
      const effects = effectsPerRig[index] || [];

      const row = el('div', 'fac-rig-row');
      row.appendChild(el('span', 'fac-rig-name', (rig && rig.name) || 'Unknown Rig'));

      const chips = el('span', 'fac-rig-chips');
      const formatted = (Array.isArray(effects) ? effects : [])
        .filter(isRelevantRigEffect)
        .map(formatRigEffect);

      if (formatted.length === 0) {
        chips.appendChild(el('span', 'fac-rig-chip is-empty', 'No bonus data available'));
      } else {
        formatted.forEach(({ label, value }) => {
          chips.appendChild(el('span', 'fac-rig-chip', `${label}: ${value}`));
        });
      }
      row.appendChild(chips);

      host.appendChild(row);
    });

    $('fac-rig-panel').hidden = false;
    updateInfoVisibility();
  }

  /* ------------------------------------------------------------ facilities */

  function renderFacilities() {
    const host = $('fac-list');
    host.textContent = '';

    $('fac-count').textContent = state.facilities.length;
    $('fac-list-count').textContent = state.facilities.length;

    if (state.facilities.length === 0) {
      const empty = el('div', 'fac-empty');
      empty.appendChild(el('div', 'fac-empty-title', 'No facilities yet'));
      empty.appendChild(el(
        'div',
        'fac-empty-text',
        'Add a facility above to use its bonuses in manufacturing calculations.'
      ));
      host.appendChild(empty);
      return;
    }

    state.facilities.forEach((facility) => {
      host.appendChild(facilityCard(facility));
    });
  }

  function facilityCard(facility) {
    const isStructure = facility.facilityType === 'structure';

    const card = el('article', 'fac-card fac-facility');
    card.setAttribute('data-fac-id', String(facility.id));
    card.appendChild(el('div', 'fac-card-accent'));

    const body = el('div', 'fac-facility-body');

    /* ---- title row ---- */
    const head = el('div', 'fac-facility-head');
    const titleWrap = el('div', 'fac-facility-title-wrap');
    // Ellipsised in CSS, so it carries its own full value.
    const nameNode = truncatedCell('fac-facility-name', facility.name);
    titleWrap.appendChild(nameNode);

    const badges = el('div', 'fac-badges');
    const typeBadge = el('span', 'fac-badge fac-badge-type',
      isStructure ? 'Player Structure' : 'NPC Station');
    badges.appendChild(typeBadge);
    const usage = el('span', 'fac-badge fac-badge-usage', usageLabel(facility.usage));
    usage.setAttribute('data-usage', facility.usage || '');
    badges.appendChild(usage);
    titleWrap.appendChild(badges);
    head.appendChild(titleWrap);

    const actions = el('div', 'fac-facility-actions');
    const edit = el('button', 'btn-icon', '');
    edit.type = 'button';
    edit.title = 'Edit facility';
    edit.setAttribute('aria-label', `Edit ${facility.name}`);
    edit.setAttribute('data-fac-edit', String(facility.id));
    edit.appendChild(iconEdit());
    edit.addEventListener('click', () => startEdit(facility.id));
    actions.appendChild(edit);

    const remove = el('button', 'btn-icon btn-icon-danger', '');
    remove.type = 'button';
    remove.title = 'Remove facility';
    remove.setAttribute('aria-label', `Remove ${facility.name}`);
    remove.setAttribute('data-fac-remove', String(facility.id));
    remove.dataset.armed = 'false';
    remove.appendChild(iconTrash());
    remove.addEventListener('click', () => armRemove(remove, facility));
    actions.appendChild(remove);
    head.appendChild(actions);

    body.appendChild(head);

    /* ---- location ----
       The stored facility holds IDs only, so every name here is resolved
       from the lists loaded at mount. */
    const region = state.regions.find(
      (r) => String(r.regionId) === String(facility.regionId)
    );
    const system = state.allSystems.find(
      (s) => String(s.systemId) === String(facility.systemId)
    );

    const location = el('div', 'fac-facility-location');
    location.appendChild(iconPin());
    location.appendChild(truncatedCell(
      'fac-location-text',
      `${system ? system.systemName : 'Unknown System'}, ${region ? region.regionName : 'Unknown Region'}`
    ));

    // Prefer the security stored with the facility - it is what the cost
    // maths used - and fall back to the system's current value.
    const sec = facility.securityStatus !== undefined && facility.securityStatus !== null
      ? Number(facility.securityStatus)
      : (system ? Number(system.security) : null);
    if (Number.isFinite(sec)) {
      location.appendChild(el('span', `fac-sec ${secClass(sec)}`, sec.toFixed(1)));
    }
    body.appendChild(location);

    /* ---- structure detail ---- */
    const detail = el('div', 'fac-facility-detail');
    if (isStructure) {
      const structure = state.structureTypes.find(
        (s) => String(s.typeId) === String(facility.structureTypeId)
      );

      const row = el('div', 'fac-detail-row');
      row.appendChild(el('span', 'fac-detail-label', 'Structure Type'));
      row.appendChild(truncatedCell(
        'fac-detail-value',
        structure ? structure.name : 'Unknown Structure'
      ));
      detail.appendChild(row);

      // Chips are the STRUCTURE's own bonus only, never structure + rigs.
      // A rig's bonus depends on what you are building (rigAffectsProduct)
      // and on system security, so a single combined figure on a card would
      // claim a reduction that may not apply to the job in hand. The rigs
      // are listed below instead, which is what the legacy page did too.
      const bonuses = state.bonusCache[String(facility.structureTypeId)];
      if (bonuses) {
        const chips = el('div', 'fac-bonus-chips');
        [
          ['ME', bonuses.materialEfficiency],
          ['TE', bonuses.timeEfficiency],
          ['Cost', bonuses.costReduction],
        ].forEach(([label, raw]) => {
          const value = Number(raw) || 0;
          const chip = el('span', `fac-bonus-chip${value ? '' : ' is-zero'}`);
          chip.appendChild(el('span', 'fac-bonus-chip-label', label));
          chip.appendChild(el(
            'span',
            'fac-bonus-chip-value',
            value ? `-${value.toFixed(1)}%` : '0%'
          ));
          chips.appendChild(chip);
        });
        chips.title = `${bonuses.structureName || 'Structure'} bonuses. `
          + 'Rig bonuses depend on what is being built and are not included.';
        detail.appendChild(chips);
      }

      const rigIds = facility.rigs || [];
      if (rigIds.length > 0) {
        detail.appendChild(el('div', 'fac-rig-heading', 'Installed Rigs'));
        const rigChips = el('div', 'fac-rig-chip-row');
        rigIds.forEach((rigId) => {
          const rig = state.allRigs.find((r) => String(r.typeId) === String(rigId));
          // `name`, not `typeName` - reading the wrong field is what made
          // these chips render as empty bubbles. Truncated, so the full name
          // has to stay reachable on hover.
          rigChips.appendChild(
            truncatedCell('fac-rig-chip', rig ? rig.name : 'Unknown Rig')
          );
        });
        detail.appendChild(rigChips);
      }

      if (facility.facilityTax !== undefined && facility.facilityTax !== null) {
        const tax = el('div', 'fac-detail-row fac-detail-tax');
        tax.appendChild(el('span', 'fac-detail-label', 'Facility Tax'));
        tax.appendChild(el('span', 'fac-detail-value', `${Number(facility.facilityTax).toFixed(2)}%`));
        detail.appendChild(tax);
      }
    } else {
      detail.appendChild(el(
        'div',
        'fac-station-note',
        'NPC station — no manufacturing bonuses.'
      ));
    }
    body.appendChild(detail);

    card.appendChild(body);
    return card;
  }

  function secClass(sec) {
    if (sec >= 0.5) return 'is-high';
    if (sec > 0) return 'is-low';
    return 'is-null';
  }

  /* ----------------------------------------------------------------- icons */

  function svg(paths, opts) {
    const ns = 'http://www.w3.org/2000/svg';
    const node = document.createElementNS(ns, 'svg');
    node.setAttribute('width', (opts && opts.size) || '14');
    node.setAttribute('height', (opts && opts.size) || '14');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', (opts && opts.width) || '2');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    paths.forEach(([tag, attrs]) => {
      const child = document.createElementNS(ns, tag);
      Object.entries(attrs).forEach(([k, v]) => child.setAttribute(k, v));
      node.appendChild(child);
    });
    return node;
  }

  function iconEdit() {
    return svg([
      ['path', { d: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' }],
      ['path', { d: 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z' }],
    ]);
  }

  function iconTrash() {
    return svg([
      ['polyline', { points: '3 6 5 6 21 6' }],
      ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ], { width: '1.8' });
  }

  function iconPin() {
    return svg([
      ['path', { d: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z' }],
      ['circle', { cx: '12', cy: '10', r: '3' }],
    ], { size: '13' });
  }

  /* -------------------------------------------------------------- edit/save */

  async function startEdit(id) {
    const facility = state.facilities.find((f) => String(f.id) === String(id));
    if (!facility) return;

    state.editingId = facility.id;
    state.form.usage = facility.usage || '';
    state.form.type = facility.facilityType || 'station';
    state.form.regionId = facility.regionId ? String(facility.regionId) : '';
    state.form.systemId = facility.systemId ? String(facility.systemId) : '';
    state.form.structureTypeId = facility.structureTypeId
      ? String(facility.structureTypeId) : '';

    $('fac-name').value = facility.name || '';
    $('fac-type').value = state.form.type;
    $('fac-tax').value = facility.facilityTax !== undefined && facility.facilityTax !== null
      ? Number(facility.facilityTax).toFixed(2)
      : '';

    $('fac-form-title').textContent = 'Edit Facility';
    $('fac-editing-badge').hidden = false;
    $('fac-submit').textContent = 'Save Facility';
    $('fac-clear').textContent = 'Cancel';
    $('fac-form-card').classList.add('is-editing');

    handleTypeChange(state.form.type);
    mountUsageSelect();
    mountRegionSelect();

    // Systems belong to the region, so they have to be fetched before the
    // system select can show the saved value.
    if (state.form.regionId) {
      const systems = await loadSafely('systems', () =>
        window.electronAPI.sde.getAllSystems(parseInt(state.form.regionId, 10))
      );
      state.systems = systems || [];
    }
    mountSystemSelect();

    if (state.form.systemId) {
      await handleSystemChange(state.form.systemId);
    }

    if (state.form.type === 'structure' && state.form.structureTypeId) {
      mountStructureSelect();
      // Seed the saved rigs BEFORE resolving the structure, and tell it to
      // keep them: they were already valid for this structure, so the
      // "structure changed, clear the rigs" rule must not fire here.
      const rigs = facility.rigs || [];
      state.form.rigs = [0, 1, 2].map((i) => (rigs[i] ? String(rigs[i]) : ''));

      await handleStructureChange(state.form.structureTypeId, true);
      // handleStructureChange rebuilds the selects from the fetched pool, so
      // remount once more now that state.rigSize is known.
      mountRigSelects(state.rigSize);
      await handleRigChange();
    }

    // Guarded: scrollIntoView is not implemented in every environment the
    // renderer is exercised in, and failing to scroll must not abort the edit.
    const card = $('fac-form-card');
    if (card && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function clearForm() {
    state.editingId = null;
    state.form = {
      usage: '',
      type: 'station',
      regionId: '',
      systemId: '',
      structureTypeId: '',
      rigs: ['', '', ''],
    };
    state.systems = [];
    state.structureRigs = [];

    $('fac-form').reset();
    $('fac-name').value = '';
    $('fac-tax').value = '';
    $('fac-type').value = 'station';

    $('fac-form-title').textContent = 'Add Facility';
    $('fac-editing-badge').hidden = true;
    $('fac-submit').textContent = 'Add Facility';
    $('fac-clear').textContent = 'Clear';
    $('fac-form-card').classList.remove('is-editing');

    $('fac-cost-panel').hidden = true;
    $('fac-bonus-panel').hidden = true;
    $('fac-rig-panel').hidden = true;
    updateInfoVisibility();

    handleTypeChange('station');
    mountUsageSelect();
    mountRegionSelect();
    mountSystemSelect();
    mountStructureSelect();
    mountRigSelects();
  }

  async function submitForm() {
    const name = $('fac-name').value.trim();

    // Only the field-presence checks live here. The uniqueness and
    // single-default rules are enforced by settings-manager, which throws -
    // duplicating them in the renderer would let the two definitions drift.
    if (!state.form.usage) {
      toast('Select a facility usage.', 'warning');
      return;
    }
    if (!name) {
      toast('Facility name is required.', 'warning');
      return;
    }
    if (!state.form.regionId) {
      toast('Select a region.', 'warning');
      return;
    }
    if (!state.form.systemId) {
      toast('Select a solar system.', 'warning');
      return;
    }
    if (state.form.type === 'structure' && !state.form.structureTypeId) {
      toast('Structure type is required for player structures.', 'warning');
      return;
    }

    const payload = {
      usage: state.form.usage,
      name,
      facilityType: state.form.type,
      regionId: state.form.regionId,
      systemId: state.form.systemId,
    };

    // Security status is derived from the chosen system and stored with the
    // facility; downstream job-cost maths reads it from here.
    const system = state.systems.find(
      (s) => String(s.systemId) === String(state.form.systemId)
    );
    if (system) payload.securityStatus = system.security;

    if (state.form.type === 'structure') {
      payload.structureTypeId = state.form.structureTypeId;
      payload.rigs = state.form.rigs.filter(Boolean);

      const tax = parseFloat($('fac-tax').value);
      if (Number.isFinite(tax)) payload.facilityTax = tax;
    }

    try {
      if (state.editingId) {
        await window.electronAPI.facilities.updateFacility(state.editingId, payload);
        toast('Facility updated.', 'success');
      } else {
        await window.electronAPI.facilities.addFacility(payload);
        toast('Facility added.', 'success');
      }
      clearForm();
      await loadFacilities();
    } catch (error) {
      // main's message names the conflicting facility, so surface it verbatim.
      console.error('[facilities] save failed:', error);
      toast(error.message || 'Failed to save facility.', 'error');
    }
  }

  /**
   * Two-step delete.
   *
   * The button becomes "Confirm?" for a few seconds rather than opening a
   * native confirm(): a modal dialog blocks the whole renderer, and under the
   * shell that freezes every view in the window, not just this one.
   */
  function armRemove(button, facility) {
    if (button.dataset.armed === 'true') {
      disarmRemove();
      removeFacility(facility);
      return;
    }

    // Only one button can be armed at a time, and its timer is tracked so
    // unmount can cancel it. An uncancelled 4s timer outlives the view - it
    // keeps the process alive in tests and fires against a detached button
    // in the app.
    disarmRemove();

    button.dataset.armed = 'true';
    button.classList.add('is-armed');
    button.title = 'Click again to remove';
    const original = button.getAttribute('aria-label');
    button.setAttribute('aria-label', `Confirm removal of ${facility.name}`);

    armedButton = button;
    armedLabel = original;
    armedTimer = setTimeout(disarmRemove, 4000);
  }

  /** Cancel any pending arm and restore its button. Safe to call spuriously. */
  function disarmRemove() {
    if (armedTimer) {
      clearTimeout(armedTimer);
      armedTimer = null;
    }
    if (armedButton) {
      if (armedButton.isConnected) {
        armedButton.dataset.armed = 'false';
        armedButton.classList.remove('is-armed');
        armedButton.title = 'Remove facility';
        if (armedLabel) armedButton.setAttribute('aria-label', armedLabel);
      }
      armedButton = null;
      armedLabel = null;
    }
  }

  async function removeFacility(facility) {

    try {
      await window.electronAPI.facilities.removeFacility(facility.id);
      // Removing the facility being edited would leave the form pointing at
      // something that no longer exists.
      if (String(state.editingId) === String(facility.id)) clearForm();
      toast('Facility removed.', 'success');
      await loadFacilities();
    } catch (error) {
      console.error('[facilities] remove failed:', error);
      toast(error.message || 'Failed to remove facility.', 'error');
    }
  }

  /* ------------------------------------------------------------------ mount */

  async function loadTemplate() {
    const inline = $('facilities-view-template');
    if (inline) return inline.content.cloneNode(true);

    if (!templateCache) {
      try {
        const html = await fetch(TEMPLATE_URL).then((r) => r.text());
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const tpl = parsed.getElementById('facilities-view-template');
        if (!tpl) {
          console.error('[facilities] template not found');
          return null;
        }
        templateCache = tpl;
      } catch (error) {
        console.error('[facilities] template load failed:', error);
        return null;
      }
    }
    return templateCache.content.cloneNode(true);
  }

  async function mount(container, params, ctx) {
    const fragment = await loadTemplate();
    if (!fragment) {
      container.appendChild(el('div', 'empty-state', 'Failed to load Facilities.'));
      return {};
    }
    container.appendChild(fragment);

    ctx.on($('fac-type'), 'change', (e) => handleTypeChange(e.target.value));
    ctx.on($('fac-structure'), 'change', (e) => handleStructureChange(e.target.value));
    ctx.on($('fac-clear'), 'click', () => clearForm());
    ctx.on($('fac-form'), 'submit', (e) => {
      e.preventDefault();
      submitForm();
    });

    await loadInitialData();
    await loadFacilities();

    // The facility list is settings-backed, not ESI-backed, so nothing on the
    // data bus changes it. It only changes through this view.
    return {
      destroy() {
        destroySelects();
        // A pending arm timer would otherwise outlive the view.
        disarmRemove();
      },
    };
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('facilities', {
      title: 'Facilities',
      mount,
    });
  }
})();
