/**
 * ESI Status - native shell view.
 *
 * Shows every tracked ESI endpoint, per character and for the universe-wide
 * calls, with cache/rate-limit state and recent call history.
 *
 * Reactivity: this screen exists to show ESI call activity, so it is driven by
 * `data.onChanged` (emitted on every ESI call) rather than a blind poll. Events
 * are COALESCED - a paginated fetch emits once per endpoint, and a reload per
 * event would hammer the DB for no visual benefit. A slow interval remains as a
 * fallback so relative timestamps ("4 minutes ago") keep ticking when nothing
 * is emitting.
 *
 * Re-renders are SURGICAL: the nav, list and detail panes update in place so a
 * background refresh cannot steal the user's selection or reset their scroll
 * position mid-read.
 */

(function () {
  'use strict';

  /** Coalescing window for burst ESI events. */
  const EVENT_COALESCE_MS = 400;

  /** Fallback tick, only so relative timestamps stay honest. */
  const FALLBACK_REFRESH_MS = 60000;

  /** An error older than this is stale news - a warning, not an active fault. */
  const ERROR_RECENT_MS = 60 * 60 * 1000;

  const state = {
    /** 'character' | 'universe' | null */
    navKind: null,
    characterId: null,
    characterName: null,
    /** Selection is by endpoint LABEL, since a row may stand for many keys. */
    selectedLabel: null,
    characters: [],
    /** Groups currently rendered, so the detail pane can read their members. */
    groups: [],
  };

  let els = null;

  /* ============================================================
     Status derivation
     ============================================================ */

  /**
   * Colour for a single call.
   *
   * An error only shows red while it is RECENT; older failures fade to yellow
   * so a long-resolved blip does not leave the screen permanently alarming.
   */
  function getStatusColor(call) {
    if (call.status === 'success') return 'green';
    if (call.status === 'error') {
      const recent = call.updated_at && call.updated_at > Date.now() - ERROR_RECENT_MS;
      return recent ? 'red' : 'yellow';
    }
    if (call.status === 'in_progress') return 'yellow';
    return 'gray';
  }

  /** Worst-case colour across a character's calls, for the nav dot. */
  function getOverallStatus(calls) {
    if (!calls || calls.length === 0) return 'gray';

    let hasError = false;
    let hasWarning = false;
    const cutoff = Date.now() - ERROR_RECENT_MS;

    for (const call of calls) {
      if (call.status === 'error') {
        if (call.updated_at && call.updated_at > cutoff) hasError = true;
        else hasWarning = true;
      } else if (call.status === 'in_progress') {
        hasWarning = true;
      }
    }

    if (hasError) return 'red';
    if (hasWarning) return 'yellow';
    return 'green';
  }

  function badgeClassFor(status) {
    if (status === 'success') return 'success';
    if (status === 'error') return 'error';
    return 'warning';
  }

  /* ============================================================
     Grouping

     A `call_key` carries its arguments - `structure_1049960197509`,
     `universe_market_orders_10000002` - so one logical endpoint produces one
     ROW PER ARGUMENT. A live database holds 147 "Structure Info" rows, which
     buries the five endpoints that actually differ.

     This collapses them FOR DISPLAY ONLY. The table keeps its per-key rows;
     nothing here writes, and the tracker is untouched. A group's status is its
     WORST member, so one failure among 147 successes still surfaces.
     ============================================================ */

  /** Severity order, worst first - a group takes the worst state it contains. */
  const SEVERITY = ['red', 'yellow', 'gray', 'green'];

  function worstColor(colors) {
    for (const candidate of SEVERITY) {
      if (colors.includes(candidate)) return candidate;
    }
    return 'gray';
  }

  /**
   * Collapse call rows by endpoint label, preserving source order.
   *
   * @returns {Array<{label, members, color, status, count, lastQueryAt, errorCount}>}
   */
  function groupCalls(callRows) {
    const byLabel = new Map();

    callRows.forEach((row) => {
      const label = row.endpoint_label || row.call_key;
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(row);
    });

    return [...byLabel.entries()].map(([label, members]) => {
      const color = worstColor(members.map(getStatusColor));

      // The badge reports the worst member's status for the same reason the
      // dot does; with one member it is simply that member's status.
      const failing = members.filter((m) => m.status === 'error');
      const inFlight = members.filter((m) => m.status === 'in_progress');
      let status = 'success';
      if (failing.length) status = 'error';
      else if (inFlight.length) status = 'in_progress';
      else if (members.every((m) => m.status === 'pending')) status = 'pending';

      return {
        label,
        members,
        color,
        status,
        count: members.length,
        errorCount: failing.length,
        // Most recent activity across the group - "last query" for a group is
        // the freshest member, not an arbitrary one.
        lastQueryAt: members.reduce(
          (latest, m) => (m.last_query_at && m.last_query_at > latest ? m.last_query_at : latest),
          0
        ) || null,
      };
    });
  }

  /* ============================================================
     Formatting
     ============================================================ */

  function formatTimestamp(timestamp) {
    if (!timestamp) return 'Never';

    const diff = Date.now() - timestamp;

    if (diff < 0) {
      const abs = Math.abs(diff);
      const seconds = Math.floor(abs / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (days > 0) return `in ${days} day${days > 1 ? 's' : ''}`;
      if (hours > 0) return `in ${hours} hour${hours > 1 ? 's' : ''}`;
      if (minutes > 0) return `in ${minutes} minute${minutes > 1 ? 's' : ''}`;
      return `in ${seconds} second${seconds > 1 ? 's' : ''}`;
    }

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 7) return new Date(timestamp).toLocaleString();
    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    if (seconds > 5) return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
    return 'just now';
  }

  /**
   * When this endpoint may next be queried, and why.
   *
   * Cache expiry and rate limiting are different constraints with different
   * remedies, so they are labelled differently rather than merged into one
   * "next query" figure.
   */
  function nextQueryRow(call) {
    const now = Date.now();
    let target = null;
    let label = '';
    let tone = '';

    if (call.cache_expires_at && call.cache_expires_at > now) {
      target = call.cache_expires_at;
      label = 'Next automatic query';
    } else if (call.next_allowed_at && call.next_allowed_at > now) {
      target = call.next_allowed_at;
      label = 'Rate limited until';
      tone = 'is-warning';
    }

    if (!target) return null;

    const seconds = Math.floor((target - now) / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    let countdown;
    if (hours > 0) countdown = `in ${hours}h ${minutes % 60}m`;
    else if (minutes > 0) countdown = `in ${minutes}m ${seconds % 60}s`;
    else countdown = `in ${seconds}s`;

    return { label, value: countdown, tone };
  }

  /* ============================================================
     DOM helpers
     ============================================================ */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function svgIcon(paths, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach((d) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  /** Empty/error state block, shared by the list and detail panes. */
  function emptyState(className, title, desc, iconPaths) {
    const wrap = el('div', className);
    const icon = el('div', 'esi-empty-icon');
    icon.appendChild(svgIcon(iconPaths || ['M3 3v18h18', 'M18 17V9M13 17V5M8 17v-3'], 26));
    wrap.appendChild(icon);
    wrap.appendChild(el('div', 'esi-empty-title', title));
    if (desc) wrap.appendChild(el('div', 'esi-empty-desc', desc));
    return wrap;
  }

  function kvRow(label, value, tone) {
    const row = el('div', 'esi-kv');
    row.appendChild(el('span', 'esi-kv-label', label));
    row.appendChild(el('span', `esi-kv-value${tone ? ' ' + tone : ''}`, value));
    return row;
  }

  function section(title) {
    const wrap = el('div', 'esi-section');
    wrap.appendChild(el('div', 'esi-section-title', title));
    return wrap;
  }

  /* ============================================================
     Navigation pane
     ============================================================ */

  async function renderNav() {
    let characters;
    try {
      characters = await window.electronAPI.esi.getCharacters();
    } catch (error) {
      console.error('[ESI Status] Error loading characters:', error);
      els.charNav.replaceChildren(el('div', 'esi-nav-error', 'Error loading characters'));
      return;
    }

    state.characters = characters || [];

    if (state.characters.length === 0) {
      els.charNav.replaceChildren(el('div', 'esi-nav-empty', 'No characters found'));
      return;
    }

    // Endpoint rows must exist before their status can be read, and the dot
    // needs each character's calls - so initialise and fetch together.
    const rows = await Promise.all(
      state.characters.map(async (character) => {
        try {
          await window.electronAPI.esiStatus.initializeCharacter(
            character.characterId,
            character.characterName
          );
          const calls = await window.electronAPI.esiStatus.getCharacterCalls(character.characterId);
          return { character, color: getOverallStatus(calls) };
        } catch (error) {
          console.error(
            `[ESI Status] Error preparing character ${character.characterId}:`,
            error
          );
          return { character, color: 'gray' };
        }
      })
    );

    const frag = document.createDocumentFragment();

    rows.forEach(({ character, color }) => {
      const item = el('div', 'esi-nav-item');
      item.dataset.view = 'character';
      item.dataset.characterId = String(character.characterId);
      item.setAttribute('role', 'button');
      item.tabIndex = 0;

      const dot = el('span', `esi-dot is-${color}`);
      dot.setAttribute('aria-hidden', 'true');
      item.appendChild(dot);

      const portrait = document.createElement('img');
      portrait.className = 'esi-nav-portrait';
      portrait.alt = '';
      portrait.src = `https://images.evetech.net/characters/${character.characterId}/portrait?size=64`;
      item.appendChild(portrait);

      item.appendChild(el('span', 'esi-nav-name', character.characterName));

      const activate = () => selectCharacter(character.characterId, character.characterName);
      item.addEventListener('click', activate);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });

      frag.appendChild(item);
    });

    els.charNav.replaceChildren(frag);
    syncNavHighlight();
  }

  /**
   * Move the active highlight without rebuilding the rows.
   *
   * Rebuilding would discard scroll position and every row listener, and on a
   * hover-driven path it would destroy the element a click started on
   * (binding rule 2a).
   */
  function syncNavHighlight() {
    const nodes = els.view.querySelectorAll('.esi-nav-item');
    nodes.forEach((node) => {
      const isChar =
        state.navKind === 'character' &&
        node.dataset.view === 'character' &&
        node.dataset.characterId === String(state.characterId);
      const isUniverse = state.navKind === 'universe' && node.dataset.view === 'universe';
      node.classList.toggle('is-active', isChar || isUniverse);
    });
  }

  /* ============================================================
     Call list pane
     ============================================================ */

  function buildCallRow(group) {
    const row = el('div', 'esi-call');
    // Rows are identified by LABEL now, since a row may stand for many keys.
    row.dataset.label = group.label;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

    const color = group.color;
    // The stripe colour rides on a custom property so the selected and
    // unselected box-shadows can both reference it without either branch
    // having to restate the other's layers.
    row.style.setProperty(
      '--qf-call-accent',
      color === 'gray' ? 'var(--qf-border)' : `var(--qf-${
        color === 'green' ? 'success' : color === 'red' ? 'error' : 'warning'
      })`
    );

    const head = el('div', 'esi-call-head');
    const title = el('div', 'esi-call-title');
    const dot = el('span', `esi-dot is-${color}`);
    dot.setAttribute('aria-hidden', 'true');
    title.appendChild(dot);
    title.appendChild(el('span', 'esi-call-label', group.label));

    // Only worth showing when it stands for more than itself.
    if (group.count > 1) {
      title.appendChild(el('span', 'esi-call-count', `×${group.count}`));
    }
    head.appendChild(title);

    head.appendChild(
      el('span', `badge ${badgeClassFor(group.status)}`, String(group.status || '').toUpperCase())
    );
    row.appendChild(head);

    const meta = `Last query: ${
      group.lastQueryAt ? formatTimestamp(group.lastQueryAt) : 'Never'
    }`;
    row.appendChild(
      el(
        'div',
        'esi-call-meta',
        group.errorCount > 0 && group.count > 1
          ? `${meta} · ${group.errorCount} of ${group.count} failing`
          : meta
      )
    );

    const activate = () => selectCall(group.label);
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });

    return row;
  }

  function syncCallHighlight() {
    els.callsList.querySelectorAll('.esi-call').forEach((row) => {
      row.classList.toggle('is-selected', row.dataset.label === state.selectedLabel);
    });
  }

  /** Fetch and render the call list for whatever nav item is active. */
  async function renderCalls() {
    if (!state.navKind) return;

    let calls;
    try {
      calls =
        state.navKind === 'character'
          ? await window.electronAPI.esiStatus.getCharacterCalls(state.characterId)
          : await window.electronAPI.esiStatus.getUniverseCalls();
    } catch (error) {
      console.error('[ESI Status] Error loading calls:', error);
      els.callsList.replaceChildren(
        emptyState('esi-calls-empty', 'Error loading calls', error.message)
      );
      return;
    }

    if (!calls || calls.length === 0) {
      els.callsList.replaceChildren(
        emptyState(
          'esi-calls-empty',
          state.navKind === 'character'
            ? 'No ESI calls for this character'
            : 'No universe ESI calls',
          'Calls appear here once data is fetched'
        )
      );
      return;
    }

    // Collapsed for DISPLAY only - the underlying per-key rows are untouched.
    state.groups = groupCalls(calls);

    const frag = document.createDocumentFragment();
    state.groups.forEach((group) => frag.appendChild(buildCallRow(group)));
    els.callsList.replaceChildren(frag);

    // A refresh must not silently drop the user's selection: if the selected
    // endpoint is gone, clear the detail pane rather than leaving it showing
    // a call that no longer exists.
    if (state.selectedLabel) {
      const stillPresent = state.groups.some((g) => g.label === state.selectedLabel);
      if (stillPresent) syncCallHighlight();
      else clearDetail();
    }
  }

  /* ============================================================
     Detail pane
     ============================================================ */

  function clearDetail() {
    state.selectedLabel = null;
    syncCallHighlight();
    els.detail.replaceChildren(
      emptyState('esi-detail-empty', 'Select a call', 'Click any call to see its details', [
        'M9 11l3 3L22 4',
        'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
      ])
    );
  }

  async function selectCall(label) {
    state.selectedLabel = label;
    syncCallHighlight();
    await renderDetail();
  }

  /** How many member keys a group lists before it stops enumerating. */
  const MEMBER_LIST_LIMIT = 12;

  /**
   * Detail for a collapsed group.
   *
   * Built entirely from the rows already fetched for the list. Enumerating all
   * 147 keys would just relocate the clutter, so this leads with the roll-up
   * and then names the members that are actually FAILING - the ones a reader
   * of this screen came to find.
   */
  function renderGroupDetail(group) {
    const frag = document.createDocumentFragment();

    const head = el('div', 'esi-detail-head');
    head.appendChild(el('div', 'esi-detail-title', group.label));
    head.appendChild(
      el('div', 'esi-detail-key', `${group.count} tracked calls · collapsed by endpoint`)
    );
    frag.appendChild(head);

    const statusSection = section('Status');
    statusSection.appendChild(
      kvRow(
        'Worst Status',
        String(group.status || '').toUpperCase(),
        `is-${badgeClassFor(group.status)}`
      )
    );
    statusSection.appendChild(kvRow('Last Query', formatTimestamp(group.lastQueryAt)));
    frag.appendChild(statusSection);

    const totals = group.members.reduce(
      (acc, m) => ({
        requests: acc.requests + (m.request_count || 0),
        successes: acc.successes + (m.success_count || 0),
        errors: acc.errors + (m.error_count || 0),
      }),
      { requests: 0, successes: 0, errors: 0 }
    );

    const breakdown = section('Breakdown');
    breakdown.appendChild(kvRow('Tracked Calls', String(group.count)));
    breakdown.appendChild(
      kvRow('Healthy', String(group.count - group.errorCount), 'is-success')
    );
    breakdown.appendChild(
      kvRow('Failing', String(group.errorCount), group.errorCount ? 'is-error' : '')
    );
    frag.appendChild(breakdown);

    const statsSection = section('Statistics (combined)');
    statsSection.appendChild(kvRow('Total Requests', String(totals.requests)));
    statsSection.appendChild(kvRow('Successful', String(totals.successes), 'is-success'));
    statsSection.appendChild(kvRow('Failed', String(totals.errors), 'is-error'));
    frag.appendChild(statsSection);

    // Name the failures. This is the whole reason a group is not just a count.
    const failing = group.members.filter((m) => m.status === 'error');
    if (failing.length > 0) {
      const shown = failing.slice(0, MEMBER_LIST_LIMIT);
      const failSection = section(`Failing Calls (${failing.length})`);

      shown.forEach((member) => {
        const box = el('div', 'esi-error-box');
        box.appendChild(el('div', 'esi-error-code', member.call_key));
        box.appendChild(
          document.createTextNode(
            `${member.error_code ? `[${member.error_code}] ` : ''}${
              member.error_message || 'No error message recorded'
            }`
          )
        );
        failSection.appendChild(box);
      });

      if (failing.length > shown.length) {
        failSection.appendChild(
          el('div', 'esi-detail-more', `+ ${failing.length - shown.length} more`)
        );
      }
      frag.appendChild(failSection);
    }

    els.detail.replaceChildren(frag);
  }

  async function renderDetail() {
    if (!state.selectedLabel) return;

    const group = state.groups.find((g) => g.label === state.selectedLabel);
    if (!group) {
      els.detail.replaceChildren(emptyState('esi-detail-empty', 'Call not found'));
      return;
    }

    // A collapsed group has no single call_key, so its detail is aggregated
    // from the member rows already in hand - no extra IPC. Only a singleton
    // has a history worth fetching.
    if (group.count > 1) {
      renderGroupDetail(group);
      return;
    }

    let details;
    try {
      details = await window.electronAPI.esiStatus.getCallDetails(group.members[0].call_key);
    } catch (error) {
      console.error('[ESI Status] Error loading call details:', error);
      els.detail.replaceChildren(
        emptyState('esi-detail-empty', 'Error loading details', error.message)
      );
      return;
    }

    const call = details && details.status;
    const history = (details && details.history) || [];

    if (!call) {
      els.detail.replaceChildren(emptyState('esi-detail-empty', 'Call not found'));
      return;
    }

    const frag = document.createDocumentFragment();

    const head = el('div', 'esi-detail-head');
    head.appendChild(el('div', 'esi-detail-title', call.endpoint_label));
    head.appendChild(el('div', 'esi-detail-key', call.call_key));
    frag.appendChild(head);

    const statusSection = section('Status');
    statusSection.appendChild(
      kvRow(
        'Current Status',
        String(call.status || '').toUpperCase(),
        `is-${badgeClassFor(call.status)}`
      )
    );
    statusSection.appendChild(kvRow('Last Query', formatTimestamp(call.last_query_at)));
    statusSection.appendChild(kvRow('Last Updated', formatTimestamp(call.updated_at)));
    frag.appendChild(statusSection);

    const cacheSection = section('Cache & Rate Limiting');
    cacheSection.appendChild(
      kvRow('Cache Expires', call.cache_expires_at ? formatTimestamp(call.cache_expires_at) : 'N/A')
    );
    cacheSection.appendChild(
      kvRow(
        'Next Allowed Query',
        call.next_allowed_at ? formatTimestamp(call.next_allowed_at) : 'Anytime'
      )
    );
    const next = nextQueryRow(call);
    if (next) cacheSection.appendChild(kvRow(next.label, next.value, next.tone));
    frag.appendChild(cacheSection);

    const statsSection = section('Statistics');
    statsSection.appendChild(kvRow('Total Requests', String(call.request_count || 0)));
    statsSection.appendChild(kvRow('Successful', String(call.success_count || 0), 'is-success'));
    statsSection.appendChild(kvRow('Failed', String(call.error_count || 0), 'is-error'));
    frag.appendChild(statsSection);

    if (call.error_message) {
      const errorSection = section('Error Details');
      const box = el('div', 'esi-error-box');
      box.appendChild(el('div', 'esi-error-code', `Error Code: ${call.error_code || 'UNKNOWN'}`));
      box.appendChild(document.createTextNode(call.error_message));
      errorSection.appendChild(box);
      frag.appendChild(errorSection);
    }

    if (history.length > 0) {
      const historySection = section(`Recent History (last ${history.length} calls)`);
      history.forEach((entry) => {
        const row = el('div', 'esi-kv');
        row.appendChild(el('span', 'esi-kv-label', formatTimestamp(entry.timestamp)));
        const badge = el(
          'span',
          `badge ${entry.status === 'success' ? 'success' : 'error'}`,
          `${String(entry.status || '').toUpperCase()}${
            entry.duration_ms ? ` (${entry.duration_ms}ms)` : ''
          }`
        );
        row.appendChild(badge);
        historySection.appendChild(row);
      });
      frag.appendChild(historySection);
    }

    els.detail.replaceChildren(frag);
  }

  /* ============================================================
     Selection
     ============================================================ */

  async function selectCharacter(characterId, characterName) {
    state.navKind = 'character';
    state.characterId = characterId;
    state.characterName = characterName;

    syncNavHighlight();
    els.callsTitle.textContent = characterName;
    els.callsSubtitle.textContent = 'ESI calls for this character';

    clearDetail();
    await renderCalls();
  }

  async function selectUniverse() {
    state.navKind = 'universe';
    state.characterId = null;
    state.characterName = null;

    syncNavHighlight();
    els.callsTitle.textContent = 'Eve Universe';
    els.callsSubtitle.textContent = 'Universe-wide ESI calls';

    clearDetail();
    await renderCalls();
  }

  /* ============================================================
     Refresh
     ============================================================ */

  /**
   * Re-read everything currently on screen, preserving selection.
   *
   * Each pane is refreshed independently so one failing fetch cannot blank the
   * other two.
   */
  async function refreshView() {
    await renderNav();
    await renderCalls();
    if (state.selectedLabel) await renderDetail();
  }

  /* ============================================================
     Mount
     ============================================================ */

  async function mount(container, params, ctx) {
    const response = await fetch('esi-status.view.html');
    container.innerHTML = await response.text();

    const view = container.querySelector('#esi-status-view');
    els = {
      view,
      charNav: view.querySelector('#esi-char-nav'),
      universeItem: view.querySelector('#esi-nav-universe'),
      callsTitle: view.querySelector('#esi-calls-title'),
      callsSubtitle: view.querySelector('#esi-calls-subtitle'),
      callsList: view.querySelector('#esi-calls-list'),
      detail: view.querySelector('#esi-detail'),
    };

    ctx.on(els.universeItem, 'click', selectUniverse);
    ctx.on(els.universeItem, 'keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectUniverse();
      }
    });

    clearDetail();

    // Universe endpoints must be registered before their calls can be listed.
    try {
      await window.electronAPI.esiStatus.initializeUniverse();
    } catch (error) {
      console.error('[ESI Status] Error initializing universe endpoints:', error);
    }

    await renderNav();

    // Open on the first character when there is one - an empty middle pane is
    // a worse first impression than a populated one, and the universe view is
    // one click away.
    if (state.characters.length > 0) {
      const first = state.characters[0];
      await selectCharacter(first.characterId, first.characterName);
    } else {
      await selectUniverse();
    }

    // Coalesced, because a paginated fetch emits once per endpoint.
    const dataApi = window.electronAPI && window.electronAPI.data;
    if (dataApi && dataApi.onChanged) {
      let pending = null;
      const dispose = dataApi.onChanged(() => {
        if (pending) return;
        pending = window.setTimeout(() => {
          pending = null;
          refreshView();
        }, EVENT_COALESCE_MS);
      });
      ctx.track(() => {
        if (pending) window.clearTimeout(pending);
        if (typeof dispose === 'function') dispose();
      });
    }

    // Fallback tick so relative timestamps stay honest when nothing emits.
    ctx.setInterval(refreshView, FALLBACK_REFRESH_MS);

    return {
      destroy() {
        els = null;
        state.navKind = null;
        state.characterId = null;
        state.selectedLabel = null;
        state.characters = [];
        state.groups = [];
      },
    };
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('esi-status', {
      title: 'ESI Status',
      mount,
    });
  }
})();
