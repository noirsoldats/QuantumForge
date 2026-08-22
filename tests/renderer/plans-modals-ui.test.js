/**
 * @jest-environment jsdom
 *
 * Manufacturing Plans - modals, view lifecycle and render resilience.
 *
 * Split out of the original single Plans suite; the shared fake backend and
 * mount helpers live in ./helpers/plans-harness.
 */

const h = require('./helpers/plans-harness');

h.installHooks();

const { state, mountView, mountWithPlan, settle, allowErrors, makeCtx } = h;

describe('modals', () => {
  test('all modals are closed on mount (rule 6a)', async () => {
    await mountView();
    await settle();

    document.querySelectorAll('#mp-view .modal').forEach((modal) => {
      expect(modal.hidden).toBe(true);
    });
  });

  test('New Plan opens the create modal with empty fields', async () => {
    await mountView();
    await settle();

    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));

    expect(document.getElementById('mp-create-modal').hidden).toBe(false);
    expect(document.getElementById('mp-create-name').value).toBe('');
  });

  test('creating a plan sends the name and selects it', async () => {
    await mountView();
    await settle();
    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));

    document.getElementById('mp-create-name').value = 'New Batch';
    document.getElementById('mp-create-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.create');
    expect(call.name).toBe('New Batch');
    expect(document.getElementById('mp-create-modal').hidden).toBe(true);
  });

  test('an empty plan name is sent as null for auto-generation', async () => {
    await mountView();
    await settle();
    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));
    document.getElementById('mp-create-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.find((c) => c.fn === 'plans.create').name).toBeNull();
  });

  test('a plan missing from the list is fetched directly', async () => {
    // Regression: selecting an id absent from the sidebar list left
    // state.plan null while planId was set, and renderOverview dereferenced
    // it. Reachable in the app when a plan is opened by id, or right after
    // creating one.
    //
    // The plan must be fetchable by id but ABSENT from the list - it belongs
    // to another character here, so getAll filters it out while get() still
    // returns it.
    const elsewhere = {
      planId: 'plan-elsewhere',
      characterId: 96061222,
      planName: 'Made Elsewhere',
      status: 'active',
      description: 'From another character',
      createdAt: 1,
    };
    state.plans.push(elsewhere);

    const container = document.createElement('div');
    document.body.appendChild(container);
    await state.registered.def.mount(container, { planId: 'plan-elsewhere' }, makeCtx());
    await settle(40);

    expect(state.calls.some((c) => c.fn === 'plans.get' && c.planId === 'plan-elsewhere')).toBe(true);
    // ...and it renders rather than showing an empty pane.
    expect(container.querySelector('#plan-detail').hidden).toBe(false);
    expect(container.querySelector('#plan-name').textContent).toBe('Made Elsewhere');
  });

  test('a plan that no longer exists clears the selection instead of half-rendering', async () => {
    // The renderer warns rather than errors here - a deleted plan is a normal
    // state, not a fault - so no allowErrors is needed.
    const container = document.createElement('div');
    document.body.appendChild(container);
    await state.registered.def.mount(container, { planId: 'plan-deleted' }, makeCtx());
    await settle(40);

    // No detail pane, no crash.
    expect(container.querySelector('#plan-detail').hidden).toBe(true);
    expect(container.querySelector('#no-plan-selected').hidden).toBe(false);
  });

  test('Escape closes an open modal', async () => {
    await mountView();
    await settle();
    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.getElementById('mp-create-modal').hidden).toBe(true);
  });

  test('clicking the backdrop closes the modal', async () => {
    await mountView();
    await settle();
    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));

    const modal = document.getElementById('mp-create-modal');
    modal.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(modal.hidden).toBe(true);
  });

  test('clicking INSIDE the modal does not close it', async () => {
    await mountView();
    await settle();
    document.getElementById('mp-new-plan').dispatchEvent(new window.MouseEvent('click'));

    document
      .querySelector('#mp-create-modal .modal-content')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(document.getElementById('mp-create-modal').hidden).toBe(false);
  });

  test('Add Cost rejects a zero amount rather than writing it', async () => {
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-add-cost').dispatchEvent(new window.MouseEvent('click'));
    document.getElementById('mp-cost-amount').value = '0';
    document.getElementById('mp-cost-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(state.calls.some((c) => c.fn === 'plans.addLedgerCost')).toBe(false);
    expect(state.calls.some((c) => c.fn === 'toast' && c.type === 'warning')).toBe(true);
  });

  test('Add Cost sends category, amount and note', async () => {
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-add-cost').dispatchEvent(new window.MouseEvent('click'));
    document.getElementById('mp-cost-category').value = 'shipping';
    document.getElementById('mp-cost-amount').value = '1500';
    document.getElementById('mp-cost-note').value = 'courier';
    document.getElementById('mp-cost-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.addLedgerCost');
    expect(call.options).toEqual({ category: 'shipping', amount: 1500, note: 'courier' });
  });

  test('the cost category list matches what the backend buckets', async () => {
    // 'shipping' is not in the backend's explicit list but IS bucketed into
    // "other" - dropping it would remove a working category.
    await mountView();
    await settle();

    const values = Array.from(document.getElementById('mp-cost-category').options)
      .map((o) => o.value);
    expect(values).toEqual(['other', 'shipping', 'broker_fee', 'sales_tax']);
  });

  test('Acquire Item lists only THIS plan\'s materials', async () => {
    // Acquiring something the plan does not need is meaningless, so the list
    // is the plan's materials rather than a global item search.
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-acquire-item').dispatchEvent(new window.MouseEvent('click'));
    document
      .querySelector('#mp-acquire-host .qf-ss-trigger')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const labels = Array.from(document.querySelectorAll('.qf-ss-row')).map((r) => r.textContent);
    expect(labels.some((l) => l.includes('Tritanium'))).toBe(true);
    expect(labels.some((l) => l.includes('Pyerite'))).toBe(true);
  });

  test('Acquire requires a material selection', async () => {
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-acquire-item').dispatchEvent(new window.MouseEvent('click'));
    document.getElementById('mp-acquire-quantity').value = '10';
    document.getElementById('mp-acquire-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(state.calls.some((c) => c.fn === 'plans.addItemAcquisition')).toBe(false);
  });

  test('an omitted unit price is sent as null, not 0', async () => {
    // 0 would mean "acquired for free"; null means "use the locked price".
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-acquire-item').dispatchEvent(new window.MouseEvent('click'));
    document
      .querySelector('#mp-acquire-host .qf-ss-trigger')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();
    document
      .querySelectorAll('.qf-ss-row')[0]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    document.getElementById('mp-acquire-quantity').value = '100';
    document.getElementById('mp-acquire-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.addItemAcquisition');
    expect(call.options.unitPrice).toBeNull();
    expect(call.options.quantity).toBe(100);
  });

  test('a backend rejection is surfaced verbatim', async () => {
    // The backend caps acquisition at what is still needed; that message is
    // more useful than a generic failure.
    allowErrors(/acquire failed/);
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-acquire-item').dispatchEvent(new window.MouseEvent('click'));
    document
      .querySelector('#mp-acquire-host .qf-ss-trigger')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();
    document
      .querySelectorAll('.qf-ss-row')[0]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    document.getElementById('mp-acquire-quantity').value = '999999';
    document.getElementById('mp-acquire-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const errorToast = state.calls.find((c) => c.fn === 'toast' && c.type === 'error');
    expect(errorToast.message).toContain('Exceeds still needed');
  });

  test('Add Blueprint searches asynchronously and sends the config', async () => {
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="blueprints"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('add-blueprint-btn').dispatchEvent(new window.MouseEvent('click'));

    const input = document.querySelector('#mp-blueprint-host .qf-ss-trigger');
    input.dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const search = document.querySelector('.qf-ss-input');
    search.value = 'Hulk';
    search.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 320));
    await settle();

    document
      .querySelectorAll('.qf-ss-row')[0]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    document.getElementById('mp-blueprint-runs').value = '5';
    document.getElementById('mp-blueprint-me').value = '10';
    document.getElementById('mp-blueprint-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.addBlueprint');
    expect(call.config.blueprintTypeId).toBe(22546);
    expect(call.config.runs).toBe(5);
    expect(call.config.meLevel).toBe(10);
  });

  test('the Production Lines input reaches the handler as `lines`', async () => {
    // It was sent as `productionLines`, which addBlueprintToPlan does not
    // destructure - so the input silently did nothing and every blueprint
    // went in on a single line.
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="blueprints"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('add-blueprint-btn').dispatchEvent(new window.MouseEvent('click'));

    const trigger = document.querySelector('#mp-blueprint-host .qf-ss-trigger');
    trigger.dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const search = document.querySelector('.qf-ss-input');
    search.value = 'Hulk';
    search.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 320));
    await settle();

    document
      .querySelectorAll('.qf-ss-row')[0]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    document.getElementById('mp-blueprint-runs').value = '5';
    document.getElementById('mp-blueprint-lines').value = '3';
    document.getElementById('mp-blueprint-confirm')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.addBlueprint');
    expect(call.config.lines).toBe(3);
    expect(call.config.productionLines).toBeUndefined();
  });

  describe('Add Blueprint defaults', () => {
    async function pickBlueprint() {
      await mountWithPlan();
      document
        .querySelector('.tab-button[data-tab="blueprints"]')
        .dispatchEvent(new window.MouseEvent('click'));
      await settle(20);

      document.getElementById('add-blueprint-btn').dispatchEvent(new window.MouseEvent('click'));
      document
        .querySelector('#mp-blueprint-host .qf-ss-trigger')
        .dispatchEvent(new window.MouseEvent('click'));
      await settle();

      const search = document.querySelector('.qf-ss-input');
      search.value = 'Hulk';
      search.dispatchEvent(new window.Event('input'));
      await new Promise((r) => setTimeout(r, 320));
      await settle();

      document
        .querySelectorAll('.qf-ss-row')[0]
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await settle(30);
    }

    test('seeds ME/TE from the best OWNED blueprint', async () => {
      // Defaulting to 0 when the user owns an ME 10 copy would overstate the
      // plan's material cost from the moment it is created.
      await pickBlueprint();

      expect(document.getElementById('mp-blueprint-me').value).toBe('10');
      expect(document.getElementById('mp-blueprint-te').value).toBe('20');
    });

    test('says where the seeded values came from', async () => {
      await pickBlueprint();

      const note = document.getElementById('mp-blueprint-owned-note');
      expect(note.hidden).toBe(false);
      expect(note.textContent).toContain('BPO');
    });

    test('distinguishes a BPC from a BPO', async () => {
      state.ownedBlueprint = { me: 4, te: 8, isCopy: true, isCorporation: false };
      await pickBlueprint();

      expect(document.getElementById('mp-blueprint-owned-note').textContent).toContain('BPC');
    });

    test('an unowned blueprint defaults to 0 and says so', async () => {
      state.ownedBlueprint = null;
      await pickBlueprint();

      expect(document.getElementById('mp-blueprint-me').value).toBe('0');
      expect(document.getElementById('mp-blueprint-owned-note').textContent)
        .toContain('do not own');
    });

    test('shows runs per line when the job is split', async () => {
      // 30 runs over 3 lines is 10 each - that is what governs the schedule.
      await pickBlueprint();

      document.getElementById('mp-blueprint-runs').value = '30';
      document.getElementById('mp-blueprint-lines').value = '3';
      document.getElementById('mp-blueprint-lines').dispatchEvent(new window.Event('input'));

      const note = document.getElementById('mp-blueprint-runs-note');
      expect(note.hidden).toBe(false);
      expect(note.textContent).toContain('10 runs per line');
    });

    test('hides runs-per-line for a single line', async () => {
      await pickBlueprint();

      document.getElementById('mp-blueprint-runs').value = '30';
      document.getElementById('mp-blueprint-lines').value = '1';
      document.getElementById('mp-blueprint-lines').dispatchEvent(new window.Event('input'));

      expect(document.getElementById('mp-blueprint-runs-note').hidden).toBe(true);
    });
  });

  test('closing a modal destroys its dropdown', async () => {
    // A QFSearchSelect owns a document listener and a body-mounted popover, so
    // hiding the modal is not enough.
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    document.getElementById('mp-acquire-item').dispatchEvent(new window.MouseEvent('click'));
    await settle();

    const spy = jest.spyOn(document, 'removeEventListener');
    document
      .querySelector('#mp-acquire-modal [data-mp-close]')
      .dispatchEvent(new window.MouseEvent('click'));

    expect(spy).toHaveBeenCalledWith('mousedown', expect.any(Function), true);
    spy.mockRestore();
  });

  test('switching plans closes any open modal', async () => {
    // A modal left open would submit against the NEW plan while showing the
    // old one's data.
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="ledger"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    document.getElementById('mp-add-cost').dispatchEvent(new window.MouseEvent('click'));
    expect(document.getElementById('mp-cost-modal').hidden).toBe(false);

    document.querySelectorAll('.mp-plan-card')[1].dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(document.getElementById('mp-cost-modal').hidden).toBe(true);
  });
});

