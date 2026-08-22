/**
 * @jest-environment jsdom
 *
 * Manufacturing Plans - the Settings tab: the two-axis source grids and
 * per-plan price overrides.
 *
 * Overrides are written INTO the frozen price field itself, not layered over
 * it at read time, so they survive recalculation.
 *
 * Split out of the original single Plans suite; the shared fake backend and
 * mount helpers live in ./helpers/plans-harness.
 */

const h = require('./helpers/plans-harness');

h.installHooks();

const { state, openTab, settle } = h;

describe('settings - the two-axis source grids', () => {
  // These grids are the plan-scoped half of the blueprint-source work. They
  // MUST survive this port: dropping them silently reverts every plan to the
  // global sources.
  test('characters have separate Assets and Blueprints checkboxes', async () => {
    await openTab('settings');

    const row = document.querySelector('#plan-default-characters-container [data-mp-character]');
    expect(row.querySelector('.mp-axis-assets')).not.toBeNull();
    expect(row.querySelector('.mp-axis-blueprints')).not.toBeNull();
  });

  test('divisions have separate Assets and Blueprints checkboxes', async () => {
    await openTab('settings');

    const row = document.querySelector('#plan-character-divisions-container [data-mp-division]');
    expect(row.querySelector('.mp-axis-assets')).not.toBeNull();
    expect(row.querySelector('.mp-axis-blueprints')).not.toBeNull();
  });

  test('reflects the stored state of each axis independently', async () => {
    // Division 1 is an ASSET source; division 3 is a BLUEPRINT source. Neither
    // implies the other.
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div1 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '1');
    const div3 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '3');

    expect(div1.querySelector('.mp-axis-assets').checked).toBe(true);
    expect(div1.querySelector('.mp-axis-blueprints').checked).toBe(false);
    expect(div3.querySelector('.mp-axis-assets').checked).toBe(false);
    expect(div3.querySelector('.mp-axis-blueprints').checked).toBe(true);
  });

  test('toggling a BLUEPRINT division writes only the blueprint field', async () => {
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div5 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '5');
    const checkbox = div5.querySelector('.mp-axis-blueprints');
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change'));
    await settle(20);

    expect(state.calls.some((c) => c.fn === 'plans.updateCharacterBlueprintDivisions')).toBe(true);
    expect(state.calls.some((c) => c.fn === 'plans.updateCharacterDivisions')).toBe(false);
  });

  test('toggling an ASSET division writes only the asset field', async () => {
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div5 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '5');
    const checkbox = div5.querySelector('.mp-axis-assets');
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change'));
    await settle(20);

    expect(state.calls.some((c) => c.fn === 'plans.updateCharacterDivisions')).toBe(true);
    expect(state.calls.some((c) => c.fn === 'plans.updateCharacterBlueprintDivisions')).toBe(false);
  });

  test('toggling a character blueprint source does not touch the asset list', async () => {
    await openTab('settings');

    const row = document.querySelector(
      '#plan-default-characters-container [data-mp-character="96061222"]'
    );
    const checkbox = row.querySelector('.mp-axis-blueprints');
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change'));
    await settle(20);

    const call = state.calls.find((c) => c.fn === 'plans.updateIndustrySettings');
    expect(call.settings.blueprintCharacters).toContain(96061222);
    expect(call.settings.defaultCharacters).not.toContain(96061222);
  });

  test('shows real corporation division names, not "Division N"', async () => {
    // Names come from divisions.getSettings, the same source Settings >
    // Industry uses. Without fetching them the grid showed generic labels
    // even when the real names were stored.
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div1 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '1');
    expect(div1.textContent).toContain('Production');
    expect(div1.textContent).not.toContain('Division 1');
  });

  test('a division with no fetched name falls back to the generic label', async () => {
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div5 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '5');
    expect(div5.textContent).toContain('Division 5');
    expect(div5.querySelector('.mp-custom-badge')).toBeNull();
  });

  test('a fetched name is badged as custom', async () => {
    await openTab('settings');

    const rows = document.querySelectorAll('#plan-character-divisions-container [data-mp-division]');
    const div1 = Array.from(rows).find((r) => r.getAttribute('data-mp-division') === '1');
    expect(div1.querySelector('.mp-custom-badge')).not.toBeNull();
  });

  test('Refresh Names re-fetches for that character only', async () => {
    await openTab('settings');
    state.calls.length = 0;

    document
      .querySelector('[data-mp-refresh-names="91316135"]')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'divisions.fetchNames');
    expect(call.characterId).toBe(91316135);
  });

  test('the reactions toggle is a switch, not a checkbox', async () => {
    // An on/off MODE, per the redesign - the shared .toggle control.
    await openTab('settings');

    const toggle = document.getElementById('mp-reactions-as-intermediates');
    expect(toggle.closest('.toggle')).not.toBeNull();
    expect(toggle.parentElement.querySelector('.toggle-slider')).not.toBeNull();
  });

  test('the reactions toggle reflects and saves plan state', async () => {
    await openTab('settings');

    const toggle = document.getElementById('mp-reactions-as-intermediates');
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    await settle(30);

    const call = state.calls.find((c) => c.fn === 'plans.updateIndustrySettings');
    expect(call.settings.reactionsAsIntermediates).toBe(true);
  });
});

