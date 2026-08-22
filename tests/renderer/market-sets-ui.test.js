/**
 * @jest-environment jsdom
 *
 * Market Manager - market sets: the editor, its scope controls, the overview
 * cards, and what changing the active set re-renders.
 *
 * Split out of the original single market suite; the shared fake backend and
 * mount helpers live in ./helpers/market-harness.
 */

// The Source-column test asserts against the stylesheet text, because jsdom
// does no layout and cannot observe the grid track stretching.
const fs = require('fs');
const path = require('path');

const h = require('./helpers/market-harness');

h.installHooks();

const { state, mount, flush, pickTradeHub } = h;

describe('market set editor', () => {
  test('opens prefilled when editing an existing set', async () => {
    await mount();
    switchToOverview();

    document.querySelector('#mk-set-cards .mk-set-edit').click();
    await flush();

    expect(document.getElementById('mk-set-modal-title').textContent).toBe('Edit Market Set');
    expect(document.getElementById('mk-set-name').value).toBe('Jita 4-4');
    // Both scopes must be built, identically.
    expect(document.querySelectorAll('#mk-scope-input .mk-field').length).toBeGreaterThan(3);
    expect(document.querySelectorAll('#mk-scope-output .mk-field').length).toBeGreaterThan(3);
  });

  test('location type is five radio cards per scope, per the mockup', async () => {
    await mount();
    switchToOverview();
    document.querySelector('#mk-set-cards .mk-set-edit').click();
    await flush();

    const cards = document.querySelectorAll('#mk-scope-input .mk-loc-card');
    expect(cards).toHaveLength(5);

    const labels = [...cards].map((c) => c.querySelector('.mk-loc-name').textContent);
    expect(labels).toEqual([
      'Trade Hub',
      'Specific Station',
      'Solar System',
      'Entire Region',
      'Private Structure',
    ]);
    // Each card carries its description.
    expect(cards[0].querySelector('.mk-loc-desc').textContent).toBe('Jita, Amarr, Dodixie, Rens, Hek');
  });

  test('exactly one location card is active, and selecting another swaps it', async () => {
    await mount();
    document.getElementById('mk-new-set').click();
    await flush();

    let on = document.querySelectorAll('#mk-scope-input .mk-loc-card.is-on');
    expect(on).toHaveLength(1);
    expect(on[0].querySelector('.mk-loc-name').textContent).toBe('Trade Hub');

    // Pick "Entire Region" - the previous card must fully deselect (rule 3).
    document.querySelectorAll('#mk-scope-input .mk-loc-card')[3].click();
    await flush();

    on = document.querySelectorAll('#mk-scope-input .mk-loc-card.is-on');
    expect(on).toHaveLength(1);
    expect(on[0].querySelector('.mk-loc-name').textContent).toBe('Entire Region');
  });

  test('the private structure branch shows the ESI scope requirement', async () => {
    await mount();
    document.getElementById('mk-new-set').click();
    await flush();

    document.querySelectorAll('#mk-scope-input .mk-loc-card')[4].click();
    await flush();

    const note = document.querySelector('#mk-scope-input .mk-struct-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toMatch(/esi-search\.search_structures\.v1/);
    expect(note.textContent).toMatch(/esi-markets\.structure_markets\.v1/);
  });

  test('percentile is 0-1 with a 0.05 step, not a percentage', async () => {
    await mount();
    document.getElementById('mk-new-set').click();
    await flush();

    const field = [...document.querySelectorAll('#mk-scope-input .mk-field')]
      .find((f) => f.textContent.includes('Percentile Threshold'));
    const input = field.querySelector('input[type="number"]');
    expect(input.min).toBe('0');
    expect(input.max).toBe('1');
    expect(input.step).toBe('0.05');
    expect(input.value).toBe('0.2');
  });

  test('Delete is offered when editing but not when creating', async () => {
    await mount();

    document.getElementById('mk-new-set').click();
    await flush();
    expect(document.getElementById('mk-set-delete').hidden).toBe(true);

    document.querySelector('[data-mk-close="mk-set-modal"]').click();
    switchToOverview();
    document.querySelector('#mk-set-cards .mk-set-edit').click();
    await flush();
    expect(document.getElementById('mk-set-delete').hidden).toBe(false);
  });

  test('opens blank when creating', async () => {
    await mount();

    document.getElementById('mk-new-set').click();
    await flush();

    expect(document.getElementById('mk-set-modal-title').textContent).toBe('New Market Set');
    expect(document.getElementById('mk-set-name').value).toBe('');
  });

  test('save is blocked until the set has a name and locations', async () => {
    await mount();
    document.getElementById('mk-new-set').click();
    await flush();

    expect(document.getElementById('mk-set-save').disabled).toBe(true);
  });

  test('editing routes to updateMarketSet, not addMarketSet', async () => {
    await mount();
    switchToOverview();

    document.querySelector('#mk-set-cards .mk-set-edit').click();
    await flush();

    const name = document.getElementById('mk-set-name');
    name.value = 'Renamed Set';
    name.dispatchEvent(new Event('input'));

    document.getElementById('mk-set-save').click();
    await flush();

    expect(state.calls.find((c) => c.fn === 'addMarketSet')).toBeUndefined();
    const update = state.calls.find((c) => c.fn === 'updateMarketSet');
    expect(update).toBeDefined();
    expect(update.updates.name).toBe('Renamed Set');
    // Scopes must persist as CONFIG OBJECTS, never arrays.
    expect(Array.isArray(update.updates.inputMaterials)).toBe(false);
    expect(update.updates.inputMaterials.priceType).toBeDefined();
  });

  function switchToOverview() {
    document.querySelector('[data-mk-tab="overview"]').click();
  }
});


/**
 * The mockup gates the output scope's LOCATION block on `!outSameLoc`
 * (`sc-if showOutputLoc`) and leaves the pricing fields outside that gate.
 * Mirroring the location must therefore not disable pricing: inputs are
 * bought and outputs sold, often at the same market with different rules.
 */
describe('set editor: mirrored output location', () => {
  async function openNewSet() {
    document.getElementById('mk-new-set').click();
    await flush();
  }

  function pricingLabels(scope) {
    return [...document.querySelectorAll(`#mk-scope-${scope} .mk-field`)]
      .map((f) => f.querySelector('.mk-label'))
      .filter(Boolean)
      .map((l) => l.textContent);
  }

  function setMirror(on) {
    const mirror = document.getElementById('mk-set-mirror');
    mirror.checked = on;
    mirror.dispatchEvent(new Event('change'));
  }

  test('mirroring removes the output location block entirely', async () => {
    await mount();
    await openNewSet();

    setMirror(false);
    expect(document.querySelectorAll('#mk-scope-output .mk-loc-card').length).toBe(5);

    setMirror(true);
    // Not merely dimmed - gone.
    expect(document.querySelectorAll('#mk-scope-output .mk-loc-card').length).toBe(0);
    expect(document.querySelector('#mk-scope-output .mk-loc-label')).toBeNull();
    expect(document.querySelector('#mk-scope-output .mk-loc-picker')).toBeNull();
  });

  test('mirroring leaves every output pricing field present and editable', async () => {
    await mount();
    await openNewSet();
    setMirror(true);

    const labels = pricingLabels('output');
    expect(labels).toEqual(expect.arrayContaining([
      'Price Type',
      'Calculation Method',
      'Price Modifier (%)',
      'Percentile Threshold',
      'Minimum Order Volume',
    ]));

    // Editable, not inert.
    const controls = document.querySelectorAll('#mk-scope-output select, #mk-scope-output input');
    expect(controls.length).toBeGreaterThan(0);
    controls.forEach((c) => expect(c.disabled).toBe(false));
  });

  test('the input scope keeps its location block while mirroring', async () => {
    await mount();
    await openNewSet();
    setMirror(true);

    expect(document.querySelectorAll('#mk-scope-input .mk-loc-card').length).toBe(5);
  });

  test('unmirroring restores the output location block', async () => {
    await mount();
    await openNewSet();

    setMirror(true);
    expect(document.querySelectorAll('#mk-scope-output .mk-loc-card').length).toBe(0);

    setMirror(false);
    expect(document.querySelectorAll('#mk-scope-output .mk-loc-card').length).toBe(5);
  });

  test('mirroring copies the input location onto the saved output scope', async () => {
    await mount();
    await openNewSet();

    // Choose a trade hub on the input side.
    document.querySelectorAll('#mk-scope-input .mk-loc-card')[0].click();
    await flush();
    await pickTradeHub('input', 'Jita');

    setMirror(true);

    const name = document.getElementById('mk-set-name');
    name.value = 'Mirrored';
    name.dispatchEvent(new Event('input'));

    document.getElementById('mk-set-save').click();
    await flush();

    const added = state.calls.find((c) => c.fn === 'addMarketSet');
    expect(added).toBeDefined();
    expect(added.data.outputProducts.locationId).toBe(added.data.inputMaterials.locationId);
    expect(added.data.outputProducts.regionId).toBe(added.data.inputMaterials.regionId);
  });

  test('output pricing stays independent of input pricing when mirrored', async () => {
    await mount();
    await openNewSet();

    document.querySelectorAll('#mk-scope-input .mk-loc-card')[0].click();
    await flush();
    await pickTradeHub('input', 'Jita');
    setMirror(true);

    // Change ONLY the output price type.
    const outSelects = document.querySelectorAll('#mk-scope-output select.qf-select');
    outSelects[0].value = 'buy';
    outSelects[0].dispatchEvent(new Event('change'));

    const name = document.getElementById('mk-set-name');
    name.value = 'Split pricing';
    name.dispatchEvent(new Event('input'));
    document.getElementById('mk-set-save').click();
    await flush();

    const added = state.calls.find((c) => c.fn === 'addMarketSet');
    expect(added.data.outputProducts.priceType).toBe('buy');
    expect(added.data.inputMaterials.priceType).toBe('sell');
  });
});

/**
 * The mockup's OUTPUT picker only implements three branches (hub, region, and
 * a catch-all "other" covering station/system/private_structure), while INPUT
 * implements all five. That is a gap in the mockup - both scopes persist the
 * same config shape - so the port makes them identical. These tests pin that,
 * so the divergence cannot creep back in.
 */
describe('set editor: input and output location controls are identical', () => {
  async function openNewSetUnmirrored() {
    document.getElementById('mk-new-set').click();
    await flush();
    const mirror = document.getElementById('mk-set-mirror');
    mirror.checked = false;
    mirror.dispatchEvent(new Event('change'));
    await flush();
  }

  function cardLabels(scope) {
    return [...document.querySelectorAll(`#mk-scope-${scope} .mk-loc-card .mk-loc-name`)]
      .map((n) => n.textContent);
  }

  /** Click a location card by label within one scope. */
  async function pickCard(scope, label) {
    const card = [...document.querySelectorAll(`#mk-scope-${scope} .mk-loc-card`)]
      .find((c) => c.querySelector('.mk-loc-name').textContent === label);
    card.click();
    await flush();
  }

  /** A structural fingerprint of a scope's picker, ignoring text content. */
  function pickerShape(scope) {
    const host = document.querySelector(`#mk-scope-${scope} .mk-loc-picker`);
    return {
      textInputs: host.querySelectorAll('input[type="text"]').length,
      listBoxes: host.querySelectorAll('select.mk-listbox').length,
      dropdowns: host.querySelectorAll('select.qf-select').length,
      searchSelects: host.querySelectorAll('.qf-ss-trigger').length,
      buttons: host.querySelectorAll('button').length,
      hasScopeNote: !!host.querySelector('.mk-struct-note'),
    };
  }

  test('both scopes offer the same five location cards', async () => {
    await mount();
    await openNewSetUnmirrored();

    expect(cardLabels('output')).toEqual(cardLabels('input'));
    expect(cardLabels('output')).toHaveLength(5);
  });

  test.each([
    ['Trade Hub'],
    ['Specific Station'],
    ['Solar System'],
    ['Entire Region'],
    ['Private Structure'],
  ])('the %s picker is structurally identical on both scopes', async (label) => {
    await mount();
    await openNewSetUnmirrored();

    await pickCard('input', label);
    await pickCard('output', label);

    expect(pickerShape('output')).toEqual(pickerShape('input'));
  });

  test('Specific Station gives the output scope a real station picker', async () => {
    // The mockup would have rendered a generic empty "Select Location" box.
    await mount();
    await openNewSetUnmirrored();
    await pickCard('output', 'Specific Station');

    const host = document.querySelector('#mk-scope-output .mk-loc-picker');
    expect(host.querySelectorAll('select.mk-listbox')).toHaveLength(2);
    expect(host.textContent).toContain('Select System');
    expect(host.textContent).toContain('Select Station');
  });

  test('Private Structure gives the output scope the ESI scope warning', async () => {
    await mount();
    await openNewSetUnmirrored();
    await pickCard('output', 'Private Structure');

    const note = document.querySelector('#mk-scope-output .mk-struct-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toMatch(/esi-markets\.structure_markets\.v1/);
  });
});

/**
 * Regression: the ESI character dropdown rendered blank options because the
 * renderer read `c.name` while settings-manager.getCharacters() returns
 * `characterName`. The test fixture returned an EMPTY character array, so no
 * test ever rendered an option and the bug shipped silently.
 */
describe('set editor: ESI character dropdown', () => {
  async function openPrivateStructure(scope) {
    document.getElementById('mk-new-set').click();
    await flush();
    if (scope === 'output') {
      const mirror = document.getElementById('mk-set-mirror');
      mirror.checked = false;
      mirror.dispatchEvent(new Event('change'));
      await flush();
    }
    const card = [...document.querySelectorAll(`#mk-scope-${scope} .mk-loc-card`)]
      .find((c) => c.querySelector('.mk-loc-name').textContent === 'Private Structure');
    card.click();
    await flush();
  }

  function characterOptions(scope) {
    // The character picker is a QFSearchSelect; read its options directly
    // rather than a <select>'s option list.
    const trigger = document.querySelector(`#mk-scope-${scope} .mk-struct .qf-ss-trigger`);
    expect(trigger).not.toBeNull();
    trigger.click();
    const opts = [...document.querySelectorAll('.qf-ss-popover .qf-ss-row')]
      .map((r) => ({ value: r.dataset.value, label: r.textContent.trim() }));
    document.body.click(); // close the popover
    return opts;
  }

  test('lists every character by name', async () => {
    await mount();
    await openPrivateStructure('input');

    const opts = characterOptions('input');
    // QFSearchSelect shows the placeholder on the TRIGGER, not as a list row,
    // so the list is exactly one row per character.
    expect(opts).toHaveLength(2);
    expect(opts[0].label).toBe('Buckwalter');
    expect(opts[1].label).toBe('Roshcar');
  });

  test('no option renders as a blank string', async () => {
    await mount();
    await openPrivateStructure('input');

    characterOptions('input').forEach((o) => {
      expect(o.label.trim()).not.toBe('');
      expect(o.label).not.toBe('undefined');
    });
  });

  test('each option carries its character id as the value', async () => {
    await mount();
    await openPrivateStructure('input');

    const opts = characterOptions('input');
    expect(opts[0].value).toBe('133585695');
    expect(opts[1].value).toBe('1194303072');
  });

  test('the output scope lists characters too', async () => {
    await mount();
    await openPrivateStructure('output');

    const opts = characterOptions('output');
    expect(opts.map((o) => o.label)).toContain('Buckwalter');
  });

  test('selecting a character enables the structure search', async () => {
    await mount();
    await openPrivateStructure('input');

    const searchInput = document.querySelector('#mk-scope-input .mk-struct-search input');
    expect(searchInput.disabled).toBe(true);

    const trigger = document.querySelector('#mk-scope-input .mk-struct .qf-ss-trigger');
    trigger.click();
    const row = [...document.querySelectorAll('.qf-ss-popover .qf-ss-row')]
      .find((r) => r.textContent.includes('Buckwalter'));
    row.click();
    await flush();

    expect(document.querySelector('#mk-scope-input .mk-struct-search input').disabled).toBe(false);
  });
});


/**
 * Switching market set must refresh everything the set governs, not just the
 * labels. Prices, the region-scoped filter and the inspector all derive from
 * the set's region and pricing config; re-rendering without reloading left the
 * previous set's numbers showing under the new set's name.
 */
describe('changing the active market set', () => {
  /** Click the second market set (Amarr, region 10000043) in the context pane. */
  async function selectAmarr() {
    const rows = [...document.querySelectorAll('#mk-set-list .mk-context-row')];
    const amarr = rows.find((r) => r.textContent.includes('Amarr'));
    expect(amarr).toBeDefined();
    amarr.click();
    await flush();
  }

  async function selectTritanium() {
    const row = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'));
    row.click();
    await flush();
  }

  test('the pricing table reprices against the new set', async () => {
    await mount();
    const before = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'))
      .querySelector('.mk-sell').textContent;

    await selectAmarr();

    const after = [...document.querySelectorAll('#mk-rows tr')]
      .find((tr) => tr.textContent.includes('Tritanium'))
      .querySelector('.mk-sell').textContent;

    expect(after).not.toBe(before);
  });

  test('the order book is requeried for the new region', async () => {
    await mount();
    state.calls.length = 0;

    await selectAmarr();

    const bookCalls = state.calls.filter((c) => c.fn === 'getOrderBookSummary');
    expect(bookCalls.length).toBeGreaterThan(0);
    expect(bookCalls.some((c) => c.regionId === 10000043)).toBe(true);
  });

  test('the inspector reprices for the selected item', async () => {
    await mount();
    await selectTritanium();
    const before = document.querySelector('.mk-insp-price-value').textContent;

    await selectAmarr();

    expect(document.querySelector('.mk-insp-price-value').textContent).not.toBe(before);
  });

  test('the inspector keeps the same item selected', async () => {
    await mount();
    await selectTritanium();

    await selectAmarr();

    expect(document.getElementById('mk-inspector-title').textContent)
      .toBe('Tritanium · Inspector');
  });

  test('an active filter is re-run against the new region', async () => {
    await mount();
    const input = document.getElementById('mk-search');
    input.value = 'trit';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 250));
    await flush();
    state.calls.length = 0;

    await selectAmarr();

    const searches = state.calls.filter((c) => c.fn === 'searchTradedItems');
    expect(searches.length).toBeGreaterThan(0);
    expect(searches[searches.length - 1].regionId).toBe(10000043);
  });

  test('re-selecting the same set does no work', async () => {
    await mount();
    state.calls.length = 0;

    const rows = [...document.querySelectorAll('#mk-set-list .mk-context-row')];
    const jita = rows.find((r) => r.textContent.includes('Jita'));
    jita.click();
    await flush();

    expect(state.calls.filter((c) => c.fn === 'getOrderBookSummary')).toHaveLength(0);
  });

  test('the plan list is not refetched on every table repaint', async () => {
    state.plansByType = {
      34: [{ planId: 'p1', planName: 'Capital Build', status: 'active', scope: 'input', lockedPrice: 5, lockedAt: Date.now(), quantity: 100, isOverride: false, lastMarketPrice: 5 }],
    };
    await mount();
    await selectTritanium();
    state.calls.length = 0;

    // A favourite toggle repaints the table twice (optimistic + reconcile).
    document.querySelector('#mk-rows .mk-fav').click();
    await flush();

    expect(state.calls.filter((c) => c.fn === 'getPlansUsingType')).toHaveLength(0);
  });
});

