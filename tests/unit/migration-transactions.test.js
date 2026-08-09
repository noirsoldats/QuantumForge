/**
 * Structural guard: every schema migration must manage its own transaction.
 *
 * runSchemaMigrations() cannot wrap `up()` in a transaction, because every
 * schema migration already opens one and SQLite does not nest them. That makes
 * the convention load-bearing but unenforced by the language - exactly the kind
 * of rule that erodes.
 *
 * Without a transaction, a partial failure leaves the schema half-changed AND
 * the migration recorded as applied, so it never retries.
 *
 * These tests fail if a new migration is added without BEGIN/COMMIT/ROLLBACK,
 * rather than leaving it to code review.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/main/database-schema-migrations.js'),
  'utf8'
);

/**
 * DATA migrations that legitimately have no transaction of their own because
 * they call into code that opens its own. Add to this list only with a comment
 * explaining why, and never for a migration that writes schema directly.
 */
const NO_TRANSACTION_ALLOWED = new Set([
  // Calls recalculatePlanMaterials(), which transacts internally.
  '009_recalculate_plans_nested_reactions',
]);

/** Split the file into one entry per migration object. */
function migrationBodies() {
  return SOURCE.split(/\n {2}\{\n {4}id: '/)
    .slice(1)
    .map((part) => ({
      id: part.slice(0, part.indexOf("'")),
      body: part.split('\n  },')[0],
    }));
}

describe('schema migrations manage their own transactions', () => {
  const bodies = migrationBodies();

  test('the file parses into individual migrations', () => {
    expect(bodies.length).toBeGreaterThan(20);
    expect(bodies[0].id).toMatch(/^\d{3}_/);
  });

  test.each(migrationBodies().map((m) => [m.id, m.body]))(
    '%s opens, commits and rolls back its own transaction',
    (id, body) => {
      if (NO_TRANSACTION_ALLOWED.has(id)) {
        // Pinned: if this migration ever starts writing schema directly it
        // must be removed from the allow-list.
        expect(body).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE/);
        return;
      }

      expect(body).toContain('BEGIN TRANSACTION');
      expect(body).toContain('COMMIT');
      expect(body).toContain('ROLLBACK');
    }
  );

  test('every migration id is unique', () => {
    const ids = bodies.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('migration ids are numbered in order', () => {
    const ids = bodies.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
  });

  test('the allow-list names only migrations that exist', () => {
    const ids = new Set(bodies.map((m) => m.id));
    NO_TRANSACTION_ALLOWED.forEach((id) => expect(ids.has(id)).toBe(true));
  });

  /**
   * Tables that OTHER tables reference. Rebuilding one of these means DROPping
   * a table that inbound foreign keys point at, so `foreign_keys` must be off
   * across the swap or the DROP cascades and deletes the referencing rows.
   *
   * Rebuilding a table with only OUTBOUND foreign keys (assets -> characters,
   * say) is safe without the pragma: nothing points at it.
   */
  const REFERENCED_TABLES = new Set([
    'characters',
    'manufacturing_plans',
    'blueprints',
    'plan_blueprints',
  ]);

  test('a rebuild of a referenced table toggles foreign_keys around the swap', () => {
    const rebuilds = bodies
      .map((m) => {
        const match = m.body.match(/ALTER TABLE \w+_new RENAME TO (\w+)/);
        return match ? { id: m.id, table: match[1], body: m.body } : null;
      })
      .filter(Boolean);

    // Guard the guard: if this stops finding rebuilds, the regex has rotted.
    expect(rebuilds.length).toBeGreaterThan(0);

    rebuilds
      .filter((r) => REFERENCED_TABLES.has(r.table))
      .forEach((r) => {
        expect(r.body).toContain('foreign_keys = OFF');
        expect(r.body).toContain('foreign_keys = ON');
      });
  });

  test('the referenced-table list still matches the migrations', () => {
    // If a migration starts rebuilding a table that other tables reference,
    // it must be added to REFERENCED_TABLES so the check above covers it.
    const rebuilt = bodies
      .map((m) => (m.body.match(/ALTER TABLE \w+_new RENAME TO (\w+)/) || [])[1])
      .filter(Boolean);

    expect(rebuilt).toEqual(expect.arrayContaining(['plan_price_overrides']));
  });
});

describe('the runner refuses a migration that leaves a transaction open', () => {
  test('the guard is present in runSchemaMigrations', () => {
    // The convention is enforced at runtime as well as by the tests above:
    // a forgotten COMMIT would otherwise be discarded at connection close
    // while the migration was recorded as applied.
    expect(SOURCE).toContain('db.inTransaction');
    expect(SOURCE).toMatch(/left a transaction open/);
  });
});
