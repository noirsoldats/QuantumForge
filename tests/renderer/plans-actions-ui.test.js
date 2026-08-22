/**
 * @jest-environment jsdom
 *
 * Manufacturing Plans - plan-level actions: rebuild, the header buttons, and
 * Re-lock Prices (the ONLY sanctioned way a plan adopts live prices).
 *
 * Split out of the original single Plans suite; the shared fake backend and
 * mount helpers live in ./helpers/plans-harness.
 */

const h = require('./helpers/plans-harness');

h.installHooks();

const { state, openTab, settle, allowErrors } = h;

/*
 * "Rebuild Plan" - the plan-header button that repairs stale stored state
 * (above all facility snapshots written by older versions, which silently
 * dropped structure/rig bonuses) and then recalculates.
 *
 * It REPLACED a dead "Refresh" button (`mp-refresh-plan`) that had no handler
 * anywhere and did nothing when clicked.
 */
describe('rebuild plan', () => {
  test('the dead Refresh button is gone', async () => {
    await openTab('overview');
    expect(document.getElementById('mp-refresh-plan')).toBeNull();
  });

  test('calls repairAndRecalculate for the open plan', async () => {
    await openTab('overview');
    document.getElementById('mp-recalc-all').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.repairAndRecalculate');
    expect(call).toBeTruthy();
    expect(call.planId).toBe('plan-1');
  });

  test('does NOT re-price - locked plan prices must survive a rebuild', async () => {
    // Plan prices are frozen deliberately; only an explicit re-lock may adopt
    // live prices. A quantity repair must not become a backdoor around that.
    await openTab('overview');
    document.getElementById('mp-recalc-all').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.repairAndRecalculate');
    expect(call.refreshPrices).toBe(false);
  });

  test('reloads the tab the user is actually on, not just the build list', async () => {
    // It lives in the plan header now, so it can be pressed from any tab - and
    // a rebuild changes quantities on all of them.
    await openTab('build-list');
    state.calls.length = 0;
    document.getElementById('mp-recalc-all').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'plans.getBuildItems')).toBe(true);
  });

  test('restores its label and stays enabled after finishing', async () => {
    await openTab('overview');
    const btn = document.getElementById('mp-recalc-all');
    btn.dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(btn.disabled).toBe(false);
    expect(document.getElementById('mp-recalc-all-label').textContent).toBe('Rebuild Plan');
    // The icon must survive the busy-state swap.
    expect(btn.querySelector('svg')).toBeTruthy();
  });

  test('says so when the rebuild fails, rather than reporting success', async () => {
    // The renderer logs this failure deliberately; the suite fails on any
    // console.error that was not opted into.
    allowErrors(/rebuild plan failed/);

    // The handler reports failure in the ENVELOPE rather than throwing, so a
    // renderer that assumed success would show "done" over a plan that never
    // rebuilt.
    window.electronAPI.plans.repairAndRecalculate = async () => (
      { success: false, error: 'Plan not found' }
    );

    await openTab('overview');
    document.getElementById('mp-recalc-all').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const errorToast = state.calls.find((c) => c.fn === 'toast' && c.type === 'error');
    expect(errorToast).toBeTruthy();
    expect(errorToast.message).toMatch(/Plan not found/);
  });
});

/*
 * Plan header actions that shipped in the UI refactor with NO handler at all -
 * present in the HTML, wired to nothing, silent on click.
 */
describe('plan header actions (previously unwired)', () => {
  test('Mark Complete sets status and a completion timestamp', async () => {
    await openTab('overview');
    document.getElementById('mp-complete-plan').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.update');
    expect(call).toBeTruthy();
    expect(call.planId).toBe('plan-1');
    // CAMELCASE: updateManufacturingPlan maps these itself; `completed_at`
    // would be dropped and the call would still report success.
    expect(call.updates.status).toBe('completed');
    expect(typeof call.updates.completedAt).toBe('number');
  });

  test('the button reads Reopen Plan on a completed plan, and reopens it', async () => {
    state.plans[0].status = 'completed';
    await openTab('overview');

    expect(document.getElementById('mp-complete-plan-label').textContent).toBe('Reopen Plan');

    document.getElementById('mp-complete-plan').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.update');
    expect(call.updates.status).toBe('active');
    // Clearing the timestamp matters - otherwise a running plan stays dated.
    expect(call.updates.completedAt).toBeNull();
  });

  test('Delete asks first, and does nothing when declined', async () => {
    window.confirm = () => false;
    await openTab('overview');
    document.getElementById('delete-plan-btn').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'plans.delete')).toBe(false);
  });

  test('Delete removes the plan and clears the selection once confirmed', async () => {
    window.confirm = () => true;
    await openTab('overview');
    document.getElementById('delete-plan-btn').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.delete');
    expect(call).toBeTruthy();
    expect(call.planId).toBe('plan-1');
    // The detail pane must not stay bound to a deleted plan.
    expect(document.getElementById('plan-detail').hidden).toBe(true);
  });

  test('Rename prefills the modal from the open plan', async () => {
    await openTab('overview');
    document.getElementById('mp-rename-plan').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(document.getElementById('mp-rename-modal').hidden).toBe(false);
    expect(document.getElementById('mp-rename-name').value).toBe(state.plans[0].planName);
  });

  test('Rename saves with camelCase planName', async () => {
    await openTab('overview');
    document.getElementById('mp-rename-plan').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    document.getElementById('mp-rename-name').value = 'Renamed Plan';
    document.getElementById('mp-rename-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.update');
    expect(call.updates.planName).toBe('Renamed Plan');
    expect(document.getElementById('mp-rename-modal').hidden).toBe(true);
  });

  test('Rename refuses an empty name rather than blanking the plan', async () => {
    // Auto-naming only happens on CREATE, so an empty name here would stick.
    await openTab('overview');
    document.getElementById('mp-rename-plan').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    document.getElementById('mp-rename-name').value = '   ';
    document.getElementById('mp-rename-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'plans.update')).toBe(false);
    expect(state.calls.some((c) => c.fn === 'toast' && c.type === 'warning')).toBe(true);
  });
});