/**
 * Combobox result rows must survive a hover.
 *
 * mouseenter used to re-render the whole list, which destroyed the row the
 * mousedown had landed on - so the browser never delivered the click and items
 * appeared unselectable by mouse. Keyboard selection still worked, which is
 * why it went unnoticed.
 */
/**
 * Clearing the chosen item must clear the search behind it. Leaving the old
 * query in place made the previous results reappear, as if nothing had been
 * cleared.
 */


describe('set card: Region sub-line and Source column', () => {
  /**
   * Mount and open the Overview tab.
   *
   * The view opens on Pricing, and renderOverview() only runs for its own tab,
   * so the set cards do not exist after a bare mount().
   */
  async function mountOverview() {
    await mount();
    document.querySelector('[data-mk-tab="overview"]').click();
    await flush();
  }

  /** The card for a set, by its name. */
  function cardFor(name) {
    const card = [...document.querySelectorAll('#mk-set-cards .mk-set-card')]
      .find((c) => c.querySelector('.mk-set-name').textContent.includes(name));
    // A missing card means the tab never rendered - fail with that, rather
    // than a bare "cannot read property of undefined" from the caller.
    if (!card) throw new Error(`No set card found for "${name}"`);
    return card;
  }
  const regionOf = (name) => cardFor(name).querySelector('.mk-set-region').textContent;
  const sourceOf = (name) => cardFor(name).querySelector('.mk-set-source').textContent;

  test('a station-scoped set names the station, with its region on the sub-line', async () => {
    await mountOverview();
    // The two facts are complementary, not duplicated: the region says WHERE
    // in space, the source says which order book the prices come from.
    expect(regionOf('Jita 4-4')).toBe('The Forge');
    expect(sourceOf('Jita 4-4')).toBe('Jita IV-4');
  });

  test('one station is shown once, not repeated per scope', async () => {
    // Both scopes point at Jita in the fixture. Echoing it twice would make
    // every ordinary card read its own station name back to back.
    await mountOverview();
    expect(sourceOf('Jita 4-4')).toBe('Jita IV-4');
  });

  test('differing buy/sell stations show BOTH, in both columns', async () => {
    // The whole point of the column: an asymmetric set is easy to forget and
    // this is the only place it is visible without opening the editor.
    state.sets[0].outputProducts = { regionId: 10000043, locationId: 60008494, priceType: 'buy' };
    await mountOverview();

    expect(regionOf('Jita 4-4')).toBe('The Forge · Domain');
    expect(sourceOf('Jita 4-4')).toBe('Jita IV-4 · Amarr VIII');
  });

  test('two stations in ONE region still show both stations', async () => {
    // The regions dedupe to a single name; the stations must not follow suit,
    // or the card would hide a real difference behind a tidy sub-line.
    state.sets[0].outputProducts = { regionId: 10000002, locationId: 60008494, priceType: 'buy' };
    await mountOverview();

    expect(regionOf('Jita 4-4')).toBe('The Forge');
    expect(sourceOf('Jita 4-4')).toBe('Jita IV-4 · Amarr VIII');
  });

  test('a region-wide set reads "Region", not the region name again', async () => {
    state.sets[0].inputMaterials = { regionId: 10000002, locationType: 'region', priceType: 'sell' };
    state.sets[0].outputProducts = { regionId: 10000002, locationType: 'region', priceType: 'buy' };
    await mountOverview();

    expect(regionOf('Jita 4-4')).toBe('The Forge');
    // Repeating "The Forge" here would fill the column with no new fact.
    expect(sourceOf('Jita 4-4')).toBe('Region');
  });

  test('a station on one side and region-wide on the other spells out both', async () => {
    state.sets[0].outputProducts = { regionId: 10000002, locationType: 'region', priceType: 'buy' };
    await mountOverview();

    expect(sourceOf('Jita 4-4')).toBe('Jita IV-4 · Region');
  });

  test('a player structure shows its own name', async () => {
    // Structures are NOT in market_locations (that table holds NPC hubs), so
    // the name has to come off the set's own structureName.
    state.sets[0].inputMaterials = {
      regionId: 10000002, structureId: 1234, structureName: 'V-3YG7 VI - The Capital',
    };
    state.sets[0].outputProducts = {
      regionId: 10000002, structureId: 1234, structureName: 'V-3YG7 VI - The Capital',
    };
    await mountOverview();

    expect(sourceOf('Jita 4-4')).toBe('V-3YG7 VI - The Capital');
  });

  test('an unconfigured set does not claim to be region-wide', async () => {
    // "Region" would assert a scope the set does not have. The sub-line
    // already says the region is missing; the source must agree with it.
    state.sets[0].inputMaterials = {};
    state.sets[0].outputProducts = {};
    await mountOverview();

    expect(regionOf('Jita 4-4')).toBe('No region configured');
    expect(sourceOf('Jita 4-4')).toBe('Not configured');
  });

  test('an unknown station id degrades to its id rather than blanking', async () => {
    state.sets[0].inputMaterials = { regionId: 10000002, locationId: 99999999 };
    state.sets[0].outputProducts = { regionId: 10000002, locationId: 99999999 };
    await mountOverview();

    expect(sourceOf('Jita 4-4')).toBe('Station 99999999');
  });

  test('the full source is on the title attribute, since the column clamps', async () => {
    await mountOverview();
    const value = cardFor('Jita 4-4').querySelector('.mk-set-source');
    expect(value.title).toBe(value.textContent);
  });

  test('the long source value cannot stretch its grid track', async () => {
    // A grid item defaults to min-content width, so without min-width:0 a long
    // station name widens the Source track and squeezes the others. jsdom does
    // no layout, so this has to be asserted against the stylesheet text.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/market-view.css'),
      'utf8'
    );
    const grid = css.match(/#market-view\s+\.mk-set-body\s*>\s*\*\s*\{[^}]*\}/)[0];
    expect(grid).toMatch(/min-width:\s*0/);

    const value = css.match(/#market-view\s+\.mk-set-source\s*\{[^}]*\}/)[0];
    expect(value).toMatch(/min-width:\s*0/);
    expect(value).toMatch(/overflow:\s*hidden/);
  });

  test('Source gets more width than Status, which only holds a pill', async () => {
    // Status was 1.4fr - the widest track - while holding a freshness pill and
    // nothing else, so it sat on a slab of dead space while Source truncated
    // after a word or two. Status is content-sized now (with a floor for the
    // refresh progress bar) and Source has the largest flexible share.
    const css = fs.readFileSync(
      path.join(__dirname, '../../public/market-view.css'),
      'utf8'
    );
    const body = css.match(/#market-view\s+\.mk-set-body\s*\{[^}]*\}/)[0];
    const columns = body.match(/grid-template-columns:\s*([^;]+);/)[1].trim();
    const [identity, source, status] = columns.split(/\s+(?![^(]*\))/);

    const fr = (t) => parseFloat(t);
    expect(fr(source)).toBeGreaterThan(fr(identity));
    // Status must NOT be an fr track any more - that is what created the gap.
    expect(status).not.toMatch(/fr$/);
    // ...but it still needs a floor, or the progress bar collapses.
    expect(status).toMatch(/minmax\(/);
  });

  test('the column is labelled Source, and Basis is gone', async () => {
    await mountOverview();
    const labels = [...cardFor('Jita 4-4').querySelectorAll('.mk-set-col-label')]
      .map((l) => l.textContent);
    expect(labels).toContain('Source');
    // Basis showed priceType, which is near-constant across sets and so
    // carried no information at card level.
    expect(labels).not.toContain('Basis');
  });
});
