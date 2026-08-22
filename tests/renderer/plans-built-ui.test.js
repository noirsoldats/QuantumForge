/**
 * @jest-environment jsdom
 *
 * Manufacturing Plans - marking things built, the Products tab, and the ESI
 * job/transaction matches.
 *
 * Split out of the original single Plans suite; the shared fake backend and
 * mount helpers live in ./helpers/plans-harness.
 */

const h = require('./helpers/plans-harness');

h.installHooks();

const { state, mountWithPlan, openTab, settle } = h;

describe('mark built', () => {
  async function openBuiltModal(id = 'pbp-child') {
    await openTab('blueprints');
    document
      .querySelector(`[data-mp-mark-built="${id}"]`)
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);
  }

  test('only intermediates offer Mark Built', async () => {
    // A top-level entry is the plan's own output, tracked through industry
    // jobs rather than hand-entered.
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-mark-built="pbp-child"]')).not.toBeNull();
    expect(document.querySelector('[data-mp-mark-built="pbp-1"]')).toBeNull();
  });

  test('top-level entries remain removable', async () => {
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-1"]');
    expect(row.querySelector('.mp-link-danger')).not.toBeNull();
  });

  test('the action reads Edit Built Qty once something is built', async () => {
    await openTab('blueprints');
    expect(document.querySelector('[data-mp-mark-built="pbp-child"]').textContent)
      .toBe('Edit Built Qty');
  });

  test('the action reads Mark Built when nothing is built yet', async () => {
    state.planBlueprints[1].builtRuns = 0;
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-mark-built="pbp-child"]').textContent)
      .toBe('Mark Built');
  });

  test('a partially built intermediate shows an amber progress badge', async () => {
    await openTab('blueprints');

    const badge = document.querySelector('[data-mp-built-badge="pbp-child"]');
    expect(badge.textContent).toBe('3/12 Built (25%)');
    expect(badge.classList.contains('mp-built-full')).toBe(false);
  });

  test('the built badge sits on the sub-line, not beside the name', async () => {
    // A pill next to a long blueprint name ate the width the name needed
    // and truncated it.
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-child"]');
    const badge = row.querySelector('[data-mp-built-badge]');
    expect(badge.closest('.mp-bp-subline')).not.toBeNull();
    expect(badge.closest('.mp-mat-name')).toBeNull();
  });

  test('a fully built intermediate is badged green', async () => {
    state.planBlueprints[1].builtRuns = 12;
    await openTab('blueprints');

    const badge = document.querySelector('[data-mp-built-badge="pbp-child"]');
    expect(badge.textContent).toBe('12/12 Built (100%)');
    expect(badge.classList.contains('mp-built-full')).toBe(true);
  });

  test('nothing built draws no badge at all', async () => {
    // A 0/12 badge on every unstarted row is noise.
    state.planBlueprints[1].builtRuns = 0;
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-built-badge="pbp-child"]')).toBeNull();
  });

  test('the modal opens seeded with the current built runs', async () => {
    await openBuiltModal();

    expect(document.getElementById('mp-built-modal').hidden).toBe(false);
    expect(document.getElementById('mp-built-runs').value).toBe('3');
    expect(document.getElementById('mp-built-runs').max).toBe('12');
  });

  test('the modal names the PRODUCT, not the blueprint', async () => {
    // The user holds the product in a hangar; the blueprint is only how it
    // is made.
    await openBuiltModal();

    const text = document.getElementById('mp-built-item').textContent;
    expect(text).toContain('Morphite');            // the product
    expect(text).not.toContain('Morphite Blueprint');
    expect(text).toContain('12');                  // total runs needed
  });

  test('quick actions are percentages of the total', async () => {
    // The same five buttons have to work for a 4-run job and a 4,000-run one.
    await openBuiltModal();

    const quick = Array.from(document.querySelectorAll('[data-mp-built-quick]'));
    expect(quick.map((b) => b.textContent)).toEqual(['0%', '25%', '50%', '75%', '100%']);

    quick[2].dispatchEvent(new window.MouseEvent('click'));
    expect(document.getElementById('mp-built-runs').value).toBe('6');
    expect(document.getElementById('mp-built-pct').textContent).toBe('50%');
  });

  test('typing updates the progress bar', async () => {
    await openBuiltModal();

    const input = document.getElementById('mp-built-runs');
    input.value = '9';
    input.dispatchEvent(new window.Event('input'));

    expect(document.getElementById('mp-built-pct').textContent).toBe('75%');
    expect(document.getElementById('mp-built-bar-fill').style.width).toBe('75%');
  });

  test('owned assets are listed per hangar', async () => {
    // "How many do I already have?" is the question that decides what to
    // enter, so the answer belongs in this modal.
    await openBuiltModal();

    const text = document.getElementById('mp-built-assets').textContent;
    expect(text).toContain('700');                       // personal + corp
    expect(text).toContain('Valen Kor');
    expect(text).toContain('Forge Dynamics – Component Stock');
  });

  test('assets are looked up for the product, scoped to the plan', async () => {
    await openBuiltModal();

    const call = state.calls.find((c) => c.fn === 'plans.getProductOwnedAssets');
    expect(call.planId).toBe('plan-1');
    expect(call.typeId).toBe(11399);
  });

  test('says so plainly when no assets are held', async () => {
    state.productOwnedAssets = {
      ownedPersonal: 0, ownedCorp: 0, personalDetails: [], corpDetails: [],
    };
    await openBuiltModal();

    expect(document.getElementById('mp-built-assets').textContent)
      .toContain('No assets found');
  });

  test('saving routes a manufacturing intermediate to markIntermediateBuilt', async () => {
    await openBuiltModal();
    document.getElementById('mp-built-runs').value = '7';
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    const call = state.calls.find((c) => c.fn === 'plans.markIntermediateBuilt');
    expect(call).toMatchObject({ planBlueprintId: 'pbp-child', builtRuns: 7 });
    expect(state.calls.some((c) => c.fn === 'plans.markReactionBuilt')).toBe(false);
  });

  // Reaction routing is covered from the Reactions tab ("reactions offer Mark
  // Built and route to markReactionBuilt") - reactions no longer appear on the
  // Blueprints tab at all, so there is no reaction row to open a modal from
  // here.

  test('saving refreshes the materials, which the built runs credit', async () => {
    await openBuiltModal();
    state.calls.length = 0;
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(state.calls.some((c) => c.fn === 'plans.getMaterials')).toBe(true);
    expect(document.getElementById('mp-built-modal').hidden).toBe(true);
  });

  test('runs beyond the total are refused before they reach main', async () => {
    await openBuiltModal();
    document.getElementById('mp-built-runs').value = '99';
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'plans.markIntermediateBuilt')).toBe(false);
    expect(document.getElementById('mp-built-modal').hidden).toBe(false);
  });

  test('a negative value is refused', async () => {
    await openBuiltModal();
    document.getElementById('mp-built-runs').value = '-1';
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'plans.markIntermediateBuilt')).toBe(false);
  });

  test('zero is allowed - it un-marks a mistake', async () => {
    await openBuiltModal();
    document.getElementById('mp-built-runs').value = '0';
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    const call = state.calls.find((c) => c.fn === 'plans.markIntermediateBuilt');
    expect(call.builtRuns).toBe(0);
  });

  test('closing abandons an in-flight asset lookup', async () => {
    // A late response must not paint into whatever is open next.
    await openTab('blueprints');
    document
      .querySelector('[data-mp-mark-built="pbp-child"]')
      .dispatchEvent(new window.MouseEvent('click'));

    document
      .querySelector('[data-mp-close="mp-built-modal"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(document.getElementById('mp-built-assets').textContent).toBe('');
  });
});

