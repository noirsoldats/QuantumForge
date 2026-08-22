/**
 * @jest-environment jsdom
 *
 * Manufacturing Plans - tabs and the Build List, which is the editing home for
 * per-type ME/TE, Build Plan and Facility.
 *
 * Split out of the original single Plans suite; the shared fake backend and
 * mount helpers live in ./helpers/plans-harness.
 */

const h = require('./helpers/plans-harness');

h.installHooks();

const { state, mountWithPlan, openTab, settle } = h;

describe('tabs', () => {
  test('switching tabs moves the active panel', async () => {
    await mountWithPlan();

    document
      .querySelector('.tab-button[data-tab="materials"]')
      .dispatchEvent(new window.MouseEvent('click'));

    expect(document.getElementById('materials-tab').classList.contains('active')).toBe(true);
    expect(document.getElementById('overview-tab').classList.contains('active')).toBe(false);
  });

  test('exactly one panel is active at a time', async () => {
    await mountWithPlan();

    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));

    expect(document.querySelectorAll('#mp-view .tab-panel.active')).toHaveLength(1);
    expect(document.querySelectorAll('#mp-view .tab-button.active')).toHaveLength(1);
  });

  test('later-slice panels exist so the strip is complete', async () => {
    // These are placeholders, but the tabs must switch to them without error -
    // a missing panel would throw on click.
    await mountWithPlan();

    ['blueprints', 'build-list', 'products', 'jobs', 'transactions', 'analytics', 'ledger', 'settings']
      .forEach((tab) => {
        expect(document.getElementById(`${tab}-tab`)).not.toBeNull();
      });
  });
});

