/**
 * Skills Manager — native shell view.
 *
 * Ported from "Character Skills (1a).dc.html". Replaces the flat alphabetical
 * list in skills-renderer.js with skill-group cards, faceted filtering and a
 * summary strip.
 *
 * Behaviours carried over from the live screen (all still here):
 *   - skill overrides via a 0-5 level selector; clicking the trained level
 *     REMOVES the override rather than setting a redundant one
 *   - the trained level stays marked while an override is in effect, so you can
 *     always see what you actually have
 *   - Clear All Overrides, behind a confirmation
 *   - Refresh from API, disabled while the ESI cache is still valid, with a
 *     live countdown on the button
 *   - search by skill name OR skill id
 *   - Trained / Overridden / Untrained filters, with Trained and Untrained
 *     mutually exclusive
 *   - graceful degradation when the SDE is missing (ids instead of names)
 *
 * New here, and why: the mockup groups skills, which the live screen does not.
 * Groups and training rank come from the SDE via ONE batched `getSkillInfo`
 * call - a character has 300-500 skills, so a per-skill lookup is exactly the
 * pattern that made the Assets screen unusable.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------- state

  const state = {
    characterId: null,
    character: null,
    skills: [],
    loading: true,
    sdeMissing: false,

    query: '',
    show: { trained: true, overridden: false, untrained: false },
    groups: {},
    collapsed: {},
  };

  let els = {};
  let cacheCountdown = null;
  /** Remaining cache time (e.g. "3m 12s") while gated, else null. */
  let cacheLabel = null;

  // ------------------------------------------------------------ formatting

  function fmtNumber(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
  }

  function fmtSp(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(0)}K`;
    return fmtNumber(v);
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
    node.setAttribute('stroke-width', '2.4');
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
   * screen did nothing at all and the gated-refresh feedback never appeared.
   */
  function toast(message, type = 'info') {
    if (window.QFToast && typeof window.QFToast.show === 'function') {
      window.QFToast.show(message, type);
    } else {
      console.log(`[skills] ${message}`);
    }
  }

  // ------------------------------------------------------------ data load

  /**
   * Build the skill list from the CACHED character record plus one batched SDE
   * lookup. Never calls ESI - `esi.getCharacter` reads the local store.
   */
  async function loadSkills() {
    state.loading = true;
    state.sdeMissing = false;
    render();

    const character = state.character;
    const skillMap = (character && character.skills && character.skills.skills) || {};
    const overrides = (character && character.skillOverrides) || {};

    const rows = Object.values(skillMap);
    if (rows.length === 0) {
      state.skills = [];
      state.loading = false;
      render();
      return;
    }

    const skillIds = rows.map((s) => s.skillId);

    // One query for names, groups and ranks.
    let info = {};
    try {
      info = await window.electronAPI.sde.getSkillInfo(skillIds);
    } catch (error) {
      console.error('[skills] Could not load skill info:', error);
      // The live screen degrades to bare ids when the SDE is missing rather
      // than showing nothing; keep that.
      state.sdeMissing = !!(error.message && error.message.includes('SDE database not found'));
      info = {};
    }

    state.skills = rows.map((skill) => {
      const meta = info[skill.skillId] || {};
      const trained = Number(skill.trainedSkillLevel) || 0;
      const override = overrides[skill.skillId];
      const hasOverride = override !== undefined && override !== null;

      return {
        skillId: skill.skillId,
        name: meta.name || `Skill ${skill.skillId}`,
        groupName: meta.groupName || 'Other',
        rank: meta.rank || 1,
        trained,
        sp: Number(skill.skillpointsInSkill) || 0,
        hasOverride,
        // The effective level is what every calculation downstream uses.
        effective: hasOverride ? Number(override) : trained,
      };
    });

    state.loading = false;
    render();
  }

  // ---------------------------------------------------------- filter logic

  function anyActive(map) {
    return Object.values(map).some(Boolean);
  }

  /**
   * Status classification, matching the live screen exactly:
   *   trained   - has trained levels OR an override (an overridden skill still
   *               belongs with the trained ones)
   *   untrained - no trained levels and no override
   */
  function isTrained(skill) {
    return skill.trained > 0 || skill.hasOverride;
  }

  function isUntrained(skill) {
    return skill.trained === 0 && !skill.hasOverride;
  }

  function passesStatus(skill) {
    // "Overridden" is exclusive: when it is on, ONLY overridden skills show.
    if (state.show.overridden && !skill.hasOverride) return false;
    if (isTrained(skill) && !state.show.trained && !state.show.overridden) return false;
    if (isUntrained(skill) && !state.show.untrained) return false;
    return true;
  }

  function passesFilters(skill) {
    const q = state.query.trim().toLowerCase();
    if (q) {
      // Searchable by id as well as name - the live screen allows this and it
      // is genuinely useful when the SDE is missing and names are bare ids.
      const matchesName = skill.name.toLowerCase().includes(q);
      const matchesId = String(skill.skillId).includes(q);
      if (!matchesName && !matchesId) return false;
    }
    if (anyActive(state.groups) && !state.groups[skill.groupName]) return false;
    return passesStatus(skill);
  }

  function filteredSkills() {
    return state.skills.filter(passesFilters);
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
      console.error('[skills] Render failed:', error);
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

    const totalSp = (character.skills && character.skills.totalSp) || 0;
    els.totalSp.textContent = fmtNumber(totalSp);

    // Only offer "Clear All Overrides" when there is something to clear.
    els.clearOverrides.hidden = !state.skills.some((s) => s.hasOverride);
  }

  function renderSummary() {
    const character = state.character;
    const totalSp = (character && character.skills && character.skills.totalSp) || 0;
    const trained = state.skills.filter(isTrained).length;
    const atFive = state.skills.filter((s) => s.trained === 5).length;
    const overrides = state.skills.filter((s) => s.hasOverride).length;

    const stats = [
      { label: 'Total SP', value: fmtNumber(totalSp), accent: true },
      { label: 'Skills Trained', value: fmtNumber(trained) },
      { label: 'At Level 5', value: fmtNumber(atFive) },
      { label: 'Overrides', value: fmtNumber(overrides), accent: overrides > 0 },
    ];

    els.summary.replaceChildren(...stats.map((s) => {
      const wrap = el('div', 'sk-stat');
      wrap.appendChild(el('div', 'sk-stat-label', s.label));
      wrap.appendChild(el('div', `sk-stat-value${s.accent ? ' is-accent' : ''}`, s.value));
      return wrap;
    }));
  }

  function facetRow(label, count, on, onToggle) {
    const row = el('div', `sk-facet${on ? ' is-on' : ''}`);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-pressed', on ? 'true' : 'false');
    row.appendChild(checkbox(on));
    row.appendChild(el('span', 'sk-facet-label', label));
    row.appendChild(el('span', 'sk-facet-count', fmtNumber(count)));
    row.addEventListener('click', onToggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
    });
    return row;
  }

  function renderFilters() {
    const counts = {
      trained: state.skills.filter(isTrained).length,
      overridden: state.skills.filter((s) => s.hasOverride).length,
      untrained: state.skills.filter(isUntrained).length,
    };

    const STATUS = [
      ['trained', 'Trained'],
      ['overridden', 'Overridden'],
      ['untrained', 'Untrained'],
    ];

    els.statusFilters.replaceChildren(...STATUS.map(([key, label]) => facetRow(
      label, counts[key], !!state.show[key],
      () => {
        state.show[key] = !state.show[key];
        // Trained and Untrained are mutually exclusive - turning one on turns
        // the other off. The live screen does this, and without it the pair
        // reads as "show everything", which is what the All filter is for.
        if (key === 'trained' && state.show.trained) state.show.untrained = false;
        if (key === 'untrained' && state.show.untrained) state.show.trained = false;
        render();
      }
    )));

    // Group facet counts are over ALL skills, so a group does not vanish just
    // because the current status filter excludes its members.
    const groupCounts = {};
    state.skills.forEach((s) => {
      groupCounts[s.groupName] = (groupCounts[s.groupName] || 0) + 1;
    });

    // Most-populated first: a character's biggest skill groups are the ones
    // worth reaching for.
    const groupNames = Object.keys(groupCounts).sort(
      (a, b) => groupCounts[b] - groupCounts[a] || a.localeCompare(b)
    );

    els.groupFacets.replaceChildren(...groupNames.map((name) => facetRow(
      name, groupCounts[name], !!state.groups[name],
      () => { state.groups[name] = !state.groups[name]; render(); }
    )));

    els.clearGroups.hidden = !anyActive(state.groups);
  }

  /** One 0-5 pip. */
  function levelPip(skill, level) {
    const pip = el('button', 'sk-level', String(level));
    pip.type = 'button';

    if (level === skill.effective) {
      pip.classList.add('is-current');
      if (skill.hasOverride) pip.classList.add('is-override');
    } else if (level <= skill.effective) {
      pip.classList.add('is-filled');
    }

    // While an override is in effect, keep the ACTUAL trained level marked so
    // it is never lost from view.
    if (skill.hasOverride && level === skill.trained && skill.trained !== skill.effective) {
      pip.classList.add('is-trained-marker');
    }

    const isTrainedLevel = level === skill.trained;
    pip.title = isTrainedLevel
      ? `Level ${level} — actual trained level (clears any override)`
      : `Set override to level ${level}`;
    pip.setAttribute('aria-label', `${skill.name}: ${pip.title}`);

    pip.addEventListener('click', () => setSkillLevel(skill, level));
    return pip;
  }

  function skillRow(skill) {
    const row = el('div', `sk-row${skill.hasOverride ? ' is-overridden' : ''}`);

    const info = el('div', 'sk-row-info');
    const title = el('div', 'sk-row-title');
    title.appendChild(el('span', 'sk-row-name', skill.name));
    if (skill.hasOverride) {
      title.appendChild(el('span', 'sk-override-badge', `Override ${skill.effective}`));
    }
    info.appendChild(title);

    const meta = el('div', 'sk-row-meta');
    meta.appendChild(document.createTextNode(`Trained Level ${skill.trained} · `));
    meta.appendChild(el('span', 'sk-mono-faint', fmtNumber(skill.sp)));
    meta.appendChild(document.createTextNode(` SP · rank x${skill.rank}`));
    info.appendChild(meta);

    row.appendChild(info);

    const levels = el('div', 'sk-levels');
    for (let level = 0; level <= 5; level += 1) {
      levels.appendChild(levelPip(skill, level));
    }
    row.appendChild(levels);

    return row;
  }

  function renderGroups() {
    els.loading.hidden = !state.loading;
    if (state.loading) {
      els.groups.hidden = true;
      els.empty.hidden = true;
      return;
    }

    const rows = filteredSkills();

    if (rows.length === 0) {
      els.groups.hidden = true;
      els.empty.hidden = false;

      if (state.skills.length === 0) {
        els.emptyTitle.textContent = 'No skills loaded';
        els.emptyText.textContent =
          'Click "Refresh from API" to fetch this character\'s skills from Eve Online.';
      } else {
        els.emptyTitle.textContent = 'No skills match';
        els.emptyText.textContent =
          'Adjust your search or filters, or click "Refresh from API" to fetch skills from Eve Online.';
      }
      return;
    }

    els.groups.hidden = false;
    els.empty.hidden = true;

    const byGroup = new Map();
    rows.forEach((skill) => {
      if (!byGroup.has(skill.groupName)) byGroup.set(skill.groupName, []);
      byGroup.get(skill.groupName).push(skill);
    });

    const groupNames = [...byGroup.keys()].sort((a, b) => a.localeCompare(b));

    els.groups.replaceChildren(...groupNames.map((name) => {
      const skills = byGroup.get(name).slice().sort((a, b) => a.name.localeCompare(b.name));
      const open = !state.collapsed[name];
      const trainedCount = skills.filter((s) => s.effective > 0).length;

      const card = el('div', `sk-group${open ? ' is-open' : ''}`);
      card.appendChild(el('div', 'sk-group-accent'));

      const head = el('div', 'sk-group-head');
      head.setAttribute('role', 'button');
      head.tabIndex = 0;
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      head.appendChild(svg(['M9 18l6-6-6-6'], 12, 'sk-group-chevron'));
      head.appendChild(el('span', 'sk-group-name', name));
      head.appendChild(el('span', 'sk-group-trained', `${trainedCount}/${skills.length} trained`));
      head.appendChild(el('span', 'sk-group-count', fmtNumber(skills.length)));

      const toggle = () => {
        state.collapsed[name] = !state.collapsed[name];
        render();
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });

      card.appendChild(head);

      if (open) {
        const body = el('div', 'sk-group-body');
        skills.forEach((skill) => body.appendChild(skillRow(skill)));
        card.appendChild(body);
      }

      return card;
    }));
  }

  function renderStatusLine() {
    const shown = filteredSkills().length;
    els.shownCount.textContent = `${fmtNumber(shown)} of ${fmtNumber(state.skills.length)} skills shown`;
  }

  /** Clear the search box and return focus to it, ready for the next query. */
  function clearSearch() {
    state.query = '';
    els.search.value = '';
    els.searchClear.hidden = true;
    els.search.focus();
    render();
  }

  // --------------------------------------------------------------- actions

  /**
   * Set (or clear) an override.
   *
   * Clicking the ACTUAL trained level clears the override rather than storing a
   * redundant one - that is how the live screen behaves, and it is the only way
   * to get back to "no override" from the UI.
   */
  async function setSkillLevel(skill, level) {
    const nextLevel = level === skill.trained ? null : level;

    // Optimistic: the pips should respond immediately, not after a round trip.
    const previous = { hasOverride: skill.hasOverride, effective: skill.effective };
    skill.hasOverride = nextLevel !== null;
    skill.effective = nextLevel !== null ? nextLevel : skill.trained;
    render();

    try {
      const ok = await window.electronAPI.skills.setOverride(
        state.characterId, skill.skillId, nextLevel
      );
      if (!ok) throw new Error('The override was not saved');

      // Re-read the character so `skillOverrides` in memory matches what was
      // persisted; other views read the same record.
      state.character = await window.electronAPI.esi.getCharacter(state.characterId);
    } catch (error) {
      console.error('[skills] Could not set override:', error);
      skill.hasOverride = previous.hasOverride;
      skill.effective = previous.effective;
      render();
      toast(`Could not set the override: ${error.message}`, 'error');
    }
  }

  function openConfirmModal() {
    const count = state.skills.filter((s) => s.hasOverride).length;
    els.confirmText.textContent = count === 1
      ? 'Clear the 1 skill override and return it to its trained level?'
      : `Clear all ${fmtNumber(count)} skill overrides and return them to their trained levels?`;
    els.confirmModal.hidden = false;
    els.confirmOk.focus();
  }

  function closeConfirmModal() {
    els.confirmModal.hidden = true;
  }

  async function confirmClearOverrides() {
    closeConfirmModal();

    try {
      const ok = await window.electronAPI.skills.clearOverrides(state.characterId);
      if (!ok) throw new Error('The overrides were not cleared');

      state.character = await window.electronAPI.esi.getCharacter(state.characterId);
      await loadSkills();
      toast('All overrides cleared', 'success');
    } catch (error) {
      console.error('[skills] Could not clear overrides:', error);
      // The live screen used alert(), which under the shell freezes the whole
      // window behind a modal dialog.
      toast(`Could not clear overrides: ${error.message}`, 'error');
    }
  }

  async function handleRefresh() {
    if (!els.refreshBtn) return;
    // Already in flight. withButtonBusy guards this too; returning here keeps
    // the gated check below from firing on a second click.
    if (QFUI.isBusy(els.refreshBtn)) return;

    // Gated by the ESI cache. Say so immediately rather than round-tripping to
    // main just to be told the same thing.
    if (els.refreshBtn.classList.contains('is-gated')) {
      toast(
        cacheLabel
          ? `Skills are already up to date. ESI has nothing newer for another ${cacheLabel}.`
          : 'Skills are already up to date.',
        'info'
      );
      return;
    }

    await QFUI.withButtonBusy(els.refreshBtn, 'Refreshing…', async () => {
      try {
        const result = await window.electronAPI.skills.fetch(state.characterId);
        if (!result || !result.success) {
          throw new Error((result && result.error) || 'Unknown error');
        }

        // Gated: ESI was never asked, so the stored skills are unchanged and
        // still correct. Reloading would be harmless but claiming a refresh
        // would not be.
        if (result.skipped) {
          toast(result.reason || 'Skills are already up to date', 'info');
          return;
        }

        state.character = await window.electronAPI.esi.getCharacter(state.characterId);
        await loadSkills();
        toast('Skills refreshed', 'success');
      } catch (error) {
        console.error('[skills] Refresh failed:', error);
        toast(`Failed to refresh skills: ${error.message}`, 'error');
      }
    });

    // Re-sync AFTER the busy restore: a successful fetch starts a fresh cache
    // window, and this re-applies `is-gated` and the countdown label. Run
    // inside the busy window it would be overwritten by the restore.
    startCacheCountdown();
  }

  // --------------------------------------------------------- cache display

  /**
   * Drives the Refresh button's label and disabled state from the ESI cache.
   *
   * Uses the shared countdown rather than a local poll: the handler returns an
   * absolute `expiresAt`, so the clock ticks locally and only re-syncs when the
   * data actually changes.
   */
  function startCacheCountdown() {
    if (cacheCountdown) {
      cacheCountdown();
      cacheCountdown = null;
    }

    if (!window.QFCacheCountdown) return;

    cacheCountdown = window.QFCacheCountdown.attach({
      getStatus: () => window.electronAPI.skills.getCacheStatus(state.characterId),
      endpointTypes: ['skills'],
      render: ({ cached, label }) => {
        if (!els.refreshBtn) return;

        // The button stays ENABLED while the ESI cache is valid.
        //
        // Disabling it looked broken: a disabled <button> swallows the click
        // outright, so no handler ran, no toast appeared, and there was no
        // cursor feedback either - the user got nothing at all. Keeping it
        // clickable lets handleRefresh explain WHY nothing was fetched.
        //
        // `is-gated` styles it as unavailable without removing the click.
        els.refreshBtn.classList.toggle('is-gated', cached);
        // Ticks once a second, so it must not stomp the in-flight label.
        if (!QFUI.isBusy(els.refreshBtn)) {
          els.refreshLabel.textContent = cached ? `Cached (${label})` : 'Refresh from API';
        }
        els.refreshBtn.title = cached
          ? `ESI has no newer skills yet - cache expires in ${label}`
          : 'Fetch the latest skills from ESI';
        els.cacheStatus.textContent = cached ? `Cache expires in ${label}` : 'Cache expired';

        // Remembered so a click during the window can name the remaining time.
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
    // skills and filters.
    state.character = null;
    state.skills = [];
    state.loading = true;
    state.sdeMissing = false;
    state.query = '';
    state.show = { trained: true, overridden: false, untrained: false };
    state.groups = {};
    state.collapsed = {};

    await QFUI.loadViewTemplate(container, 'skills.view.html');

    els = {
      root: container.querySelector('#skills-view'),
      portrait: container.querySelector('#sk-portrait'),
      name: container.querySelector('#sk-character-name'),
      totalSp: container.querySelector('#sk-total-sp'),
      clearOverrides: container.querySelector('#sk-clear-overrides'),
      refreshBtn: container.querySelector('#sk-refresh-btn'),
      refreshLabel: container.querySelector('#sk-refresh-label'),
      summary: container.querySelector('#sk-summary'),
      search: container.querySelector('#sk-search'),
      searchClear: container.querySelector('#sk-search-clear'),
      statusFilters: container.querySelector('#sk-status-filters'),
      groupFacets: container.querySelector('#sk-group-facets'),
      clearGroups: container.querySelector('#sk-clear-groups'),
      loading: container.querySelector('#sk-loading'),
      groups: container.querySelector('#sk-groups'),
      empty: container.querySelector('#sk-empty'),
      emptyTitle: container.querySelector('#sk-empty-title'),
      emptyText: container.querySelector('#sk-empty-text'),
      shownCount: container.querySelector('#sk-shown-count'),
      cacheStatus: container.querySelector('#sk-cache-status'),
      confirmModal: container.querySelector('#sk-confirm-modal'),
      confirmText: container.querySelector('#sk-confirm-text'),
      confirmClose: container.querySelector('#sk-confirm-close'),
      confirmCancel: container.querySelector('#sk-confirm-cancel'),
      confirmOk: container.querySelector('#sk-confirm-ok'),
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
      els.emptyText.textContent = 'Open the Skills Manager from a character to see their skills.';
      return {};
    }

    state.character = await window.electronAPI.esi.getCharacter(state.characterId)
      .catch((error) => {
        console.error('[skills] Could not load character:', error);
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

    ctx.on(els.clearGroups, 'click', () => { state.groups = {}; render(); });
    ctx.on(els.refreshBtn, 'click', handleRefresh);
    ctx.on(els.clearOverrides, 'click', openConfirmModal);

    ctx.on(els.confirmClose, 'click', closeConfirmModal);
    ctx.on(els.confirmCancel, 'click', closeConfirmModal);
    ctx.on(els.confirmOk, 'click', confirmClearOverrides);
    ctx.on(els.confirmModal, 'click', (e) => {
      if (e.target === els.confirmModal) closeConfirmModal();
    });
    ctx.on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && !els.confirmModal.hidden) closeConfirmModal();
    });

    await loadSkills();
    startCacheCountdown();

    // Live updates: reload when the background cycle lands new skill data,
    // rather than polling for it.
    const api = window.electronAPI.data;
    if (api && api.onChanged) {
      ctx.track(api.onChanged((info) => {
        if (String(info && info.endpointType) !== 'skills') return;
        window.electronAPI.esi.getCharacter(state.characterId)
          .then((character) => {
            state.character = character;
            return loadSkills();
          })
          .catch((error) => console.error('[skills] Live reload failed:', error));
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
    els = {};
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('skills', {
      title: 'Skills Manager',
      mount,
      destroy,
    });
  }
})();