describe('products', () => {
  test('separates final products from intermediates', async () => {
    // Only a FINAL product is sold; an intermediate is a cascading input the
    // plan consumes. Listing them together would imply both are revenue.
    await openTab('products');

    const titles = Array.from(document.querySelectorAll('#products-container .mp-section-title'))
      .map((n) => n.textContent);
    expect(titles).toEqual(['Final Products', 'Intermediate Components']);
  });

  test('marks intermediates as consumed, not sold', async () => {
    await openTab('products');
    expect(document.getElementById('products-container').textContent)
      .toContain('Consumed by this plan, not sold');
  });

  test('renders quantity and locked price per product', async () => {
    await openTab('products');

    const rows = document.querySelectorAll('#products-container .mp-product-row');
    // Header + 1 final, header + 1 intermediate.
    const hulkRow = Array.from(rows).find((r) => r.textContent.includes('Hulk'));
    expect(hulkRow.textContent).toContain('4');
    expect(hulkRow.textContent).toContain('250,000,000');
  });

  test('renders Total m³ per product and per section', async () => {
    // The mockup's third column. Volumes are fetched for MATERIALS elsewhere,
    // so products need their own lookup - without it this column is blank.
    state.volumes[22544] = 50_000;
    await openTab('products');

    const rows = document.querySelectorAll('#products-container .mp-product-row');
    const hulkRow = Array.from(rows).find((r) => r.textContent.includes('Hulk'));
    // 4 x 50,000
    expect(hulkRow.textContent).toContain('200,000.00 m³');

    const totalRow = document.querySelector('#products-container .mp-materials-total');
    expect(totalRow.textContent).toContain('m³');
  });
});

