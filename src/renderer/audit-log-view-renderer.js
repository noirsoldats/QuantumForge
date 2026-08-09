/**
 * Audit Log - native shell view.
 *
 * A session-only ring buffer of pricing / material / invention calculations,
 * captured while Audit Mode is on. Records arrive live over
 * `audit.onRecordAdded`, which has always returned a proper disposer - this
 * screen was the reference for the subscription-teardown work.
 *
 * Two behaviours from the un-ported screen are deliberately NOT carried over:
 *
 *   1. It rebuilt the entire tbody on every row click and on every arriving
 *      record. That threw away scroll position mid-read and destroyed the
 *      element a click had started on (binding rule 2a). Selection now moves
 *      in place, and an arriving record is APPENDED.
 *
 *   2. It polled `getSummary()` every 5 seconds to learn whether Audit Mode
 *      was on - a value that only changes when a setting is written. It now
 *      listens for `settings:changed`.
 */

(function () {
  'use strict';

  /** Matches the recorder's MAX_RECORDS; the buffer is bounded there too. */
  const MAX_RECORDS = 1000;

  /**
   * Maps `calculateRealisticPrice`'s `method` to the candidate it drew from.
   *
   * `hybrid` takes a median ACROSS candidates rather than picking one, so it is
   * deliberately absent: marking any single row as the winner would misstate
   * where the final number came from.
   */
  const METHOD_TO_CANDIDATE_KEY = {
    vwap: 'vwap',
    percentile: 'percentile',
    immediate: 'immediate',
    historical: 'historical7d',
  };

  const state = {
    records: [],
    selectedId: null,
    sortKey: 'timestamp',
    sortDir: 'desc',
    search: '',
    typeFilter: '',
    confidenceFilter: '',
    auditEnabled: false,
  };

  let els = null;

  /* ============================================================
     Record accessors

     A record's useful fields live under a per-type key (`pricing`,
     `materials`, `invention`), with `context` as a fallback - so every read
     goes through one of these rather than reaching in directly.
     ============================================================ */

  function recordDisplayName(record) {
    if (record.type === 'pricing') {
      return record.pricing?.itemName || `Type ${record.pricing?.typeId ?? '?'}`;
    }
    if (record.type === 'materials') {
      return record.materials?.blueprintName || `Blueprint ${record.materials?.blueprintTypeId ?? '?'}`;
    }
    if (record.type === 'invention') {
      return (
        record.invention?.blueprintName || `Blueprint ${record.invention?.blueprintTypeId ?? '?'}`
      );
    }
    return '—';
  }

  function recordMethod(record) {
    return record.type === 'pricing' ? record.pricing?.method || '—' : '—';
  }

  function recordPrice(record) {
    return record.type === 'pricing' ? record.pricing?.price : null;
  }

  function recordConfidence(record) {
    return record.type === 'pricing' ? record.pricing?.confidence || 'none' : null;
  }

  function recordMarketSetName(record) {
    const ctx = record.context || record[record.type] || {};
    return ctx.marketSetName || '—';
  }

  function recordSource(record) {
    const ctx = record.context || record[record.type] || {};
    return ctx.source || '';
  }

  /* ============================================================
     Formatting
     ============================================================ */

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false });
  }

  function formatISK(value) {
    if (value === null || value === undefined) return '—';
    return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} ISK`;
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

  const ICON_NO_RECORDS = [
    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
    'M14 2v6h6',
    'M16 13H8',
    'M16 17H8',
  ];

  function emptyState(className, title, desc) {
    const wrap = el('div', className);
    const icon = el('div', 'al-empty-icon');
    icon.appendChild(svgIcon(ICON_NO_RECORDS, 26));
    wrap.appendChild(icon);
    wrap.appendChild(el('div', 'al-empty-title', title));
    if (desc) wrap.appendChild(el('div', 'al-empty-desc', desc));
    return wrap;
  }

  function kvRow(label, value, mono) {
    const row = el('div', 'al-kv');
    row.appendChild(el('span', 'al-kv-label', label));
    row.appendChild(el('span', `al-kv-value${mono ? ' is-mono' : ''}`, value));
    return row;
  }

  function section(title) {
    const wrap = el('div', 'al-section');
    wrap.appendChild(el('div', 'al-section-title', title));
    return wrap;
  }

  /* ============================================================
     Filtering and sorting
     ============================================================ */

  function getFilteredSortedRecords() {
    const search = state.search.trim().toLowerCase();

    const result = state.records.filter((r) => {
      if (state.typeFilter && r.type !== state.typeFilter) return false;
      if (state.confidenceFilter && recordConfidence(r) !== state.confidenceFilter) return false;
      if (search) {
        const haystack =
          `${recordDisplayName(r)} ${recordSource(r)} ${recordMarketSetName(r)}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    result.sort((a, b) => {
      let av;
      let bv;
      switch (state.sortKey) {
        case 'type': av = a.type; bv = b.type; break;
        case 'name': av = recordDisplayName(a); bv = recordDisplayName(b); break;
        case 'method': av = recordMethod(a); bv = recordMethod(b); break;
        case 'price': av = recordPrice(a) || 0; bv = recordPrice(b) || 0; break;
        case 'confidence': av = recordConfidence(a) || ''; bv = recordConfidence(b) || ''; break;
        case 'marketSetName': av = recordMarketSetName(a); bv = recordMarketSetName(b); break;
        default: av = a.timestamp; bv = b.timestamp;
      }
      if (av < bv) return state.sortDir === 'asc' ? -1 : 1;
      if (av > bv) return state.sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }

  /* ============================================================
     Table
     ============================================================ */

  function buildRow(record) {
    const tr = el('tr', 'al-row');
    tr.dataset.id = String(record.id);
    if (record.id === state.selectedId) tr.classList.add('is-selected');

    tr.appendChild(el('td', 'al-td col-time', formatTime(record.timestamp)));

    const typeCell = el('td', 'al-td');
    typeCell.appendChild(el('span', `al-type-badge is-${record.type}`, record.type));
    tr.appendChild(typeCell);

    tr.appendChild(el('td', 'al-td col-name', recordDisplayName(record)));

    const methodCell = el('td', 'al-td');
    const method = recordMethod(record);
    if (method !== '—') methodCell.appendChild(el('span', 'al-method-badge', method));
    else methodCell.textContent = '—';
    tr.appendChild(methodCell);

    const price = recordPrice(record);
    tr.appendChild(
      el('td', 'al-td col-price', price === null || price === undefined ? '—' : formatISK(price))
    );

    const confCell = el('td', 'al-td');
    const confidence = recordConfidence(record);
    if (confidence) confCell.appendChild(el('span', `confidence-badge ${confidence}`, confidence));
    else confCell.textContent = '—';
    tr.appendChild(confCell);

    tr.appendChild(el('td', 'al-td', recordMarketSetName(record)));

    tr.addEventListener('click', () => selectRecord(record.id));

    return tr;
  }

  /**
   * Move the selection highlight without rebuilding the rows.
   *
   * The un-ported screen called its full `renderTable()` from the row click
   * handler. Rebuilding on selection discards scroll position and every row
   * listener, and destroys the element the mousedown landed on (rule 2a).
   */
  function syncRowHighlight() {
    els.tbody.querySelectorAll('.al-row').forEach((row) => {
      row.classList.toggle('is-selected', row.dataset.id === String(state.selectedId));
    });
  }

  function renderTable() {
    const filtered = getFilteredSortedRecords();

    els.shownCount.textContent = state.records.length
      ? `${filtered.length} of ${state.records.length} records`
      : '';

    if (filtered.length === 0) {
      els.tbody.replaceChildren();
      const noneAtAll = state.records.length === 0;
      els.empty.replaceChildren(
        emptyState(
          'al-empty-inner',
          noneAtAll ? 'No calculations recorded yet' : 'No records match your filters',
          noneAtAll
            ? 'Enable Audit Mode in Settings, then trigger a pricing or material calculation elsewhere in the app.'
            : 'Try adjusting the search or filters above.'
        )
      );
      els.empty.hidden = false;
      return;
    }

    els.empty.hidden = true;
    els.empty.replaceChildren();

    const frag = document.createDocumentFragment();
    filtered.forEach((record) => frag.appendChild(buildRow(record)));
    els.tbody.replaceChildren(frag);
  }

  function renderSortIndicators() {
    els.theadRow.querySelectorAll('.al-th').forEach((th) => {
      const existing = th.querySelector('.al-sort-arrow');
      if (existing) existing.remove();
      if (th.dataset.sort === state.sortKey) {
        th.appendChild(el('span', 'al-sort-arrow', state.sortDir === 'asc' ? '▲' : '▼'));
      }
    });
  }

  /* ============================================================
     Detail pane
     ============================================================ */

  function selectRecord(id) {
    state.selectedId = id;
    syncRowHighlight();
    renderDetail();
  }

  function renderDetail() {
    const record = state.records.find((r) => r.id === state.selectedId);

    if (!record) {
      els.detail.replaceChildren(
        emptyState(
          'al-detail-empty',
          'Select a record',
          'Click any row to inspect its full calculation breakdown.'
        )
      );
      return;
    }

    const frag = document.createDocumentFragment();

    const head = el('div', 'al-detail-head');
    const meta = el('div', 'al-detail-meta');
    meta.appendChild(el('span', `al-type-badge is-${record.type}`, record.type));
    meta.appendChild(el('span', 'al-detail-time', formatTime(record.timestamp)));
    head.appendChild(meta);
    head.appendChild(el('h2', 'al-detail-name', recordDisplayName(record)));
    frag.appendChild(head);

    if (record.type === 'pricing') appendPricingDetail(frag, record);
    else if (record.type === 'materials') appendMaterialsDetail(frag, record);
    else if (record.type === 'invention') appendInventionDetail(frag, record);

    els.detail.replaceChildren(frag);
  }

  function appendPricingDetail(frag, record) {
    const p = record.pricing || {};
    const candidates = p.candidates || {};
    const winner = METHOD_TO_CANDIDATE_KEY[p.method] || null;

    const main = section('Pricing');
    main.appendChild(kvRow('Item', p.itemName || `Type ${p.typeId}`));
    main.appendChild(kvRow('Final Price', formatISK(p.price), true));
    main.appendChild(kvRow('Method Used', p.method || '—'));
    main.appendChild(kvRow('Price Type', p.priceType || '—'));

    const confRow = el('div', 'al-kv');
    confRow.appendChild(el('span', 'al-kv-label', 'Confidence'));
    const confValue = el('span', 'al-kv-value');
    confValue.appendChild(el('span', `confidence-badge ${p.confidence}`, p.confidence || 'none'));
    confRow.appendChild(confValue);
    main.appendChild(confRow);

    main.appendChild(kvRow('Market Set', p.marketSetName || '—'));
    main.appendChild(kvRow('Source', p.source || '—'));

    if (p.warning) main.appendChild(el('div', 'al-warning', p.warning));
    frag.appendChild(main);

    const candSection = section('Candidate Prices');
    const entries = Object.entries(candidates).filter(
      ([, value]) => value !== undefined && value !== null
    );

    if (entries.length === 0) {
      candSection.appendChild(el('div', 'al-kv-label', 'No candidates recorded'));
    } else {
      const table = el('div', 'al-candidates');
      const header = el('div', 'al-cand-head');
      header.appendChild(el('span', null, 'Method'));
      header.appendChild(el('span', null, 'Price'));
      table.appendChild(header);

      entries.forEach(([method, value]) => {
        const row = el('div', `al-cand-row${method === winner ? ' is-winner' : ''}`);
        row.appendChild(el('span', 'al-cand-method', method));
        row.appendChild(el('span', 'al-cand-price', formatISK(value)));
        table.appendChild(row);
      });
      candSection.appendChild(table);
    }
    frag.appendChild(candSection);

    if (p.metadata) {
      const m = p.metadata;
      const metaSection = section('Order Book Metadata');
      metaSection.appendChild(kvRow('Orders Available', m.ordersAvailable ?? '—', true));
      metaSection.appendChild(kvRow('Orders Used', m.ordersUsed ?? '—', true));
      metaSection.appendChild(kvRow('Quantity Filled', m.quantityFilled ?? '—', true));
      metaSection.appendChild(kvRow('Quantity Requested', m.quantityRequested ?? '—', true));
      metaSection.appendChild(kvRow('Historical Days', m.historicalDays ?? '—', true));
      frag.appendChild(metaSection);
    }
  }

  function appendMaterialsDetail(frag, record) {
    const m = record.materials || {};
    const s = section('Material Calculation');
    s.appendChild(kvRow('Blueprint', m.blueprintName || `Type ${m.blueprintTypeId}`));
    s.appendChild(kvRow('Runs', m.runs ?? '—', true));
    s.appendChild(kvRow('ME Level', m.meLevel ?? '—', true));
    s.appendChild(kvRow('Facility', m.facility || '—'));
    s.appendChild(kvRow('Market Set', m.marketSetName || '—'));
    s.appendChild(kvRow('Source', m.source || '—'));
    frag.appendChild(s);
  }

  function appendInventionDetail(frag, record) {
    const inv = record.invention || {};
    const s = section('Invention Calculation');
    s.appendChild(
      kvRow('Blueprint', inv.blueprintName || `Type ${inv.blueprintTypeId ?? '—'}`)
    );
    s.appendChild(
      kvRow(
        'Decryptor',
        inv.decryptorName || (inv.decryptorTypeId ? `Type ${inv.decryptorTypeId}` : 'None')
      )
    );
    s.appendChild(
      kvRow(
        'Probability',
        inv.probability !== undefined ? `${(inv.probability * 100).toFixed(1)}%` : '—',
        true
      )
    );
    s.appendChild(kvRow('Material Cost', formatISK(inv.materialCost), true));
    s.appendChild(kvRow('Cost Per Run', formatISK(inv.costPerRun), true));
    s.appendChild(kvRow('Source', inv.source || '—'));
    frag.appendChild(s);
  }

  /* ============================================================
     Summary + status
     ============================================================ */

  function updateSummary() {
    const byType = {};
    state.records.forEach((r) => {
      byType[r.type] = (byType[r.type] || 0) + 1;
    });

    els.countTotal.textContent = String(state.records.length);
    els.countPricing.textContent = String(byType.pricing || 0);
    els.countMaterials.textContent = String(byType.materials || 0);
    els.countInvention.textContent = String(byType.invention || 0);
  }

  function renderStatus() {
    els.statusDot.className = `pulse-dot ${state.auditEnabled ? 'online' : 'warning'}`;
    els.statusText.textContent = state.auditEnabled ? 'Recording' : 'Audit Mode is off';
  }

  async function refreshStatus() {
    try {
      const summary = await window.electronAPI.audit.getSummary();
      state.auditEnabled = !!(summary && summary.enabled);
      renderStatus();
    } catch (error) {
      console.error('[Audit Log] Error reading audit status:', error);
    }
  }

  /* ============================================================
     Live records
     ============================================================ */

  /**
   * Append an arriving record without rebuilding the table.
   *
   * Falls back to a full render when the new row would not simply land at the
   * end - a non-default sort, an active filter, or a filled buffer that just
   * dropped its oldest row all change the row SET, not just its length.
   */
  function appendRecord(record) {
    state.records.push(record);

    const evicted = state.records.length > MAX_RECORDS;
    if (evicted) state.records.shift();

    updateSummary();

    const isDefaultOrder = state.sortKey === 'timestamp' && state.sortDir === 'desc';
    const isFiltered = !!(state.search || state.typeFilter || state.confidenceFilter);

    if (evicted || !isDefaultOrder || isFiltered || els.tbody.children.length === 0) {
      renderTable();
      // Flash whichever row is the new one, if it survived the filters.
      const row = els.tbody.querySelector(`.al-row[data-id="${record.id}"]`);
      if (row) flashRow(row);
      return;
    }

    // Newest-first: the new row goes on top, and nothing else moves.
    const row = buildRow(record);
    els.tbody.prepend(row);
    flashRow(row);

    els.shownCount.textContent = `${els.tbody.children.length} of ${state.records.length} records`;
  }

  function flashRow(row) {
    row.classList.add('is-new');
    row.addEventListener('animationend', () => row.classList.remove('is-new'), { once: true });
  }

  /* ============================================================
     Mount
     ============================================================ */

  async function mount(container, params, ctx) {
    const response = await fetch('audit-log.view.html');
    container.innerHTML = await response.text();

    const view = container.querySelector('#audit-log-view');
    els = {
      view,
      statusDot: view.querySelector('#al-status-dot'),
      statusText: view.querySelector('#al-status-text'),
      countTotal: view.querySelector('#al-count-total'),
      countPricing: view.querySelector('#al-count-pricing'),
      countMaterials: view.querySelector('#al-count-materials'),
      countInvention: view.querySelector('#al-count-invention'),
      settingsBtn: view.querySelector('#al-settings-btn'),
      clearBtn: view.querySelector('#al-clear-btn'),
      search: view.querySelector('#al-search'),
      typeFilter: view.querySelector('#al-filter-type'),
      confidenceFilter: view.querySelector('#al-filter-confidence'),
      shownCount: view.querySelector('#al-shown-count'),
      theadRow: view.querySelector('#al-thead-row'),
      tbody: view.querySelector('#al-tbody'),
      empty: view.querySelector('#al-empty'),
      detail: view.querySelector('#al-detail'),
    };

    ctx.on(els.search, 'input', () => {
      state.search = els.search.value;
      renderTable();
    });
    ctx.on(els.typeFilter, 'change', () => {
      state.typeFilter = els.typeFilter.value;
      renderTable();
    });
    ctx.on(els.confidenceFilter, 'change', () => {
      state.confidenceFilter = els.confidenceFilter.value;
      renderTable();
    });

    ctx.on(els.theadRow, 'click', (e) => {
      const th = e.target.closest('.al-th');
      if (!th || !th.dataset.sort) return;
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = 'desc';
      }
      renderSortIndicators();
      renderTable();
    });

    ctx.on(els.clearBtn, 'click', async () => {
      try {
        await window.electronAPI.audit.clearRecords();
      } catch (error) {
        console.error('[Audit Log] Error clearing records:', error);
        return;
      }
      state.records = [];
      state.selectedId = null;
      renderTable();
      renderDetail();
      updateSummary();
    });

    ctx.on(els.settingsBtn, 'click', () => window.electronAPI.openSettings());

    // Records arrive live. This subscription has always returned a disposer -
    // it is the pattern the rest of the app's `on*` methods were fixed to.
    const disposeRecords = window.electronAPI.audit.onRecordAdded((record) => {
      appendRecord(record);
    });
    ctx.track(disposeRecords);

    // Audit Mode on/off only changes when a setting is WRITTEN, so listen for
    // that rather than polling. The un-ported screen re-read the summary every
    // 5 seconds to notice a value that is idle almost always.
    const dataApi = window.electronAPI && window.electronAPI.data;
    if (dataApi && dataApi.onSettingsChanged) {
      ctx.track(
        dataApi.onSettingsChanged((payload) => {
          if (!payload || payload.category !== 'general') return;
          if (!payload.keys || !payload.keys.includes('auditModeEnabled')) return;
          state.auditEnabled = !!payload.updates.auditModeEnabled;
          renderStatus();
        })
      );
    }

    try {
      state.records = await window.electronAPI.audit.getRecords();
    } catch (error) {
      console.error('[Audit Log] Error loading records:', error);
      state.records = [];
    }

    // getRecords returns newest-first; the table sorts for itself, so keep the
    // buffer in arrival order and let getFilteredSortedRecords decide.
    state.records = [...state.records].reverse();

    renderSortIndicators();
    renderTable();
    renderDetail();
    updateSummary();
    await refreshStatus();

    return {
      destroy() {
        els = null;
        state.records = [];
        state.selectedId = null;
        state.search = '';
        state.typeFilter = '';
        state.confidenceFilter = '';
        state.sortKey = 'timestamp';
        state.sortDir = 'desc';
      },
    };
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('audit-log', {
      title: 'Audit Log',
      mount,
    });
  }
})();