describe('build list', () => {
  test('groups rows by role', async () => {
    await openTab('build-list');

    const titles = Array.from(document.querySelectorAll('#build-list-container .mp-section-title'))
      .map((n) => n.textContent);
    expect(titles).toEqual(['Blueprints', 'Intermediates', 'Reactions']);
  });

  test('renders a row per build item', async () => {
    await openTab('build-list');
    expect(document.querySelectorAll('#build-list-container .mp-build-row[data-mp-build-type]'))
      .toHaveLength(3);
  });

  test('resolves the facility name rather than showing its id', async () => {
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.textContent).toContain('Jita Raitaru');
    expect(row.textContent).not.toContain('fac-1');
  });

  test('a row with no facility reads "No Facility"', async () => {
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="11399"]');
    expect(row.textContent).toContain('No Facility');
  });

  test('reactions show no ME/TE rather than 0', async () => {
    // Reactions have no ME/TE at all; rendering 0 would imply they do.
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="46186"]');
    expect(row.textContent).not.toMatch(/\bME\b/);
    expect(row.textContent).toContain('Fullerene Reaction');
  });

  /*
   * Derived rows previously rendered "—" for Runs. That was wrong: the runs are
   * derived, not absent, and a blank column on every intermediate and reaction
   * read as "no runs" on exactly the rows a build is scheduled around. They now
   * show the derived total, read-only (no input) so it still cannot be edited.
   */
  test('an intermediate shows its derived total runs, not a blank', async () => {
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="11399"]');
    const statics = Array.from(row.querySelectorAll('.mp-build-static')).map((n) => n.textContent);
    // totalRuns: 12 across its 3 uses.
    expect(statics).toContain('12');
    // Still not editable - derived, so no input is offered for runs.
    expect(row.querySelectorAll('.mp-build-input')).toHaveLength(0);
  });

  test('a reaction shows its derived total runs', async () => {
    // Reactions are never runsEditable, so they took the same blank path.
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="46186"]');
    const statics = Array.from(row.querySelectorAll('.mp-build-static')).map((n) => n.textContent);
    expect(statics).toContain('2');
  });

  test('Lines still shows an em dash on a derived row', async () => {
    // Only Runs gained a derived value; lines remain genuinely not applicable.
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="11399"]');
    const statics = Array.from(row.querySelectorAll('.mp-build-static')).map((n) => n.textContent);
    expect(statics).toContain('—');
  });

  test('Uses column explains itself rather than showing a bare count', async () => {
    // The number is what makes ME/TE/Facility read "Mixed"; unlabelled it was
    // not interpretable.
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="11399"]');
    const uses = Array.from(row.querySelectorAll('span'))
      .find((n) => n.title && n.title.includes('Needed in'));
    expect(uses).toBeTruthy();
    expect(uses.textContent).toBe('3');
    expect(uses.title).toContain('3 places');
  });

  test('is read-only until Edit is clicked', async () => {
    await openTab('build-list');

    expect(document.querySelectorAll('#build-list-container .mp-build-input')).toHaveLength(0);
    expect(document.querySelectorAll('#build-list-container .mp-link-action').length)
      .toBeGreaterThan(0);
  });

  test('Edit makes exactly that row editable', async () => {
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    row.querySelector('.mp-link-action').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(
      document.querySelector('[data-mp-build-type="22546"] .mp-build-input')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-mp-build-type="11399"] .mp-build-input')
    ).toBeNull();
  });

  test('saving a row sends only that row\'s changes', async () => {
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const input = document.querySelector('[data-mp-build-type="22546"] .mp-build-input');
    input.value = '8';
    input.dispatchEvent(new window.Event('change'));

    const actions = document.querySelectorAll('[data-mp-build-type="22546"] .mp-link-action');
    actions[0].dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    // Type-scoped: main resolves the plan blueprints from the TYPE, because
    // one Build List row can stand for several of them.
    const call = state.calls.find((c) => c.fn === 'plans.updateBuildItemsByType');
    expect(call.planId).toBe('plan-1');
    expect(call.blueprintTypeId).toBe(22546);
    expect(call.itemType).toBe('manufacturing');
    expect(call.updates.runs).toBe(8);
    expect(state.calls.some((c) => c.fn === 'plans.bulkUpdateBlueprints')).toBe(false);
  });

  test('cancelling a row discards the edit without writing', async () => {
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const input = document.querySelector('[data-mp-build-type="22546"] .mp-build-input');
    input.value = '99';
    input.dispatchEvent(new window.Event('change'));

    const actions = document.querySelectorAll('[data-mp-build-type="22546"] .mp-link-action');
    actions[1].dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(state.calls.some((c) => c.fn === 'plans.updateBuildItemsByType')).toBe(false);
    // ...and the original value is back on screen.
    expect(document.querySelector('[data-mp-build-type="22546"]').textContent).toContain('4');
  });

  test('bulk edit makes every row editable at once', async () => {
    await openTab('build-list');

    document.getElementById('mp-bulk-edit').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(document.getElementById('mp-bulk-banner').hidden).toBe(false);
    expect(document.getElementById('mp-bulk-save').hidden).toBe(false);
    // Every row that HAS an editable field shows one.
    expect(document.querySelectorAll('#build-list-container .mp-build-input').length)
      .toBeGreaterThan(3);
  });

  test('bulk save sends every changed row in one call', async () => {
    await openTab('build-list');
    document.getElementById('mp-bulk-edit').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const rows = ['22546', '11399'];
    rows.forEach((typeId) => {
      const input = document.querySelector(`[data-mp-build-type="${typeId}"] .mp-build-input`);
      input.value = '7';
      input.dispatchEvent(new window.Event('change'));
    });

    document.getElementById('mp-bulk-save').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    // One call per edited type, not one batched call.
    const saves = state.calls.filter((c) => c.fn === 'plans.updateBuildItemsByType');
    expect(saves).toHaveLength(2);
    expect(saves.map((c) => c.blueprintTypeId).sort()).toEqual([11399, 22546]);
  });

  test('bulk cancel discards everything without writing', async () => {
    await openTab('build-list');
    document.getElementById('mp-bulk-edit').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const input = document.querySelector('#build-list-container .mp-build-input');
    input.value = '42';
    input.dispatchEvent(new window.Event('change'));

    document.getElementById('mp-bulk-cancel').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(state.calls.some((c) => c.fn === 'plans.updateBuildItemsByType')).toBe(false);
    expect(document.getElementById('mp-bulk-banner').hidden).toBe(true);
  });

  test('switching plans discards unsaved edits', async () => {
    // Edits are keyed by blueprintTypeId, so leaking them across a plan switch
    // would silently write them to the WRONG plan.
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const input = document.querySelector('[data-mp-build-type="22546"] .mp-build-input');
    input.value = '99';
    input.dispatchEvent(new window.Event('change'));

    document.querySelectorAll('.mp-plan-card')[1].dispatchEvent(new window.MouseEvent('click'));
    await settle(40);
    document
      .querySelector('.tab-button[data-tab="build-list"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    document.getElementById('mp-bulk-save').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(state.calls.some((c) => c.fn === 'plans.updateBuildItemsByType')).toBe(false);
  });

  test('the build-plan selector offers exactly the three implemented modes', async () => {
    // build_buy is stored and displayable but UNIMPLEMENTED ("coming in a
    // future update") and has never been selectable. Offering it would let a
    // user choose a mode that does nothing.
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const selects = document.querySelectorAll('[data-mp-build-type="22546"] .mp-row-select');
    // Second select in the row is Build Plan (first is Facility).
    const values = Array.from(selects[1].options)
      .map((o) => o.value)
      .filter(Boolean);
    expect(values).toEqual(['raw_materials', 'components', 'buy']);
    expect(values).not.toContain('build_buy');
  });

  test('carries no role pill and no product subtext', async () => {
    // Rows are already grouped under a Blueprints/Intermediates/Reactions
    // heading, and the blueprint name says what it makes. Both only cost
    // width on a table that cannot spare it.
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.querySelector('.mp-role')).toBeNull();
    expect(row.textContent).not.toContain('Product:');
  });

  test('a reaction row saves with itemType "reaction"', async () => {
    // itemType selects the blueprint_type column in main; sending the wrong
    // one silently updates nothing.
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="46186"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const select = document.querySelector('[data-mp-build-type="46186"] .mp-row-select');
    select.value = 'fac-1';
    select.dispatchEvent(new window.Event('change'));

    document
      .querySelectorAll('[data-mp-build-type="46186"] .mp-link-action')[0]
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.updateBuildItemsByType');
    expect(call.itemType).toBe('reaction');
    expect(call.blueprintTypeId).toBe(46186);
  });

  test('editable cells use plain selects, not searchable comboboxes', async () => {
    // Short fixed lists, and the popover rendered its value unreadably in a
    // table cell. A native dropdown is drawn by the OS, so it can extend
    // past the column instead of being squeezed into it.
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.querySelectorAll('select.mp-row-select')).toHaveLength(2);
    expect(row.querySelector('.qf-ss-trigger')).toBeNull();
  });

  test('a row already storing build_buy still shows its real value', async () => {
    // Not selectable is not the same as not displayable - a row set to
    // build_buy by earlier data must not render blank.
    state.buildItems[0].useIntermediates = 'build_buy';
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.textContent).toContain('Build/Buy');
  });
});