describe('jobs and transactions', () => {
  test('pending counts appear as tab badges before the tab is opened', async () => {
    // The badge is the only cue that something is waiting for a decision, so
    // it cannot wait until the tab is visited.
    await mountWithPlan();

    expect(document.getElementById('mp-jobs-badge').hidden).toBe(false);
    expect(document.getElementById('mp-jobs-badge').textContent).toBe('1');
    expect(document.getElementById('mp-transactions-badge').textContent).toBe('1');
  });

  test('badges are hidden when nothing is pending', async () => {
    state.pendingMatches = { jobMatches: [], transactionMatches: [] };
    await mountWithPlan();

    expect(document.getElementById('mp-jobs-badge').hidden).toBe(true);
    expect(document.getElementById('mp-transactions-badge').hidden).toBe(true);
  });

  test('pending and linked jobs are listed separately', async () => {
    await openTab('jobs');

    const titles = Array.from(document.querySelectorAll('#jobs-container .mp-section-title'))
      .map((n) => n.textContent);
    expect(titles).toEqual(['Pending Job Matches', 'Linked Jobs']);
  });

  test('job rows read the NESTED job object', async () => {
    // Job identity lives under match.job - jobId, runs and characterName are
    // not top-level. Reading them flat rendered blanks.
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    expect(row.textContent).toContain('Hulk Blueprint');  // job.blueprintTypeId -> name
    expect(row.textContent).toContain('555001');          // job.jobId
    expect(row.textContent).toContain('Buckwalter');      // job.characterName
    expect(row.textContent).toContain('4');               // job.runs
    expect(row.textContent).not.toMatch(/Type \d+/);
  });

  test('job rows carry every mockup column', async () => {
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    // Status, Facility and Started were missing entirely.
    expect(row.querySelector('.mp-job-status').textContent).toBe('active');
    expect(row.textContent).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);   // started
  });

  test('facilities resolve to names via the shared location resolver', async () => {
    // NPC stations from the SDE, player structures via ESI - both handled by
    // location.resolve, which caches in main.
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    expect(row.textContent).toContain('Jita IV');
    expect(row.textContent).not.toContain('Facility 60003760');

    // Resolution needs the character that can SEE the structure.
    const call = state.calls.find((c) => c.fn === 'location.resolve');
    expect(call.locationId).toBe(60003760);
    expect(call.characterId).toBe(91316135);
  });

  test('an unresolvable facility falls back to its id, not "Unknown"', async () => {
    // 'Unknown' is the resolver's failure string; storing it would be worse
    // than showing the id the user can look up.
    state.locationNames = {};
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    expect(row.textContent).toContain('Facility 60003760');
  });

  test('each facility is resolved once, not per row', async () => {
    // Two matches at the same facility must not mean two ESI lookups.
    state.confirmedJobs[0].job.facilityId = 60003760;
    await openTab('jobs');

    const resolveCalls = state.calls.filter((c) => c.fn === 'location.resolve');
    expect(resolveCalls).toHaveLength(1);
  });

  test('the jobs table has column headers', async () => {
    await openTab('jobs');

    const header = document.querySelector('#jobs-container .mp-build-header');
    ['Blueprint', 'Character', 'Job ID', 'Runs', 'Status', 'Facility', 'Started']
      .forEach((label) => expect(header.textContent).toContain(label));
  });

  test('transaction rows read the NESTED transaction object', async () => {
    await openTab('transactions');

    const row = document.querySelector('[data-mp-match-id="tm-1"]');
    expect(row.textContent).toContain('Tritanium');
    expect(row.textContent).toContain('777001');
    expect(row.textContent).toContain('Buckwalter');
  });

  test('transaction rows show date, price, total and direction', async () => {
    // The financial columns are the point of this tab and were all missing.
    await openTab('transactions');

    const row = document.querySelector('[data-mp-match-id="tm-1"]');
    expect(row.textContent).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);  // date
    expect(row.textContent).toContain('5.50');                    // unit price
    expect(row.textContent).toContain('5,500.00');                // 1000 x 5.50
    expect(row.querySelector('.mp-tx-type').textContent).toBe('Buy');
  });

  test('a buy is coloured as money out', async () => {
    await openTab('transactions');

    const badge = document.querySelector('[data-mp-match-id="tm-1"] .mp-tx-type');
    expect(badge.getAttribute('data-tx-type')).toBe('buy');
  });

  test('the confidence badge exposes its reasoning on hover', async () => {
    // A score with no explanation asks the user to trust the heuristic.
    await openTab('jobs');

    const conf = document.querySelector('[data-mp-match-id="jm-1"] .mp-center');
    expect(conf.title).toContain('blueprint');
  });

  test('a pending match shows its confidence as a number', async () => {
    // A colour alone asks the user to trust the heuristic; the number lets
    // them judge.
    await openTab('jobs');

    const badge = document.querySelector('#jobs-container .confidence-badge');
    expect(badge.textContent).toBe('92%');
    expect(badge.classList.contains('high')).toBe(true);
  });

  test('a weak match is badged low, not high', async () => {
    await openTab('transactions');

    const badge = document.querySelector('#transactions-container .confidence-badge');
    expect(badge.textContent).toBe('45%');
    expect(badge.classList.contains('low')).toBe(true);
  });

  test('confirming a job match sends its id', async () => {
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    row.querySelectorAll('.mp-link-action')[0].dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(state.calls.find((c) => c.fn === 'plans.confirmJobMatch').matchId).toBe('jm-1');
  });

  test('rejecting a job match sends its id', async () => {
    await openTab('jobs');

    const row = document.querySelector('[data-mp-match-id="jm-1"]');
    row.querySelectorAll('.mp-link-action')[1].dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(state.calls.find((c) => c.fn === 'plans.rejectJobMatch').matchId).toBe('jm-1');
  });

  test('a linked job offers Unlink, not Confirm', async () => {
    await openTab('jobs');

    const linkedSection = document.querySelectorAll('#jobs-container .mp-section')[1];
    const actions = Array.from(linkedSection.querySelectorAll('.mp-link-action'))
      .map((b) => b.textContent);
    expect(actions).toEqual(['Unlink']);
  });

  test('confirming a transaction sends its id', async () => {
    await openTab('transactions');

    const row = document.querySelector('[data-mp-match-id="tm-1"]');
    row.querySelectorAll('.mp-link-action')[0].dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(state.calls.find((c) => c.fn === 'plans.confirmTransactionMatch').matchId).toBe('tm-1');
  });

  test('Match Jobs scans and saves the results', async () => {
    await openTab('jobs');
    state.calls.length = 0;

    document.getElementById('mp-match-jobs').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'plans.matchJobs')).toBe(true);
    expect(state.calls.some((c) => c.fn === 'plans.saveJobMatches')).toBe(true);
  });

  test('Match Transactions scans and saves the results', async () => {
    await openTab('transactions');
    state.calls.length = 0;

    document.getElementById('mp-match-transactions').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'plans.matchTransactions')).toBe(true);
    expect(state.calls.some((c) => c.fn === 'plans.saveTransactionMatches')).toBe(true);
  });

  test('an empty pending list shows guidance rather than a bare table', async () => {
    state.pendingMatches = { jobMatches: [], transactionMatches: [] };
    await openTab('jobs');

    expect(document.getElementById('jobs-container').textContent)
      .toContain('No pending job matches');
  });
});

