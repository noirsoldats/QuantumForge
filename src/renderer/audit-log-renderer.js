// Audit Log window renderer

let allRecords = [];
let selectedRecordId = null;
let sortKey = 'timestamp';
let sortDir = 'desc';

const ICON_EMPTY_LIST = '<circle cx="12" cy="12" r="10"></circle><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line>';
const ICON_EMPTY_DETAIL = '<path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>';

function renderEmptyState(container, heading, subtext, iconPath) {
  container.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          ${iconPath}
        </svg>
      </div>
      <h3>${heading}</h3>
      <p>${subtext}</p>
    </div>`;
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function formatISK(value) {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ISK';
}

function recordDisplayName(record) {
  if (record.type === 'pricing') return record.pricing?.itemName || `Type ${record.pricing?.typeId ?? '?'}`;
  if (record.type === 'materials') return record.materials?.blueprintName || `Blueprint ${record.materials?.blueprintTypeId ?? '?'}`;
  if (record.type === 'invention') return `Blueprint ${record.invention?.blueprintTypeId ?? '?'}`;
  return '—';
}

function recordMethod(record) {
  if (record.type === 'pricing') return record.pricing?.method || '—';
  return '—';
}

function recordPrice(record) {
  if (record.type === 'pricing') return record.pricing?.price;
  return null;
}

function recordConfidence(record) {
  if (record.type === 'pricing') return record.pricing?.confidence || 'none';
  return null;
}

function recordMarketSetName(record) {
  const ctx = record.context || record[record.type] || {};
  return ctx.marketSetName || '—';
}

function recordSource(record) {
  const ctx = record.context || record[record.type] || {};
  return ctx.source || '';
}

async function loadInitialRecords() {
  allRecords = await window.electronAPI.audit.getRecords();
  renderTable();
  updateSummary();
}

async function refreshStatus() {
  const summary = await window.electronAPI.audit.getSummary();
  const dot = document.getElementById('audit-status-dot');
  const text = document.getElementById('audit-status-text');
  if (summary.enabled) {
    dot.className = 'pulse-dot online';
    text.textContent = 'Recording';
  } else {
    dot.className = 'pulse-dot warning';
    text.textContent = 'Audit Mode is off';
  }
}

function updateSummary() {
  const byType = {};
  for (const r of allRecords) {
    byType[r.type] = (byType[r.type] || 0) + 1;
  }
  document.getElementById('summary-total').textContent = allRecords.length;
  document.getElementById('summary-pricing').textContent = byType.pricing || 0;
  document.getElementById('summary-materials').textContent = byType.materials || 0;
  document.getElementById('summary-invention').textContent = byType.invention || 0;
}

function getFilteredSortedRecords() {
  const search = document.getElementById('filter-search').value.trim().toLowerCase();
  const typeFilter = document.getElementById('filter-type').value;
  const confidenceFilter = document.getElementById('filter-confidence').value;

  let result = allRecords.filter(r => {
    if (typeFilter && r.type !== typeFilter) return false;
    if (confidenceFilter && recordConfidence(r) !== confidenceFilter) return false;
    if (search) {
      const haystack = `${recordDisplayName(r)} ${recordSource(r)} ${recordMarketSetName(r)}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  result.sort((a, b) => {
    let av, bv;
    switch (sortKey) {
      case 'type': av = a.type; bv = b.type; break;
      case 'name': av = recordDisplayName(a); bv = recordDisplayName(b); break;
      case 'method': av = recordMethod(a); bv = recordMethod(b); break;
      case 'price': av = recordPrice(a) || 0; bv = recordPrice(b) || 0; break;
      case 'confidence': av = recordConfidence(a) || ''; bv = recordConfidence(b) || ''; break;
      case 'marketSetName': av = recordMarketSetName(a); bv = recordMarketSetName(b); break;
      default: av = a.timestamp; bv = b.timestamp;
    }
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  return result;
}

function renderTable(highlightId = null) {
  const tbody = document.getElementById('audit-table-body');
  const emptyContainer = document.getElementById('audit-empty-state');
  const filtered = getFilteredSortedRecords();

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    renderEmptyState(
      emptyContainer,
      allRecords.length === 0 ? 'No calculations recorded yet' : 'No records match your filters',
      allRecords.length === 0
        ? 'Enable Audit Mode in Settings, then trigger a pricing or material calculation elsewhere in the app.'
        : 'Try adjusting the search or filters above.',
      ICON_EMPTY_LIST
    );
    emptyContainer.style.display = 'flex';
    return;
  }

  emptyContainer.style.display = 'none';
  emptyContainer.innerHTML = '';

  tbody.innerHTML = filtered.map(r => {
    const price = recordPrice(r);
    const confidence = recordConfidence(r);
    return `
      <tr data-id="${r.id}" class="${r.id === selectedRecordId ? 'selected' : ''} ${r.id === highlightId ? 'just-added' : ''}">
        <td>${formatTime(r.timestamp)}</td>
        <td><span class="audit-type-badge ${r.type}">${r.type}</span></td>
        <td>${escapeHtml(recordDisplayName(r))}</td>
        <td>${recordMethod(r) !== '—' ? `<span class="audit-method-badge">${escapeHtml(recordMethod(r))}</span>` : '—'}</td>
        <td>${price !== null && price !== undefined ? formatISK(price) : '—'}</td>
        <td>${confidence ? `<span class="confidence-badge ${confidence}">${confidence}</span>` : '—'}</td>
        <td>${escapeHtml(recordMarketSetName(r))}</td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      selectedRecordId = parseInt(tr.dataset.id, 10);
      renderTable();
      renderDetail();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function renderDetail() {
  const emptyContainer = document.getElementById('audit-detail-empty');
  const content = document.getElementById('audit-detail-content');

  const record = allRecords.find(r => r.id === selectedRecordId);
  if (!record) {
    content.style.display = 'none';
    emptyContainer.style.display = 'flex';
    renderEmptyState(emptyContainer, 'Select a record', 'Click a row on the left to see its full calculation breakdown.', ICON_EMPTY_DETAIL);
    return;
  }

  emptyContainer.style.display = 'none';
  content.style.display = 'block';

  if (record.type === 'pricing') {
    content.innerHTML = renderPricingDetail(record);
  } else if (record.type === 'materials') {
    content.innerHTML = renderMaterialsDetail(record);
  } else if (record.type === 'invention') {
    content.innerHTML = renderInventionDetail(record);
  }
}

// Maps calculateRealisticPrice's `method` result to the candidates key it drew from.
// 'hybrid' picks a median across several candidates rather than a single one, so no
// single candidate row is marked as the winner in that case.
const METHOD_TO_CANDIDATE_KEY = {
  vwap: 'vwap',
  percentile: 'percentile',
  immediate: 'immediate',
  historical: 'historical7d',
};

function renderPricingDetail(record) {
  const p = record.pricing;
  const candidates = p.candidates || {};
  const winningCandidateKey = METHOD_TO_CANDIDATE_KEY[p.method] || null;

  const candidateRows = Object.entries(candidates)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([method, value]) => {
      const isWinner = method === winningCandidateKey;
      return `<tr class="${isWinner ? 'winner' : ''}"><td>${escapeHtml(method)}</td><td>${formatISK(value)}</td></tr>`;
    }).join('');

  return `
    <div class="audit-detail-section">
      <h3>Pricing</h3>
      <dl class="audit-kv-grid">
        <dt>Item</dt><dd>${escapeHtml(p.itemName || `Type ${p.typeId}`)}</dd>
        <dt>Final Price</dt><dd>${formatISK(p.price)}</dd>
        <dt>Method Used</dt><dd>${escapeHtml(p.method || '—')}</dd>
        <dt>Price Type</dt><dd>${escapeHtml(p.priceType || '—')}</dd>
        <dt>Confidence</dt><dd><span class="confidence-badge ${p.confidence}">${p.confidence}</span></dd>
        <dt>Market Set</dt><dd>${escapeHtml(p.marketSetName || '—')}</dd>
        <dt>Source</dt><dd>${escapeHtml(p.source || '—')}</dd>
      </dl>
      ${p.warning ? `<div class="audit-warning-callout">${escapeHtml(p.warning)}</div>` : ''}
    </div>

    <div class="audit-detail-section">
      <h3>Candidate Prices</h3>
      <table class="audit-candidates-table">
        <thead><tr><th>Method</th><th>Price</th></tr></thead>
        <tbody>${candidateRows || '<tr><td colspan="2">No candidates recorded</td></tr>'}</tbody>
      </table>
    </div>

    ${p.metadata ? `
    <div class="audit-detail-section">
      <h3>Order Book Metadata</h3>
      <dl class="audit-kv-grid">
        <dt>Orders Available</dt><dd>${p.metadata.ordersAvailable ?? '—'}</dd>
        <dt>Orders Used</dt><dd>${p.metadata.ordersUsed ?? '—'}</dd>
        <dt>Quantity Filled</dt><dd>${p.metadata.quantityFilled ?? '—'}</dd>
        <dt>Quantity Requested</dt><dd>${p.metadata.quantityRequested ?? '—'}</dd>
        <dt>Historical Days</dt><dd>${p.metadata.historicalDays ?? '—'}</dd>
      </dl>
    </div>` : ''}
  `;
}

function renderMaterialsDetail(record) {
  const m = record.materials;
  return `
    <div class="audit-detail-section">
      <h3>Material Calculation</h3>
      <dl class="audit-kv-grid">
        <dt>Blueprint</dt><dd>${escapeHtml(m.blueprintName || `Type ${m.blueprintTypeId}`)}</dd>
        <dt>Runs</dt><dd>${m.runs ?? '—'}</dd>
        <dt>ME Level</dt><dd>${m.meLevel ?? '—'}</dd>
        <dt>Facility</dt><dd>${escapeHtml(m.facility || '—')}</dd>
        <dt>Market Set</dt><dd>${escapeHtml(m.marketSetName || '—')}</dd>
        <dt>Source</dt><dd>${escapeHtml(m.source || '—')}</dd>
      </dl>
    </div>
  `;
}

function renderInventionDetail(record) {
  const inv = record.invention;
  return `
    <div class="audit-detail-section">
      <h3>Invention Calculation</h3>
      <dl class="audit-kv-grid">
        <dt>Blueprint</dt><dd>Type ${inv.blueprintTypeId ?? '—'}</dd>
        <dt>Decryptor</dt><dd>${inv.decryptorTypeId ? `Type ${inv.decryptorTypeId}` : 'None'}</dd>
        <dt>Probability</dt><dd>${inv.probability !== undefined ? (inv.probability * 100).toFixed(1) + '%' : '—'}</dd>
        <dt>Material Cost</dt><dd>${formatISK(inv.materialCost)}</dd>
        <dt>Cost Per Run</dt><dd>${formatISK(inv.costPerRun)}</dd>
        <dt>Source</dt><dd>${escapeHtml(inv.source || '—')}</dd>
      </dl>
    </div>
  `;
}

function setupSorting() {
  document.querySelectorAll('.audit-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = 'desc';
      }
      renderTable();
    });
  });
}

function setupFilters() {
  document.getElementById('filter-search').addEventListener('input', () => renderTable());
  document.getElementById('filter-type').addEventListener('change', () => renderTable());
  document.getElementById('filter-confidence').addEventListener('change', () => renderTable());
}

function setupActions() {
  document.getElementById('clear-records-btn').addEventListener('click', async () => {
    await window.electronAPI.audit.clearRecords();
    allRecords = [];
    selectedRecordId = null;
    renderTable();
    renderDetail();
    updateSummary();
  });

  document.getElementById('open-settings-btn').addEventListener('click', () => {
    window.electronAPI.openSettings();
  });
}

function setupLiveUpdates() {
  window.electronAPI.audit.onRecordAdded((record) => {
    allRecords.push(record);
    if (allRecords.length > 1000) allRecords.shift();
    renderTable(record.id);
    updateSummary();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  setupSorting();
  setupFilters();
  setupActions();
  setupLiveUpdates();
  renderDetail();
  await loadInitialRecords();
  await refreshStatus();
  setInterval(refreshStatus, 5000);
});