/*
 * Re-lock Prices - the ONLY sanctioned way a plan adopts live prices. Every
 * other path (market refresh, recalculate, rebuild) leaves them frozen.
 */
describe('re-lock prices (previously unwired)', () => {
  test('does nothing when declined', async () => {
    window.confirm = () => false;
    await openTab('materials');
    document.getElementById('mp-relock').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'market.relockPlanMaterial')).toBe(false);
  });

  test('re-locks each material at its live price', async () => {
    window.confirm = () => true;
    await openTab('materials');
    document.getElementById('mp-relock').dispatchEvent(new window.MouseEvent('click'));
    await settle(50);

    const relocks = state.calls.filter((c) => c.fn === 'market.relockPlanMaterial');
    expect(relocks.length).toBeGreaterThan(0);
    // The live price, not the locked one - locking at the frozen price would
    // be a no-op dressed up as an action.
    for (const r of relocks) {
      expect(r.price).toBe(state.drift[r.typeId].livePrice);
    }
  });

  /*
   * The button must NEVER be unable to re-lock because of what the user has
   * looked at. state.drift is populated by the Materials tab, so reading it
   * directly meant opening a plan and pressing Re-lock from another tab
   * reported "no prices" against a perfectly warm market cache.
   */
  test('re-reads prices itself rather than depending on the Materials tab', async () => {
    window.confirm = () => true;
    // Overview never loads drift.
    await openTab('overview');
    state.calls.length = 0;

    document.getElementById('mp-relock').dispatchEvent(new window.MouseEvent('click'));
    await settle(50);

    // It fetched prices on demand...
    expect(state.calls.some((c) => c.fn === 'plans.getMaterialDrift')).toBe(true);
    // ...and actually locked, instead of warning that nothing was available.
    expect(state.calls.some((c) => c.fn === 'market.relockPlanMaterial')).toBe(true);
  });

  test('skips materials with no live price instead of locking them at zero', async () => {
    window.confirm = () => true;
    // Drop one material's live price entirely.
    delete state.drift[35];
    await openTab('materials');
    document.getElementById('mp-relock').dispatchEvent(new window.MouseEvent('click'));
    await settle(50);

    const relocks = state.calls.filter((c) => c.fn === 'market.relockPlanMaterial');
    expect(relocks.some((r) => r.typeId === 35)).toBe(false);
    expect(relocks.every((r) => Number.isFinite(r.price) && r.price > 0)).toBe(true);
  });

  test('warns rather than calling when nothing has a live price', async () => {
    window.confirm = () => true;
    state.drift = {};
    await openTab('materials');
    document.getElementById('mp-relock').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'market.relockPlanMaterial')).toBe(false);
    expect(state.calls.some((c) => c.fn === 'toast' && c.type === 'warning')).toBe(true);
  });
});

describe('build list - mixed values', () => {
  // getPlanBuildItems returns the literal object { mixed: true } when a type's
  // instances disagree. Rendering it as a value produces "[object Object]" and
  // would save it as one.
  test('a mixed build plan reads "Mixed", not [object Object]', async () => {
    state.buildItems[0].useIntermediates = { mixed: true };
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.textContent).toContain('Mixed');
    expect(row.textContent).not.toContain('[object Object]');
  });

  test('a mixed facility reads "Mixed", not [object Object]', async () => {
    state.buildItems[0].facilityId = { mixed: true };
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.textContent).toContain('Mixed');
    expect(row.textContent).not.toContain('[object Object]');
  });

  test('a mixed ME shows an em dash rather than an object', async () => {
    state.buildItems[0].meLevel = { mixed: true };
    await openTab('build-list');

    const row = document.querySelector('[data-mp-build-type="22546"]');
    expect(row.textContent).not.toContain('[object Object]');
    expect(row.textContent).not.toContain('mixed');
  });

  test('editing a mixed numeric field starts empty, not with an object', async () => {
    state.buildItems[0].meLevel = { mixed: true };
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const inputs = document.querySelectorAll('[data-mp-build-type="22546"] .mp-build-input');
    const mixedInput = Array.from(inputs).find((i) => i.placeholder === 'Mixed');
    expect(mixedInput).toBeDefined();
    expect(mixedInput.value).toBe('');
  });

  test('a mixed field is not saved unless the user sets a value', async () => {
    // Opening a row with mixed values and saving must not write { mixed: true }
    // to every instance.
    state.buildItems[0].useIntermediates = { mixed: true };
    await openTab('build-list');
    document
      .querySelector('[data-mp-build-type="22546"] .mp-link-action')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const actions = document.querySelectorAll('[data-mp-build-type="22546"] .mp-link-action');
    actions[0].dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.updateBuildItemsByType');
    // Nothing was edited, so nothing is written.
    expect(call).toBeUndefined();
  });
});

