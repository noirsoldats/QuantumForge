// Character Hub — a native shell view.
//
// Roster of every connected character with an aggregate totals strip and
// per-character deep links into Assets / Skills / Blueprints.
//
// Reads only CACHED data (`esi.getCharacter` returns skills from the local
// database, `blueprints.getAll` and `assets.get` read the cache), so opening the
// Hub never triggers an ESI fetch. It re-renders when the data-change bus says
// something landed.

(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** Icon definitions, Feather recipe (24x24, currentColor, no fill). */
  const ICONS = {
    assets: [
      ['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }],
      ['polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }],
      ['line', { x1: 12, y1: 22.08, x2: 12, y2: 12 }],
    ],
    skills: [
      ['path', { d: 'M12 20h9' }],
      ['path', { d: 'M12 4v16' }],
      ['path', { d: 'M4 8l4-4 4 4' }],
      ['path', { d: 'M8 4v10' }],
    ],
    blueprints: [
      ['rect', { x: 4, y: 2, width: 16, height: 20, rx: 2 }],
      ['line', { x1: 8, y1: 7, x2: 16, y2: 7 }],
      ['line', { x1: 8, y1: 11, x2: 16, y2: 11 }],
      ['line', { x1: 8, y1: 15, x2: 13, y2: 15 }],
    ],
    star: [
      ['path', { d: 'M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z' }],
    ],
    gear: [
      ['circle', { cx: 12, cy: 12, r: 3 }],
      ['path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }],
    ],
  };

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

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const fmtSp = (sp) => `${(Number(sp || 0) / 1e6).toFixed(1)}M`;

  let templateCache = null;

  /** Fetch the view markup from its own file (see settings-renderer for the pattern). */
  async function loadTemplate() {
    const inline = document.getElementById('character-hub-view-template');
    if (inline) return inline.content.cloneNode(true);

    if (!templateCache) {
      try {
        const html = await fetch('character-hub.view.html').then((r) => r.text());
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const tpl = parsed.getElementById('character-hub-view-template');
        if (!tpl) {
          console.error('[character-hub] template not found');
          return null;
        }
        templateCache = tpl.content;
      } catch (error) {
        console.error('[character-hub] failed to load template:', error);
        return null;
      }
    }
    return document.importNode(templateCache, true);
  }

  /**
   * Describe a character's authorisation state.
   * Mirrors the Settings account cards so the two never disagree.
   * @param {Object} character
   * @returns {{ text: string, tone: 'success'|'warning'|'error' }}
   */
  function authStatus(character) {
    const expiresAt = character.expiresAt || character.tokenExpiry;
    if (!expiresAt) return { text: 'Authorized', tone: 'success' };

    const msLeft = new Date(expiresAt).getTime() - Date.now();
    if (Number.isNaN(msLeft)) return { text: 'Authorized', tone: 'success' };
    // Tokens refresh automatically, so an expired one is not an error state.
    if (msLeft <= 0) return { text: 'Token expired - refreshing on next use', tone: 'warning' };

    const minutes = Math.round(msLeft / 60000);
    if (minutes <= 20) return { text: `Token expires in ${minutes}m`, tone: 'warning' };

    const scopes = Array.isArray(character.scopes) ? character.scopes.length : 0;
    return { text: scopes ? `Authorized - ${scopes} scopes` : 'Authorized', tone: 'success' };
  }

  /**
   * Gather per-character figures from CACHED sources only.
   *
   * `esi.getCharacter` returns skills from the local database, so this never
   * triggers an ESI call - important, because the Hub loads on navigation.
   *
   * @param {Object} character
   * @returns {Promise<Object>}
   */
  async function collectStats(character) {
    const id = character.characterId;
    const out = { totalSp: 0, atLevel5: 0, assets: 0, blueprints: 0 };

    const [full, blueprints, assets] = await Promise.all([
      window.electronAPI.esi.getCharacter(id).catch(() => null),
      window.electronAPI.blueprints.getAll(id).catch(() => []),
      window.electronAPI.assets.get(id, false).catch(() => []),
    ]);

    if (full && full.skills) {
      out.totalSp = full.skills.totalSp || 0;
      // "At Level 5" is not stored anywhere, so derive it from the cached
      // per-skill levels rather than adding an IPC handler for one number.
      const map = full.skills.skills || {};
      out.atLevel5 = Object.keys(map).reduce((n, key) => {
        const skill = map[key];
        return n + (skill && skill.trainedSkillLevel === 5 ? 1 : 0);
      }, 0);
    }

    out.blueprints = Array.isArray(blueprints) ? blueprints.length : 0;
    out.assets = Array.isArray(assets) ? assets.length : 0;
    return out;
  }

  /** Build the aggregate strip. */
  function renderTotals(rows) {
    const host = document.getElementById('ch-totals');
    if (!host) return;
    host.textContent = '';

    rows.forEach(({ label, value, accent }) => {
      const cell = document.createElement('div');
      cell.className = 'ch-total';

      const l = document.createElement('div');
      l.className = 'ch-total-label';
      l.textContent = label;
      cell.appendChild(l);

      const v = document.createElement('div');
      v.className = 'ch-total-value' + (accent ? ' is-accent' : '');
      v.textContent = value;
      cell.appendChild(v);

      host.appendChild(cell);
    });
  }

  /** One labelled stat inside a character card. */
  function statCell(label, value) {
    const wrap = document.createElement('div');
    const l = document.createElement('div');
    l.className = 'ch-stat-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'ch-stat-value';
    v.textContent = value;
    wrap.appendChild(l);
    wrap.appendChild(v);
    return wrap;
  }

  /** An Assets/Skills/Blueprints deep-link button. */
  function actionButton(iconName, label, count, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ch-act';
    btn.appendChild(icon(iconName, 16));

    const text = document.createElement('span');
    text.textContent = label;
    btn.appendChild(text);

    if (count !== null && count !== undefined) {
      const c = document.createElement('span');
      c.className = 'ch-act-count';
      c.textContent = count;
      btn.appendChild(c);
    }

    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Build one character card.
   * @param {Object} corpNames  corporationId -> name, for ids that resolved.
   */
  function renderCard(character, stats, isDefault, onChanged, corpNames = {}) {
    const id = character.characterId;
    const card = document.createElement('div');
    card.className = 'ch-card' + (isDefault ? ' is-default' : '');
    card.setAttribute('data-character-id', String(id));

    const bar = document.createElement('div');
    bar.className = 'ch-card-bar';
    card.appendChild(bar);

    const body = document.createElement('div');
    body.className = 'ch-card-body';

    // Portrait (+ gold star when default)
    const pw = document.createElement('div');
    pw.className = 'ch-portrait-wrap';
    const img = document.createElement('img');
    img.className = 'ch-portrait';
    img.src = `${character.portrait}?size=128`;
    img.alt = '';
    img.setAttribute('data-fallback', 'portrait');
    pw.appendChild(img);
    if (isDefault) {
      const star = document.createElement('span');
      star.className = 'ch-default-star';
      star.title = 'Default character';
      star.appendChild(icon('star', 15, { fill: 'currentColor', stroke: 'none' }));
      pw.appendChild(star);
    }
    body.appendChild(pw);

    // Identity: name, Default pill, corporation, auth status
    const identity = document.createElement('div');
    identity.className = 'ch-identity';

    const nameRow = document.createElement('div');
    nameRow.className = 'ch-name-row';
    const name = document.createElement('span');
    name.className = 'ch-name';
    name.textContent = character.characterName;
    nameRow.appendChild(name);
    if (isDefault) {
      const badge = document.createElement('span');
      badge.className = 'ch-default-badge';
      badge.textContent = 'Default';
      nameRow.appendChild(badge);
    }
    identity.appendChild(nameRow);

    const corp = document.createElement('div');
    corp.className = 'ch-corp';
    // Only the ID is stored locally; the name is resolved from ESI and cached
    // for the session. Falls back to the bare ID when that fails, so a
    // rate-limited or deleted corporation still identifies the character.
    const corpName = corpNames[character.corporationId];
    corp.textContent = corpName
      || (character.corporationId ? `Corporation ${character.corporationId}` : 'Corporation unknown');
    identity.appendChild(corp);

    // HIDDEN, not removed. "Token expires in 18m" is a normal state - tokens
    // refresh automatically - so surfacing a countdown invites the reader to
    // think something needs doing. Parked until there is something genuinely
    // useful for this line; authStatus() and the markup stay so restoring it
    // is a one-line change.
    const status = authStatus(character);
    const st = document.createElement('div');
    st.className = `ch-status is-${status.tone}`;
    st.textContent = status.text;
    st.hidden = true;
    identity.appendChild(st);

    body.appendChild(identity);

    // Stats
    const statsWrap = document.createElement('div');
    statsWrap.className = 'ch-stats';
    statsWrap.appendChild(statCell('Total SP', fmtSp(stats.totalSp)));
    statsWrap.appendChild(statCell('At Level 5', fmt(stats.atLevel5)));
    statsWrap.appendChild(statCell('Assets', fmt(stats.assets)));
    body.appendChild(statsWrap);

    card.appendChild(body);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'ch-actions';
    actions.appendChild(actionButton('assets', 'Assets', fmt(stats.assets),
      () => window.electronAPI.window.openView('assets', { characterId: id })));
    actions.appendChild(actionButton('skills', 'Skills', fmtSp(stats.totalSp),
      () => window.electronAPI.window.openView('skills', { characterId: id })));
    actions.appendChild(actionButton('blueprints', 'Blueprints', fmt(stats.blueprints),
      () => window.electronAPI.window.openView('blueprints', { characterId: id })));

    const spacer = document.createElement('span');
    spacer.className = 'ch-actions-spacer';
    actions.appendChild(spacer);

    if (!isDefault) {
      const setDefault = document.createElement('button');
      setDefault.type = 'button';
      setDefault.className = 'ch-act-text is-gold';
      setDefault.appendChild(icon('star', 14));
      const sdLabel = document.createElement('span');
      sdLabel.textContent = 'Set Default';
      setDefault.appendChild(sdLabel);
      setDefault.addEventListener('click', async () => {
        try {
          await window.electronAPI.esi.setDefaultCharacter(id);
          // The main process broadcasts default-character-changed; re-render so
          // the star and badge move even if that event is missed.
          if (onChanged) onChanged();
        } catch (error) {
          console.error('[character-hub] failed to set default:', error);
        }
      });
      actions.appendChild(setDefault);
    }

    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'ch-act-text';
    manage.appendChild(icon('gear', 14));
    const mLabel = document.createElement('span');
    mLabel.textContent = 'Manage';
    manage.appendChild(mLabel);
    manage.title = 'Open Settings to manage this character';
    manage.addEventListener('click', () => {
      window.QFShell.router.show('settings');
    });
    actions.appendChild(manage);

    card.appendChild(actions);
    return card;
  }

  /** Load the roster and render everything. */
  async function render() {
    const cardsHost = document.getElementById('ch-cards');
    const emptyEl = document.getElementById('ch-empty');
    if (!cardsHost) return;

    let characters = [];
    let defaultId = null;
    try {
      const [list, def] = await Promise.all([
        window.electronAPI.esi.getCharacters(),
        window.electronAPI.esi.getDefaultCharacter(),
      ]);
      characters = Array.isArray(list) ? list : [];
      defaultId = def ? def.characterId : null;
    } catch (error) {
      console.error('[character-hub] failed to load characters:', error);
    }

    if (characters.length === 0) {
      cardsHost.textContent = '';
      renderTotals([]);
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    // Default first, then alphabetical - the gold star should lead.
    const ordered = characters.slice().sort((a, b) => {
      if (a.characterId === defaultId) return -1;
      if (b.characterId === defaultId) return 1;
      return String(a.characterName).localeCompare(String(b.characterName));
    });

    // Fan out per character rather than adding an aggregate IPC handler; the
    // roster is a handful of characters, and every read is cache-only.
    //
    // Corporation names are the one exception - they are not stored locally,
    // so they come from ESI. Resolved in ONE deduped call (several characters
    // often share a corp) and session-cached in main, so this costs at most
    // one request per corporation for the life of the app.
    const [stats, corpNames] = await Promise.all([
      Promise.all(ordered.map(collectStats)),
      window.electronAPI.esi.resolveCorporationNames(
        ordered.map((c) => c.corporationId)
      ).catch(() => ({})),
    ]);

    const totals = stats.reduce(
      (acc, s) => ({
        sp: acc.sp + s.totalSp,
        assets: acc.assets + s.assets,
        blueprints: acc.blueprints + s.blueprints,
      }),
      { sp: 0, assets: 0, blueprints: 0 }
    );

    renderTotals([
      { label: 'Characters', value: fmt(ordered.length), accent: true },
      { label: 'Combined SP', value: fmtSp(totals.sp) },
      { label: 'Total Assets', value: fmt(totals.assets) },
      { label: 'Blueprints', value: fmt(totals.blueprints) },
    ]);

    cardsHost.textContent = '';
    ordered.forEach((character, i) => {
      cardsHost.appendChild(
        renderCard(
          character, stats[i], character.characterId === defaultId, render, corpNames || {}
        )
      );
    });

    QFUI.attachPortraitFallbacks(cardsHost);
  }

  /**
   * Mount the view.
   * @param {HTMLElement} container
   * @param {Object} params
   * @param {Object} ctx  ViewContext - tracked resources are auto-disposed.
   */
  async function mount(container, params, ctx) {
    if (container && !container.querySelector('#character-hub')) {
      const fragment = await loadTemplate();
      if (fragment) container.appendChild(fragment);
    }

    const connectBtn = document.getElementById('ch-connect-btn');
    if (connectBtn) {
      connectBtn.addEventListener('click', async () => {
        connectBtn.disabled = true;
        QFUI.setButtonLabel(connectBtn, 'Authenticating...');
        try {
          const result = await window.electronAPI.esi.authenticate();
          if (!result || !result.success) {
            console.error('[character-hub] authentication failed:', result && result.error);
          }
          await render();
        } catch (error) {
          console.error('[character-hub] authentication error:', error);
        } finally {
          connectBtn.disabled = false;
          QFUI.setButtonLabel(connectBtn, 'Connect Character');
        }
      });
    }

    await render();

    // Stay live: re-render when the default character changes or when cached
    // character data is refreshed by the background cycle.
    ctx.track(window.electronAPI.esi.onDefaultCharacterChanged(() => render()));

    const api = window.electronAPI.data;
    if (api) {
      ctx.track(api.onCycleComplete(() => render()));
      ctx.track(api.onChanged((info) => {
        if (!info) return;
        // Only the endpoints whose data this screen displays.
        const t = String(info.endpointType || '');
        if (t === 'skills' || t === 'blueprints' || t === 'assets') render();
      }));
    }

    return {};
  }

  // Register with the shell. The Hub is poppable per the settled decision.
  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('characters', {
      title: 'Characters',
      mount,
    });
  }
})();
