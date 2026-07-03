/**
 * One-off generator for tests/fixtures/db/realistic-scenario.character.db.
 *
 * A small, realistic multi-character dataset (2 characters, a handful of
 * owned blueprints with varying ME/TE, 2 manufacturing plans) used by
 * tests/integration/realistic-scenario.test.js's broad wiring checks.
 * Reuses tests/fixtures/db/pricing-consistency.{sde,market}.db for
 * item/pricing data rather than building a third/fourth database.
 *
 * Not a real test — run manually via Jest whenever the fixture needs to
 * change (needs Jest's electron mock from tests/setup.js and a
 * Node-built better-sqlite3):
 *   npm run rebuild:node
 *   npx jest tests/fixtures/db/generate-realistic-scenario-db.js
 *   npm run rebuild:electron
 *
 * Builds the schema by calling the real initializeCharacterDatabase()
 * (mocking config-migration's getConfigDir to point at a temp dir) so the
 * fixture's schema can never drift from the app's actual, migrated schema
 * — only the seed data below is hand-written.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const DB_DIR = __dirname;
const OUTPUT_PATH = path.join(DB_DIR, 'realistic-scenario.character.db');

test('generate realistic-scenario.character.db', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantum-fixture-gen-'));

  jest.isolateModules(() => {
    const configMigration = require('../../../src/main/config-migration');
    configMigration.getConfigDir = jest.fn(() => tempDir);

    const { getCharacterDatabase, initializeCharacterDatabase } = require('../../../src/main/character-database');
    initializeCharacterDatabase();
    const db = getCharacterDatabase();

    const now = Date.now();

    // Two characters: one light on blueprints, one more developed
    const characters = [
      { character_id: 90000001, character_name: 'Aria Vex', corporation_id: 98000001 },
      { character_id: 90000002, character_name: 'Bram Solenne', corporation_id: 98000001 },
    ];
    const insertCharacter = db.prepare(`
      INSERT INTO characters (character_id, character_name, corporation_id, access_token, refresh_token, expires_at, scopes, added_at, updated_at)
      VALUES (?, ?, ?, 'fixture-access-token', 'fixture-refresh-token', ?, 'esi-characters.read_blueprints.v1', ?, ?)
    `);
    for (const c of characters) {
      insertCharacter.run(c.character_id, c.character_name, c.corporation_id, now + 3600000, now, now);
    }

    // Blueprints — Scourge Light Missile Blueprint (typeID 810) at varying ME/TE,
    // matching tests/fixtures/db/pricing-consistency.sde.db's data
    const insertBlueprint = db.prepare(`
      INSERT INTO blueprints (
        item_id, type_id, character_id, corporation_id, location_id,
        location_flag, quantity, time_efficiency, material_efficiency,
        runs, is_copy, is_corporation, source, manually_added,
        fetched_at, last_updated, cache_expires_at
      ) VALUES (?, ?, ?, NULL, ?, 'Hangar', ?, ?, ?, ?, ?, 0, 'esi', 0, ?, ?, NULL)
    `);
    const blueprints = [
      { itemId: 'bp-1', typeId: 810, characterId: 90000001, locationId: 60003760, quantity: 1, te: 0, me: 0, runs: -1, isCopy: 0 },
      { itemId: 'bp-2', typeId: 810, characterId: 90000002, locationId: 60003760, quantity: 1, te: 20, me: 10, runs: -1, isCopy: 0 },
      { itemId: 'bp-3', typeId: 810, characterId: 90000002, locationId: 60003760, quantity: 5, te: 10, me: 8, runs: 50, isCopy: 1 },
    ];
    for (const bp of blueprints) {
      insertBlueprint.run(bp.itemId, bp.typeId, bp.characterId, bp.locationId, bp.quantity, bp.te, bp.me, bp.runs, bp.isCopy, now, now);
    }

    // Manufacturing plans — one per character
    const insertPlan = db.prepare(`
      INSERT INTO manufacturing_plans (plan_id, character_id, plan_name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `);
    const plans = [
      { planId: 'plan-1', characterId: 90000001, name: 'Scourge Missile Run' },
      { planId: 'plan-2', characterId: 90000002, name: 'Bulk Scourge Production' },
    ];
    for (const p of plans) {
      insertPlan.run(p.planId, p.characterId, p.name, 'Fixture scenario plan', now, now);
    }

    // Plan blueprints — link each plan to a Scourge Light Missile Blueprint run
    const insertPlanBlueprint = db.prepare(`
      INSERT INTO plan_blueprints (plan_blueprint_id, plan_id, blueprint_type_id, runs, lines, me_level, te_level, facility_id, facility_snapshot, added_at)
      VALUES (?, ?, 810, ?, 1, ?, ?, NULL, NULL, ?)
    `);
    insertPlanBlueprint.run('plan-bp-1', 'plan-1', 10, 0, 0, now);
    insertPlanBlueprint.run('plan-bp-2', 'plan-2', 50, 10, 20, now);

    db.close();

    fs.copyFileSync(path.join(tempDir, 'character-data.db'), OUTPUT_PATH);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });

  expect(fs.existsSync(OUTPUT_PATH)).toBe(true);
  console.log(`Wrote ${OUTPUT_PATH}`);
});
