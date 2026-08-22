/**
 * @jest-environment jsdom
 *
 * Manufacturing Plans - the Analytics and Ledger tabs.
 *
 * Split out of the original single Plans suite; the shared fake backend and
 * mount helpers live in ./helpers/plans-harness.
 */

const h = require('./helpers/plans-harness');

h.installHooks();

const { state, openTab, settle } = h;

describe('analytics', () => {
  test('renders a progress CARD per tracked dimension', async () => {
    // The redesign uses cards, not stacked bars: jobs, materials, products,
    // overall.
    await openTab('analytics');

    const cards = document.querySelectorAll('#mp-analytics .mp-analytics-grid')[0]
      .querySelectorAll('.mp-card');
    expect(cards).toHaveLength(4);
    expect(document.getElementById('mp-analytics').textContent).toContain('Jobs completed');
    expect(document.getElementById('mp-analytics').textContent).toContain('Overall');
  });

  test('progress fill is clamped to 100%', async () => {
    // Over-acquiring materials produces a percentage above 100, which must not
    // overflow the track.
    state.analytics.progress.materials.percent = 180;
    await openTab('analytics');

    const fills = document.querySelectorAll('#mp-analytics .mp-progress-fill');
    const widths = Array.from(fills).map((f) => parseFloat(f.style.width));
    expect(Math.max(...widths)).toBeLessThanOrEqual(100);
  });

  test('includes the ROI card', async () => {
    // ROI arrives as two top-level numbers under `summary`, not as a
    // {planned, actual, delta} group like the others.
    await openTab('analytics');

    const cards = document.querySelectorAll('#mp-analytics .mp-card');
    const roi = Array.from(cards).find((c) => c.textContent.includes('ROI'));
    expect(roi).toBeDefined();
    // Formatted as a percentage, not ISK.
    expect(roi.textContent).toContain('42.8%');
    expect(roi.textContent).toContain('55.0%');
  });

  test('renders Cost by Category from the ledger', async () => {
    // The Analytics payload carries no category breakdown, so this comes from
    // the ledger - which Analytics must load itself rather than depending on
    // the user having opened the Ledger tab first.
    await openTab('analytics');

    const text = document.getElementById('mp-analytics').textContent;
    expect(text).toContain('Cost by Category');
    expect(text).toContain('Materials');
    expect(text).toContain('Job installation');
  });

  test('Cost by Category percentages sum sensibly', async () => {
    await openTab('analytics');

    const values = Array.from(document.querySelectorAll('#mp-analytics .mp-cost-cat-value'))
      .map((n) => parseFloat((n.textContent.match(/([\d.]+)%/) || [])[1]));
    const total = values.reduce((sum, v) => sum + v, 0);
    expect(total).toBeCloseTo(100, 0);
  });

  test('spending LESS than planned is good', async () => {
    // Material cost delta is negative here - under budget.
    await openTab('analytics');

    const cards = document.querySelectorAll('#mp-analytics .mp-card');
    const costCard = Array.from(cards).find((c) => c.textContent.includes('Material Cost'));
    const delta = costCard.querySelector('.mp-compare-delta .mp-mono');
    expect(delta.classList.contains('mp-positive')).toBe(true);
  });

  test('earning MORE than planned is good', async () => {
    await openTab('analytics');

    const cards = document.querySelectorAll('#mp-analytics .mp-card');
    const valueCard = Array.from(cards).find((c) => c.textContent.includes('Product Value'));
    const delta = valueCard.querySelector('.mp-compare-delta .mp-mono');
    expect(delta.classList.contains('mp-positive')).toBe(true);
  });

  test('overspending is marked negative', async () => {
    state.analytics.materialCosts = {
      planned: 100_000, actual: 130_000, delta: 30_000, deltaPercent: 30,
    };
    await openTab('analytics');

    const cards = document.querySelectorAll('#mp-analytics .mp-card');
    const costCard = Array.from(cards).find((c) => c.textContent.includes('Material Cost'));
    const delta = costCard.querySelector('.mp-compare-delta .mp-mono');
    expect(delta.classList.contains('mp-negative')).toBe(true);
  });

  test('missing analytics renders a message, not a blank tab', async () => {
    state.analytics = null;
    await openTab('analytics');

    expect(document.getElementById('mp-analytics').textContent)
      .toContain('No analytics available');
  });
});

