# Fixture SQLite Databases

Committed, read-only SQLite fixtures used by cross-module integration tests
that need multiple modules to query the exact same underlying data — as
opposed to `tests/unit/helpers/database-mocks.js`'s per-file mocks, which
risk each test's mocked responses silently drifting apart from what a real
query would return.

## Files

- `pricing-consistency.sde.db` — tiny SDE subset: the Scourge Light Missile
  Blueprint (typeID 810) and its 4 materials (Tritanium, Pyerite, Mexallon,
  Morphite), matching `tests/unit/fixtures/blueprints.js`'s `scourgeBlueprint`.
- `pricing-consistency.market.db` — Tritanium (typeID 34) sell orders and
  5 days of price history in The Forge / Jita 4-4, matching
  `tests/unit/fixtures/market-data.js`'s `tritaniumOrders.sell`.
- `realistic-scenario.character.db` — a small `character-data.db`-shaped
  fixture: 2 characters, 3 owned Scourge Light Missile Blueprints (typeID
  810, matching `pricing-consistency.sde.db`) at varying ME/TE, and one
  manufacturing plan per character. Used by
  `tests/integration/realistic-scenario.test.js`'s broad wiring checks
  (per-character data scoping, plan-to-blueprint linkage) — not for
  pricing/material correctness, which the other fixtures and the
  golden-value suite already own.

## Regenerating

Do not hand-edit the `.db` files.

`pricing-consistency.{sde,market}.db` — edit `generate-pricing-consistency-db.js`
and re-run it as a plain Node script:

```bash
npm run rebuild:node   # better-sqlite3 must be built for Node, not Electron
node tests/fixtures/db/generate-pricing-consistency-db.js
npm run rebuild:electron
```

`realistic-scenario.character.db` — edit `generate-realistic-scenario-db.js`
and re-run it **through Jest** (it needs `tests/setup.js`'s `electron` mock,
since it calls the real `initializeCharacterDatabase()` so the fixture's
schema can never drift from the app's actual, migrated schema):

```bash
npm run rebuild:node
npx jest tests/fixtures/db/generate-realistic-scenario-db.js --testPathIgnorePatterns='[]' --testMatch='**/generate-realistic-scenario-db.js'
npm run rebuild:electron
```

Commit the regenerated files after either script.

## Usage in tests

```js
const { loadFixtureDatabase } = require('../unit/helpers/database-mocks');
const sdeDb = loadFixtureDatabase('pricing-consistency.sde');
const marketDb = loadFixtureDatabase('pricing-consistency.market');
```

Both are opened `readonly: true` — tests must not write to them.

`realistic-scenario.character.db` is copied to a temp directory before use
(see `tests/integration/realistic-scenario.test.js`) since the app's
character-database functions open it for read/write via `getConfigDir()`,
not via `loadFixtureDatabase`'s readonly `better-sqlite3` handle.
