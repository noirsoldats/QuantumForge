/**
 * @jest-environment jsdom
 *
 * Manufacturing Plans - the Blueprints, Reactions and material-tree tabs.
 *
 * Split out of the original single Plans suite; the shared fake backend and
 * mount helpers live in ./helpers/plans-harness.
 */

const h = require('./helpers/plans-harness');

h.installHooks();

const { state, mountWithPlan, openTab, settle, allowErrors } = h;

describe('blueprints, reactions and tree tabs', () => {
  test('the reactions tab is hidden when the plan has none', async () => {
    state.planReactions = [];
    await mountWithPlan();

    expect(document.getElementById('reactions-tab-button').hidden).toBe(true);
  });

  test('the reactions tab appears when the plan has reactions', async () => {
    await mountWithPlan();

    expect(document.getElementById('reactions-tab-button').hidden).toBe(false);
  });

  test('the blueprints tab lists the plan blueprints with full detail', async () => {
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-1"]');
    expect(row.textContent).toContain('Hulk Blueprint');
    expect(row.textContent).toContain('10');            // ME
    expect(row.textContent).toContain('20');            // TE
    expect(row.textContent).toContain('Jita Raitaru');  // facility snapshot
    expect(row.textContent).not.toMatch(/Type \d+/);
  });

  test('excludes reactions - they have their own tab', async () => {
    // Listed here they rendered as blueprint rows with empty ME/TE, which
    // reactions do not have at all.
    state.planBlueprints.push({
      ...state.planBlueprints[0],
      planBlueprintId: 'pbp-rx',
      parentBlueprintId: null,
      blueprintTypeId: 46186,
      blueprintType: 'reaction',
    });
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-blueprint-id="pbp-rx"]')).toBeNull();
  });

  test('drops a reaction\'s children with it, rather than orphaning them', async () => {
    // flattenBlueprintTree promotes parentless rows to roots, so a plain
    // filter would make a reaction's inputs reappear detached at top level.
    state.planBlueprints.push(
      {
        ...state.planBlueprints[0],
        planBlueprintId: 'pbp-rx',
        parentBlueprintId: null,
        blueprintTypeId: 46186,
        blueprintType: 'reaction',
      },
      {
        ...state.planBlueprints[1],
        planBlueprintId: 'pbp-rx-child',
        parentBlueprintId: 'pbp-rx',
        blueprintType: 'manufacturing',
      }
    );
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-blueprint-id="pbp-rx-child"]')).toBeNull();
    // The real blueprints are untouched.
    expect(document.querySelectorAll('#blueprints-container .mp-bp-row[data-mp-blueprint-id]'))
      .toHaveLength(2);
  });

  test('has no Product column - the blueprint name already says what', async () => {
    // It only cost width on a table that cannot spare it.
    await openTab('blueprints');

    const header = document.querySelector('#blueprints-container .mp-build-header');
    expect(header.textContent).not.toContain('Product');
    expect(header.textContent).toContain('Blueprint');
  });

  test('reports how many units a row produces, as name subtext', async () => {
    // runs x output-per-run: 4 runs of a blueprint making 1 each.
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-1"]');
    expect(row.querySelector('.mp-bp-produces').textContent).toBe('Produces 4x');
  });

  test('multiplies runs by the per-run output', async () => {
    // 12 runs producing 100 each is 1,200 units - the number that matters,
    // and the one the run count alone never showed.
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-child"]');
    expect(row.querySelector('.mp-bp-produces').textContent).toBe('Produces 1,200x');
  });

  test('omits the subtext when the SDE gave no per-run output', async () => {
    // "Produces 4x" for a blueprint that makes 100 per run is worse than
    // saying nothing.
    state.planBlueprints[0].productQuantityPerRun = null;
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-1"]');
    expect(row.querySelector('.mp-bp-produces')).toBeNull();
  });

  test('the blueprints tab shows the WHOLE tree, intermediates included', async () => {
    // Intermediates are what Mark Built applies to, so hiding them put the
    // progress affordance somewhere the user could not reach it.
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-blueprint-id="pbp-child"]')).not.toBeNull();
    expect(document.querySelectorAll('#blueprints-container .mp-bp-row[data-mp-blueprint-id]'))
      .toHaveLength(2);
  });

  test('a child renders after its parent, indented', async () => {
    await openTab('blueprints');

    const rows = Array.from(
      document.querySelectorAll('#blueprints-container .mp-bp-row[data-mp-blueprint-id]')
    );
    expect(rows.map((r) => r.getAttribute('data-mp-blueprint-id')))
      .toEqual(['pbp-1', 'pbp-child']);

    // Depth drives the indent; the parent sets no depth at all.
    expect(rows[0].style.getPropertyValue('--mp-depth')).toBe('');
    expect(rows[1].style.getPropertyValue('--mp-depth')).toBe('1');
  });

  test('a row without a facility snapshot resolves the live facility', async () => {
    // Same bug as the reactions card: facilities loaded only on the Build
    // List, so an un-snapshotted row read "Unknown facility" before then.
    await openTab('blueprints');

    const row = document.querySelector('[data-mp-blueprint-id="pbp-child"]');
    expect(row.textContent).toContain('Amarr Azbel');
    expect(row.textContent).not.toContain('Unknown facility');
  });

  test('an intermediate whose parent is missing still renders', async () => {
    // A broken parent link must not swallow the row and everything under it.
    state.planBlueprints[1].parentBlueprintId = 'pbp-does-not-exist';
    await openTab('blueprints');

    expect(document.querySelector('[data-mp-blueprint-id="pbp-child"]')).not.toBeNull();
  });

  test('reactions render from reactionTypeId, not blueprintTypeId', async () => {
    // Reactions use a DIFFERENT id field; reading blueprintTypeId gave
    // undefined and rendered "Type undefined".
    await openTab('reactions');

    const card = document.querySelector('[data-mp-reaction-id="pbp-2"]');
    expect(card.textContent).toContain('Fullerene');
    expect(card.textContent).not.toMatch(/Type (\d+|undefined)/);
  });

  test('the tree renders nested children indented, with full columns', async () => {
    await openTab('blueprint-tree');

    const rows = document.querySelectorAll(
      '#blueprint-tree-container .mp-tree-grid[data-mp-tree-type]'
    );
    const nameLines = document.querySelectorAll(
      '#blueprint-tree-container .mp-tree-name-line'
    );
    expect(rows).toHaveLength(2);
    expect(nameLines).toHaveLength(2);
    expect(nameLines[0].textContent).toContain('Hulk');
    expect(nameLines[1].textContent).toContain('Tritanium');

    // The tree uses quantityNeeded and priceEach - the opposite of the
    // materials list - so a wrong field name shows up as a blank column.
    expect(rows[1].textContent).toContain('1,000');   // quantityNeeded
    expect(rows[1].textContent).toContain('5.00');    // priceEach

    // The child's NAME is indented further than its parent's.
    const indent = (line) => parseInt(line.style.paddingLeft, 10);
    expect(indent(nameLines[1])).toBeGreaterThan(indent(nameLines[0]));
  });

  test('the name is decoupled from its data row', async () => {
    // Indentation used to come out of the Item column's own width, so the
    // deeper a node the more of its name was cut off - unusable on a
    // capital-ship tree. The name now has its own full-width line, and the
    // figures below it start at a fixed offset regardless of depth.
    await openTab('blueprint-tree');

    const rows = document.querySelectorAll(
      '#blueprint-tree-container .mp-tree-grid[data-mp-tree-type]'
    );
    // No name in the data row at all...
    expect(rows[1].textContent).not.toContain('Tritanium');
    // ...and depth does not shift the figures.
    expect(rows[0].style.paddingLeft).toBe('');
    expect(rows[1].style.paddingLeft).toBe('');
  });

  test('each name line pairs with the row beneath it', async () => {
    await openTab('blueprint-tree');

    const body = document.querySelector('#blueprint-tree-container .mp-tree-body');
    const kids = Array.from(body.children).filter(
      (n) => n.classList.contains('mp-tree-name-line')
        || n.classList.contains('mp-tree-grid')
    );
    // header, then name/row for each of the two nodes.
    expect(kids[0].classList.contains('mp-build-header')).toBe(true);
    expect(kids[1].getAttribute('data-mp-tree-name')).toBe(kids[2].getAttribute('data-mp-tree-key'));
    expect(kids[3].getAttribute('data-mp-tree-name')).toBe(kids[4].getAttribute('data-mp-tree-key'));
  });

  test('tabs load their data only when opened', async () => {
    await mountWithPlan();
    expect(state.calls.some((c) => c.fn === 'plans.getBuildItems')).toBe(false);

    document
      .querySelector('.tab-button[data-tab="build-list"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'plans.getBuildItems')).toBe(true);
  });
});