describe('ledger', () => {
  test('renders summary cards and section rows', async () => {
    await openTab('ledger');

    const text = document.getElementById('ledger-container').textContent;
    expect(text).toContain('Material Purchases');
    expect(text).toContain('Job Installation');
    expect(text).toContain('Tritanium');
  });

  test('marks an ESTIMATED job cost as estimated', async () => {
    // An estimate presented as a figure would misrepresent the plan's actuals.
    await openTab('ledger');
    expect(document.querySelector('#ledger-container .mp-ledger-tag').textContent).toBe('est.');
  });

  test('does not mark a real job cost as estimated', async () => {
    state.ledger.categories.jobInstallation.estimated = false;
    await openTab('ledger');
    expect(document.querySelector('#ledger-container .mp-ledger-tag')).toBeNull();
  });

  test('overspending shows a negative delta', async () => {
    // Spending MORE than planned is bad. Target .mp-recon-delta specifically:
    // the bar also holds planned and actual figures, which carry no verdict.
    await openTab('ledger');

    const delta = document.querySelector('#ledger-container .mp-recon-delta');
    expect(delta.textContent).toContain('Delta');
    expect(delta.textContent).toContain('1,200');
    expect(delta.classList.contains('mp-negative')).toBe(true);
    expect(delta.classList.contains('mp-positive')).toBe(false);
  });

  test('under budget shows a positive delta', async () => {
    state.ledger.reconciliation = { plannedCost: 8000, actualSpend: 6200, delta: -1800 };
    await openTab('ledger');

    const delta = document.querySelector('#ledger-container .mp-recon-delta');
    expect(delta.classList.contains('mp-positive')).toBe(true);
    expect(delta.classList.contains('mp-negative')).toBe(false);
  });

  test('the planned and actual figures carry no verdict colouring', async () => {
    // Only the delta means "good" or "bad" - colouring the raw figures would
    // imply a judgement about the numbers themselves.
    await openTab('ledger');

    const bar = document.querySelector('#ledger-container .mp-recon');
    const plain = bar.querySelectorAll('.mp-mono:not(.mp-recon-delta)');
    expect(plain.length).toBe(2);
    plain.forEach((span) => {
      expect(span.classList.contains('mp-positive')).toBe(false);
      expect(span.classList.contains('mp-negative')).toBe(false);
    });
  });

  test('an ESI-sourced row offers Unlink, a manual row offers Remove', async () => {
    // A manual row is yours to delete; an ESI row is a record of what happened.
    await openTab('ledger');

    const esiRow = document.querySelector('[data-mp-ledger-id="led-1"]');
    const manualRow = document.querySelector('[data-mp-ledger-id="led-2"]');
    expect(esiRow.querySelector('.mp-link-action').textContent).toBe('Unlink');
    expect(manualRow.querySelector('.mp-link-action').textContent).toBe('Remove');
  });

  test('the source label agrees with the action button', async () => {
    // Reported bug: a row read "manual" but offered Unlink, because the label
    // used sourceType while the button used `editable`. A null source is
    // editable, so it must READ as manual too.
    await openTab('ledger');

    document.querySelectorAll('#ledger-container [data-mp-ledger-id]').forEach((row) => {
      const action = row.querySelector('.mp-link-action');
      if (!action) return; // derived rows offer no action - covered separately
      const saysManual = row.textContent.includes('manual');
      expect(saysManual).toBe(action.textContent === 'Remove');
    });
  });

  test('a derived estimate offers no action at all', async () => {
    // The job-install estimate is computed, not stored (ledgerId null), so
    // "Remove" and "Unlink" would both fail.
    state.ledger.categories.jobInstallation.items = [{
      ledgerId: null,
      typeId: null,
      category: 'job_install',
      amount: 1200,
      estimated: true,
      editable: false,
      note: 'Estimated (2 jobs)',
    }];
    await openTab('ledger');

    const rows = document.querySelectorAll('#ledger-container .mp-ledger-row');
    const derived = Array.from(rows).find((r) => r.textContent.includes('estimated'));
    expect(derived).toBeDefined();
    expect(derived.querySelector('.mp-link-action')).toBeNull();
  });

  test('a cost row with no item is labelled by its category', async () => {
    // Cost rows carry type_id 0, so the Item cell was blank.
    await openTab('ledger');

    const costRow = document.querySelector('[data-mp-ledger-id="led-2"]');
    expect(costRow.textContent).toContain('Job installation');
    // ...and its Detail cell shows an em dash rather than "0 x -".
    expect(costRow.textContent).not.toContain('0 ×');
  });

  test('an item row shows its resolved name and quantity breakdown', async () => {
    await openTab('ledger');

    const itemRow = document.querySelector('[data-mp-ledger-id="led-1"]');
    expect(itemRow.textContent).toContain('Tritanium');
    expect(itemRow.textContent).toContain('1,000 ×');
    expect(itemRow.textContent).not.toMatch(/Type \d+/);
  });

  test('removing an entry sends its ledger id', async () => {
    await openTab('ledger');

    document
      .querySelector('[data-mp-ledger-id="led-2"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(state.calls.find((c) => c.fn === 'plans.unlinkLedgerEntry').ledgerId).toBe('led-2');
  });

  test('an empty ledger explains what to do', async () => {
    state.ledger.categories = {
      materialPurchases: { items: [], total: 0 },
      jobInstallation: { items: [], total: 0 },
      marketFees: { items: [], total: 0 },
      other: { items: [], total: 0 },
      productSales: { items: [], total: 0 },
    };
    await openTab('ledger');

    expect(document.getElementById('ledger-container').textContent)
      .toContain('No spend recorded yet');
  });
});