describe('settings - price overrides', () => {
  test('lists the plan overrides', async () => {
    await openTab('settings');
    // Header + 2 rows.
    expect(document.querySelectorAll('#mp-price-overrides .mp-override-row')).toHaveLength(3);
  });

  test('has column headers', async () => {
    await openTab('settings');

    const header = document.querySelector('#mp-price-overrides .mp-build-header');
    ['Item', 'Override', 'Market Lock', 'Drift', 'Updated']
      .forEach((label) => expect(header.textContent).toContain(label));
  });

  test('shows drift between the override and the lock it replaced', async () => {
    await openTab('settings');

    // 7.50 vs 5.25 = +42.9%
    const row = document.querySelector('[data-mp-override-type="34"]');
    expect(row.querySelector('.mp-drift').textContent).toBe('+42.9%');
  });

  test('an override with no market lock shows no drift, not 0%', async () => {
    await openTab('settings');

    const row = document.querySelector('[data-mp-override-type="35"]');
    expect(row.querySelector('.mp-drift')).toBeNull();
  });

  test('delete is an icon button, not the word "Remove"', async () => {
    await openTab('settings');

    const row = document.querySelector('[data-mp-override-type="34"]');
    const button = row.querySelector('.mp-icon-btn');
    expect(button).not.toBeNull();
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.textContent.trim()).toBe('');
    expect(button.getAttribute('aria-label')).toContain('Tritanium');
  });

  test('shows the market snapshot the override replaced', async () => {
    await openTab('settings');

    const row = document.querySelector('[data-mp-override-type="34"]');
    expect(row.textContent).toContain('7.50');
    expect(row.textContent).toContain('5.25');
  });

  test('an override with no snapshot shows an em dash', async () => {
    // Never locked, so there is nothing truthful to revert to.
    await openTab('settings');

    const row = document.querySelector('[data-mp-override-type="35"]');
    expect(row.textContent).toContain('—');
  });

  test('removing an override sends its type id', async () => {
    await openTab('settings');

    // The delete control is an icon button now, not a text link.
    document
      .querySelector('[data-mp-override-type="34"] .mp-icon-btn')
      .dispatchEvent(new window.MouseEvent('click'));
    await settle(30);

    expect(state.calls.find((c) => c.fn === 'plans.removePriceOverride').typeId).toBe(34);
  });

  test('no overrides renders a message', async () => {
    state.priceOverrides = [];
    await openTab('settings');

    expect(document.getElementById('mp-price-overrides').textContent)
      .toContain('No price overrides');
  });
});

