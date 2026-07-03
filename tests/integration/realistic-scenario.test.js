/**
 * Realistic Multi-Character Scenario — Broad Wiring Checks
 *
 * Uses tests/fixtures/db/realistic-scenario.character.db (2 characters, a
 * few owned blueprints with varying ME/TE, one manufacturing plan per
 * character) to check that per-character data stays correctly scoped and
 * connected across the app's real query functions — not exhaustive
 * per-field correctness (that's owned by tests/unit/golden-values.test.js
 * and the existing unit suites), just "do the pieces wire together
 * correctly across a realistic multi-character dataset."
 *
 * See tests/fixtures/db/generate-realistic-scenario-db.js for how the
 * fixture is built and regenerated.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const FIXTURE_DB_PATH = path.join(__dirname, '../fixtures/db/realistic-scenario.character.db');

describe('Realistic multi-character scenario', () => {
  let tempDir;
  let getBlueprints;
  let getManufacturingPlans;
  let getPlanBlueprints;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantum-scenario-test-'));
    fs.copyFileSync(FIXTURE_DB_PATH, path.join(tempDir, 'character-data.db'));

    jest.isolateModules(() => {
      const configMigration = require('../../src/main/config-migration');
      configMigration.getConfigDir = jest.fn(() => tempDir);

      ({ getBlueprints } = require('../../src/main/settings-manager'));
      ({ getManufacturingPlans, getPlanBlueprints } = require('../../src/main/manufacturing-plans'));
    });
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('each character sees only their own blueprints', () => {
    const ariaBlueprints = getBlueprints(90000001);
    const bramBlueprints = getBlueprints(90000002);

    expect(ariaBlueprints).toHaveLength(1);
    expect(ariaBlueprints[0].itemId).toBe('bp-1');

    expect(bramBlueprints).toHaveLength(2);
    expect(bramBlueprints.map(bp => bp.itemId).sort()).toEqual(['bp-2', 'bp-3']);
  });

  test('blueprint ME/TE values are preserved per character, not shared/defaulted', () => {
    const bramBlueprints = getBlueprints(90000002);
    const bp2 = bramBlueprints.find(bp => bp.itemId === 'bp-2');
    const bp3 = bramBlueprints.find(bp => bp.itemId === 'bp-3');

    expect(bp2.materialEfficiency).toBe(10);
    expect(bp2.timeEfficiency).toBe(20);
    expect(bp3.materialEfficiency).toBe(8);
    expect(bp3.timeEfficiency).toBe(10);
  });

  test('switching default character changes which blueprints and plans appear', () => {
    const ariaPlans = getManufacturingPlans(90000001);
    const bramPlans = getManufacturingPlans(90000002);

    expect(ariaPlans).toHaveLength(1);
    expect(ariaPlans[0].planName).toBe('Scourge Missile Run');

    expect(bramPlans).toHaveLength(1);
    expect(bramPlans[0].planName).toBe('Bulk Scourge Production');

    // Plans must not leak across characters
    expect(ariaPlans[0].planId).not.toBe(bramPlans[0].planId);
  });

  test('each plan is wired to the correct blueprint configuration', () => {
    const ariaPlans = getManufacturingPlans(90000001);
    const bramPlans = getManufacturingPlans(90000002);

    const ariaPlanBlueprints = getPlanBlueprints(ariaPlans[0].planId);
    const bramPlanBlueprints = getPlanBlueprints(bramPlans[0].planId);

    expect(ariaPlanBlueprints).toHaveLength(1);
    expect(ariaPlanBlueprints[0].blueprintTypeId).toBe(810);
    expect(ariaPlanBlueprints[0].runs).toBe(10);
    expect(ariaPlanBlueprints[0].meLevel).toBe(0);

    expect(bramPlanBlueprints).toHaveLength(1);
    expect(bramPlanBlueprints[0].runs).toBe(50);
    expect(bramPlanBlueprints[0].meLevel).toBe(10);
    expect(bramPlanBlueprints[0].teLevel).toBe(20);
  });
});