describe('lifecycle', () => {
  test('mount subscribes exactly once', async () => {
    await mountView();
    await settle();

    expect(state.subscribers['default-character-changed']).toHaveLength(1);
  });

  test('unmount disposes subscriptions', async () => {
    const { ctx } = await mountView();
    await settle();

    ctx.dispose();

    expect(state.disposed['default-character-changed']).toBe(1);
    expect(state.subscribers['default-character-changed']).toHaveLength(0);
  });

  test('changing the default character closes the open plan', async () => {
    // The open plan belongs to the OLD character and may not exist for the
    // new one - leaving it up showed one character's plan while the rest of
    // the view described another.
    await mountWithPlan();
    expect(document.getElementById('plan-detail').hidden).toBe(false);

    state.subscribers['default-character-changed'].forEach((cb) => cb());
    await settle(40);

    expect(document.getElementById('plan-detail').hidden).toBe(true);
    expect(document.getElementById('no-plan-selected').hidden).toBe(false);
  });

  test('the cleared plan leaves no tab data behind', async () => {
    // Clearing only planId left every tab holding the old plan's materials,
    // jobs and ledger behind an empty detail pane.
    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="materials"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);
    expect(document.querySelectorAll('#mp-materials-body .mp-materials-row').length)
      .toBeGreaterThan(0);

    state.subscribers['default-character-changed'].forEach((cb) => cb());
    await settle(40);

    expect(document.querySelectorAll('#mp-materials-body .mp-materials-row'))
      .toHaveLength(0);
  });

  test('picking a character in the view also closes the open plan', async () => {
    await mountWithPlan();

    const trigger = document.querySelector('#mp-character-host .qf-ss-trigger');
    trigger.dispatchEvent(new window.MouseEvent('click'));
    await settle();
    document
      .querySelectorAll('.qf-ss-row')[1]
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle(40);

    expect(document.getElementById('plan-detail').hidden).toBe(true);
  });

  test('changing the default character leaves ONE character dropdown', async () => {
    // initCharacters re-runs on that event, and a bare `new QFSearchSelect`
    // APPENDS - so the user got a second dropdown stacked on the first, with
    // the old instance still holding a document listener and a popover.
    await mountView();
    await settle(30);
    expect(document.querySelectorAll('#mp-character-host .qf-ss-trigger')).toHaveLength(1);

    state.subscribers['default-character-changed'].forEach((cb) => cb());
    await settle(40);

    expect(document.querySelectorAll('#mp-character-host .qf-ss-trigger')).toHaveLength(1);
  });

  test('the replaced dropdown is destroyed, not just detached', async () => {
    // A leaked instance keeps listening on document and can leave an
    // orphaned popover attached to <body>.
    const { ctx } = await mountView();
    await settle(30);

    state.subscribers['default-character-changed'].forEach((cb) => cb());
    await settle(40);

    ctx.dispose();
    // Nothing of the component survives the view.
    expect(document.querySelectorAll('.qf-ss-popover')).toHaveLength(0);
  });

  test('remounting leaves exactly one live subscription', async () => {
    const first = await mountView();
    await settle();
    first.ctx.dispose();

    document.body.innerHTML = '';
    const second = await mountView();
    await settle();

    expect(state.subscribers['default-character-changed']).toHaveLength(1);
    second.ctx.dispose();
  });

  test('destroy tears down the QFSearchSelect instances', async () => {
    const { instance } = await mountView();
    await settle();

    const spy = jest.spyOn(document, 'removeEventListener');
    instance.destroy();

    expect(spy).toHaveBeenCalledWith('mousedown', expect.any(Function), true);
    spy.mockRestore();
  });
});

describe('resilience', () => {
  test('a failing drift load still renders the plan', async () => {
    allowErrors(/load failed: material drift/);
    window.electronAPI.plans.getMaterialDrift = async () => {
      throw new Error('market exploded');
    };

    await mountWithPlan();

    // Locked data is what matters; drift is a bonus.
    expect(document.getElementById('mp-stat-material-cost').textContent).toContain('100,000');
    expect(document.getElementById('mp-drift-banner').hidden).toBe(true);
  });

  test('a failing summary does not blank the materials tab', async () => {
    allowErrors(/load failed: summary/);
    window.electronAPI.plans.getSummary = async () => {
      throw new Error('summary exploded');
    };

    await mountWithPlan();
    document
      .querySelector('.tab-button[data-tab="materials"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle();

    expect(document.querySelectorAll('#mp-materials-body .mp-materials-row')).toHaveLength(3);
  });

  test('a plan with no materials renders an empty state', async () => {
    state.materials = [];
    await mountWithPlan();

    expect(document.getElementById('mp-total-locked').textContent).toBe('—');
  });
});