describe('blueprint tree', () => {
  const rows = () => document.querySelectorAll(
    '#blueprint-tree-container .mp-tree-grid[data-mp-tree-type]'
  );

  test('has the full column set', async () => {
    await openTab('blueprint-tree');

    const header = document.querySelector('#blueprint-tree-container .mp-build-header');
    ['Quantity', 'Runs', 'ME', 'Source', 'Price/ea', 'Total', 'Type']
      .forEach((label) => expect(header.textContent).toContain(label));
    // No Item column - the name is its own line above each row.
    expect(header.textContent).not.toContain('Item');
  });

  test('shows runs needed and the source of each node', async () => {
    await openTab('blueprint-tree');

    expect(rows()[0].textContent).toContain('4');              // runsNeeded
    expect(rows()[0].querySelector('.mp-plan-badge')).not.toBeNull();
    // A node with no build plan is bought, not built.
    expect(rows()[1].textContent).toContain('Market');
  });

  test('classifies each node by type', async () => {
    await openTab('blueprint-tree');

    expect(rows()[0].querySelector('.mp-node-badge').textContent).toBe('Built');
    expect(rows()[1].querySelector('.mp-node-badge').textContent).toBe('Raw');
  });

  test('extends the line total, not just the unit price', async () => {
    await openTab('blueprint-tree');

    // 1,000 Tritanium at 5.00 each.
    expect(rows()[1].textContent).toContain('5,000.00');
  });

  test('a node with children can be collapsed, hiding them', async () => {
    await openTab('blueprint-tree');
    expect(rows()).toHaveLength(2);

    document
      .querySelector('[data-mp-tree-toggle]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);

    expect(rows()).toHaveLength(1);
    // The child's NAME goes with it - the two are separate elements now, so
    // hiding only one would leave an orphan.
    expect(document.querySelectorAll('#blueprint-tree-container .mp-tree-name-line'))
      .toHaveLength(1);
    expect(document.querySelector('[data-mp-tree-toggle]').getAttribute('aria-expanded'))
      .toBe('false');
  });

  test('a leaf offers no collapse control', async () => {
    await openTab('blueprint-tree');

    // The caret lives on the name line, alongside the name it expands.
    const nameLines = document.querySelectorAll(
      '#blueprint-tree-container .mp-tree-name-line'
    );
    expect(nameLines[0].querySelector('[data-mp-tree-toggle]')).not.toBeNull();
    expect(nameLines[1].querySelector('[data-mp-tree-toggle]')).toBeNull();
  });

  test('Collapse all then Expand all round-trips', async () => {
    await openTab('blueprint-tree');

    document
      .querySelector('[data-mp-tree-collapse-all]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    expect(rows()).toHaveLength(1);

    document
      .querySelector('[data-mp-tree-expand-all]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    expect(rows()).toHaveLength(2);
  });

  test('a "buy" node does not list itself as its own input', async () => {
    // Setting a node to Buy pushes a material leaf of the SAME type beneath
    // it, because getPlanMaterials only reads node_type 'material' rows and
    // the item would otherwise vanish from the shopping list. That echo is a
    // storage detail - on the tree it reads as the item being its own input.
    state.materialTree[0].buildPlan = 'buy';
    state.materialTree[0].children = [
      {
        nodeId: 'n-echo',
        typeId: 22544,               // same type as its parent
        typeName: 'Hulk',
        nodeType: 'material',
        depth: 1,
        quantityNeeded: 4,
        runsNeeded: null,
        meLevel: null,
        isReaction: false,
        buildPlan: 'buy',
        priceEach: 250_000_000,
        acquiredQuantity: 0,
        sourcePlanBlueprintId: null,
        children: [],
      },
    ];
    await openTab('blueprint-tree');

    expect(rows()).toHaveLength(1);
    expect(document.querySelectorAll('#blueprint-tree-container .mp-tree-name-line'))
      .toHaveLength(1);
  });

  test('a "buy" node with the echo hidden offers no expand control', async () => {
    state.materialTree[0].buildPlan = 'buy';
    state.materialTree[0].children = [
      {
        nodeId: 'n-echo',
        typeId: 22544,
        typeName: 'Hulk',
        nodeType: 'material',
        depth: 1,
        quantityNeeded: 4,
        isReaction: false,
        buildPlan: 'buy',
        priceEach: 0,
        sourcePlanBlueprintId: null,
        children: [],
      },
    ];
    await openTab('blueprint-tree');

    // Nothing left to expand once its only child is its own echo.
    expect(document.querySelector('[data-mp-tree-toggle]')).toBeNull();
  });

  test('a "buy" node keeps children of a DIFFERENT type', async () => {
    // Only the same-type echo is hidden; real inputs still belong.
    state.materialTree[0].buildPlan = 'buy';
    await openTab('blueprint-tree');

    expect(rows()).toHaveLength(2);
    expect(document.querySelectorAll('#blueprint-tree-container .mp-tree-name-line')[1]
      .textContent).toContain('Tritanium');
  });

  test('only a node with a producer offers Details', async () => {
    // A raw material bought from the market has nothing behind it to expand.
    await openTab('blueprint-tree');

    expect(rows()[0].querySelector('[data-mp-tree-detail]')).not.toBeNull();
    expect(rows()[1].querySelector('[data-mp-tree-detail]')).toBeNull();
  });

  test('Details fetches against the node\'s own producer', async () => {
    await openTab('blueprint-tree');
    document
      .querySelector('[data-mp-tree-detail]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.getMaterialTreeNodeDetail');
    expect(call.planBlueprintId).toBe('pbp-1');
  });

  test('the detail panel shows stats and direct inputs', async () => {
    await openTab('blueprint-tree');
    document
      .querySelector('[data-mp-tree-detail]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const panel = document.querySelector('[data-mp-tree-detail-panel]');
    expect(panel.textContent).toContain('10');           // ME
    expect(panel.textContent).toContain('20');           // TE
    expect(panel.textContent).toContain('2h 2m');        // time, from seconds
    expect(panel.textContent).toContain('1,500,000.00'); // job cost
    expect(panel.textContent).toContain('Direct Material Inputs');
    expect(panel.querySelectorAll('[data-mp-detail-material]')).toHaveLength(2);
  });

  test('a reaction node shows no ME/TE rather than 0', async () => {
    // Reactions have no ME/TE at all; rendering 0 would imply they do.
    state.treeNodeDetail = { ...state.treeNodeDetail, blueprintType: 'reaction' };
    await openTab('blueprint-tree');
    document
      .querySelector('[data-mp-tree-detail]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const labels = Array.from(
      document.querySelectorAll('[data-mp-tree-detail-panel] .mp-reaction-stat-label')
    ).map((n) => n.textContent);
    expect(labels).not.toContain('ME');
    expect(labels).not.toContain('TE');
    expect(labels).toContain('Runs');
  });

  test('Details toggles closed again', async () => {
    await openTab('blueprint-tree');
    const btn = () => document.querySelector('[data-mp-tree-detail]');

    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(30);
    expect(btn().textContent).toBe('Hide');

    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    expect(document.querySelector('[data-mp-tree-detail-panel]')).toBeNull();
  });

  test('the detail is fetched once, then reused', async () => {
    await openTab('blueprint-tree');
    const btn = () => document.querySelector('[data-mp-tree-detail]');

    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(30);
    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.filter((c) => c.fn === 'plans.getMaterialTreeNodeDetail'))
      .toHaveLength(1);
  });

  test('a node with no detail says so rather than spinning', async () => {
    state.treeNodeDetail = null;
    await openTab('blueprint-tree');
    const btn = () => document.querySelector('[data-mp-tree-detail]');

    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(document.querySelector('[data-mp-tree-detail-panel]').textContent)
      .toContain('No details available');

    // "Fetched, nothing there" is a RESULT, not a miss - reopening must not
    // re-run the calculation.
    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(20);
    btn().dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.filter((c) => c.fn === 'plans.getMaterialTreeNodeDetail'))
      .toHaveLength(1);
  });
});

describe('reactions tab', () => {
  test('shows only PRIMARY reactions, not sub-reactions', async () => {
    // A sub-reaction already appears inside its parent's input tree, so a
    // card of its own would list the same chain twice.
    state.planReactions.push({
      ...state.planReactions[0],
      planBlueprintId: 'pbp-sub',
      reactionTypeId: 46184,
      intermediateProductTypeId: 46183,
      isTopLevel: false,
    });
    await openTab('reactions');

    expect(document.querySelectorAll('#reactions-container .mp-reaction-card'))
      .toHaveLength(1);
    expect(document.querySelector('[data-mp-reaction-id="pbp-sub"]')).toBeNull();
  });

  test('a reaction with no isTopLevel flag is treated as primary', async () => {
    // Better a duplicate card than a silently missing one on absent data.
    delete state.planReactions[0].isTopLevel;
    await openTab('reactions');

    expect(document.querySelectorAll('#reactions-container .mp-reaction-card'))
      .toHaveLength(1);
  });

  test('renders a card per reaction, not table rows', async () => {
    // Each reaction is a CHAIN with its own inputs; a flat table could not
    // show what feeds what.
    await openTab('reactions');

    expect(document.querySelectorAll('#reactions-container .mp-reaction-card'))
      .toHaveLength(1);
  });

  test('the card titles the PRODUCT, not the reaction blueprint', async () => {
    await openTab('reactions');

    const title = document.querySelector('.mp-reaction-title').textContent;
    expect(title).toContain('Fullerene');
    expect(title).not.toContain('Fullerene Reaction');
  });

  test('shows runs, per-run output and total produced', async () => {
    // Total produced is what the plan is really sized by.
    await openTab('reactions');

    const stats = Array.from(document.querySelectorAll('.mp-reaction-stat'))
      .map((s) => s.textContent);
    expect(stats[0]).toContain('Runs');
    expect(stats[0]).toContain('2');
    expect(stats[1]).toContain('200');   // product.baseQuantity
    expect(stats[2]).toContain('400');   // product.quantity
  });

  test('reports facility and build plan as read-only', async () => {
    // They are EDITED on the Build List; saying so stops these reading as
    // broken controls.
    await openTab('reactions');

    const card = document.querySelector('.mp-reaction-card');
    expect(card.textContent).toContain('Amarr Azbel');
    expect(card.querySelector('.mp-plan-badge')).not.toBeNull();
    expect(document.getElementById('reactions-container').textContent)
      .toContain('edited on the Build List');
  });

  test('resolves the facility without visiting the Build List first', async () => {
    // Facilities used to load ONLY on the Build List tab, so every other tab
    // read "Unknown facility" until that tab happened to be opened.
    await openTab('reactions');

    expect(document.querySelector('.mp-reaction-card').textContent)
      .not.toContain('Unknown facility');
  });

  test('renders the input tree nested, deepest indented furthest', async () => {
    await openTab('reactions');

    const nodes = Array.from(document.querySelectorAll('.mp-reaction-node'));
    expect(nodes).toHaveLength(3);

    // A child follows its parent, one level deeper - the nesting comes from
    // `children`, not from a flat depth field.
    expect(nodes[0].textContent).toContain('Fulleroferrocene');
    expect(nodes[0].style.getPropertyValue('--mp-depth')).toBe('0');
    expect(nodes[1].textContent).toContain('Ceramic Powder');
    expect(nodes[1].style.getPropertyValue('--mp-depth')).toBe('1');
    expect(nodes[2].textContent).toContain('Vanadium');
    expect(nodes[2].style.getPropertyValue('--mp-depth')).toBe('0');
  });

  test('classifies each node by role', async () => {
    await openTab('reactions');

    const role = (i) => document.querySelectorAll('.mp-reaction-node')[i]
      .getAttribute('data-mp-node-role');
    expect(role(0)).toBe('intermediate');   // isIntermediate
    expect(role(1)).toBe('raw');            // neither flag
    expect(role(2)).toBe('manufactured');   // isManufactured
  });

  test('shows runs needed only for nodes that are produced', async () => {
    await openTab('reactions');

    const nodes = document.querySelectorAll('.mp-reaction-node');
    expect(nodes[0].textContent).toContain('9 runs');
    expect(nodes[1].textContent).not.toMatch(/\d+ runs?/);
  });

  test('flags only non-default sourcing', async () => {
    // "raw_materials" is what every node does unless told otherwise, so
    // chipping it everywhere would be noise.
    await openTab('reactions');

    const nodes = document.querySelectorAll('.mp-reaction-node');
    expect(nodes[0].querySelector('.mp-node-sourcing .mp-plan-badge')).toBeNull();
    expect(nodes[2].querySelector('.mp-node-sourcing .mp-plan-badge')).not.toBeNull();
  });

  test('shows the quantity each node contributes', async () => {
    await openTab('reactions');

    expect(document.querySelectorAll('.mp-reaction-node')[1].textContent)
      .toContain('12,000');
  });

  test('the tree is fetched only when the tab is opened', async () => {
    // It is one full material calculation per reaction, and the reaction rows
    // themselves load on every plan open just to decide tab visibility.
    await mountWithPlan();
    expect(state.calls.some((c) => c.fn === 'plans.calculateReactionTree')).toBe(false);

    document
      .querySelector('.tab-button[data-tab="reactions"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.some((c) => c.fn === 'plans.calculateReactionTree')).toBe(true);
  });

  test('the tree is calculated against the reaction\'s own runs and facility', async () => {
    await openTab('reactions');

    const call = state.calls.find((c) => c.fn === 'plans.calculateReactionTree');
    expect(call.planBlueprintId).toBe('pbp-2');
    expect(call.runs).toBe(2);
    expect(call.facility).toBe('fac-2');
  });

  test('a failed tree calculation still renders the card', async () => {
    // The header is real plan data; losing the inputs must not take it out.
    window.electronAPI.plans.calculateReactionTree = async () => {
      throw new Error('SDE unavailable');
    };
    allowErrors(/reaction tree/);
    await openTab('reactions');

    const card = document.querySelector('.mp-reaction-card');
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Fullerene');
    expect(card.querySelectorAll('.mp-reaction-node')).toHaveLength(0);
  });

  test('reactions offer Mark Built and route to markReactionBuilt', async () => {
    await openTab('reactions');
    document
      .querySelector('[data-mp-mark-built="pbp-2"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    document.getElementById('mp-built-runs').value = '1';
    document.getElementById('mp-built-confirm').dispatchEvent(new window.MouseEvent('click'));
    await settle(40);

    expect(state.calls.some((c) => c.fn === 'plans.markReactionBuilt')).toBe(true);
    expect(state.calls.some((c) => c.fn === 'plans.markIntermediateBuilt')).toBe(false);
  });

  test('a partially built reaction is badged on its card', async () => {
    state.planReactions[0].builtRuns = 1;
    await openTab('reactions');

    const badge = document.querySelector('[data-mp-built-badge="pbp-2"]');
    expect(badge.textContent).toBe('1/2 Built (50%)');
  });
});

