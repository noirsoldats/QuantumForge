# Database Schema Migrations

This document explains the database schema migration system in Quantum Forge and how to add new migrations.

## Overview

The migration system tracks and applies database schema changes in a controlled, versioned manner. It ensures that all users' databases are updated to the latest schema regardless of which version they're upgrading from.

## Key Features

- **Automatic Execution**: Migrations run automatically at application startup
- **Versioned Tracking**: Each migration has a unique ID and is tracked in the `schema_migrations` table
- **Idempotent**: Migrations only run once and are skipped if already applied
- **Transactional**: Migrations use transactions to ensure atomic changes (all-or-nothing)
- **Rollback Support**: Failed migrations automatically roll back to prevent partial changes

## Architecture

### Files

- **`src/main/database-schema-migrations.js`**: Core migration system with all migration definitions
- **`tests/unit/database-schema-migrations.test.js`**: Comprehensive test suite
- **Integration**: Runs in `src/main/main.js` after database initialization

### Migration Tracking

Migrations are tracked in a `schema_migrations` table:

```sql
CREATE TABLE schema_migrations (
  id TEXT PRIMARY KEY,           -- Unique migration ID
  description TEXT NOT NULL,     -- Human-readable description
  applied_at INTEGER NOT NULL    -- Timestamp when applied
)
```

### Execution Flow

1. Application starts (`src/main/main.js`)
2. Character database initialized (`initializeCharacterDatabase()`)
3. **Migration system checks for pending migrations** (`needsSchemaMigrations()`)
4. If pending migrations exist, they are applied in order (`runSchemaMigrations()`)
5. Each migration is marked as applied in `schema_migrations` table
6. Application continues normal startup

## How to Add a New Migration

### Step 1: Define the Migration

Open `src/main/database-schema-migrations.js` and add a new migration object to the `migrations` array:

```javascript
const migrations = [
  // ... existing migrations ...

  {
    id: '002_add_user_preferences',  // Use sequential numbering
    description: 'Add user preferences table',
    up: (db) => {
      console.log('[Migration 002] Creating user_preferences table...');

      db.exec('BEGIN TRANSACTION');

      try {
        // Your migration SQL here
        db.exec(`
          CREATE TABLE IF NOT EXISTS user_preferences (
            user_id INTEGER PRIMARY KEY,
            theme TEXT DEFAULT 'dark',
            notifications_enabled INTEGER DEFAULT 1,
            FOREIGN KEY (user_id) REFERENCES characters(character_id) ON DELETE CASCADE
          )
        `);

        db.exec('COMMIT');
        console.log('[Migration 002] Successfully created user_preferences table');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Migration 002] Migration failed:', error);
        throw error;
      }
    },
    down: (db) => {
      // Optional: Define rollback logic
      console.log('[Migration 002] Rollback not implemented');
    }
  }
];
```

### Step 2: Migration ID Naming Convention

Use the format: `NNN_descriptive_name`

- **NNN**: Sequential 3-digit number (001, 002, 003, etc.)
- **descriptive_name**: Snake_case description of what the migration does

Examples:
- `001_assets_item_id_to_text`
- `002_add_user_preferences`
- `003_add_market_cache_indexes`

### Step 3: Write the Migration Logic

The `up` function receives a database instance (`db`) and should:

1. **Log the start**: `console.log('[Migration NNN] Starting...')`
2. **Check preconditions**: Verify table/column existence if needed
3. **Use transactions**: Wrap changes in `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK`
4. **Handle errors**: Catch errors and rollback on failure
5. **Log completion**: `console.log('[Migration NNN] Complete')`

### Step 4: Write Tests

Add test cases to `tests/unit/database-schema-migrations.test.js`:

```javascript
describe('Migration 002: user preferences table', () => {
  const migration = migrations[1]; // Array index for your migration

  it('should create user_preferences table', () => {
    migration.up(db);

    const table = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='user_preferences'
    `).get();

    expect(table).toBeDefined();
  });

  it('should be idempotent', () => {
    // Should not error if run twice
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
  });
});
```

### Step 5: Test Your Migration

Run the test suite:

```bash
npm test -- tests/unit/database-schema-migrations.test.js
```

Run all tests to ensure no regressions:

```bash
npm test
```

### Step 6: Test in Development

Run the application in development mode to verify the migration runs correctly:

```bash
npm run dev
```

Check the console output for migration logs.

## Migration Best Practices

### 1. Always Use Transactions

Wrap your changes in a transaction to ensure atomicity:

```javascript
db.exec('BEGIN TRANSACTION');
try {
  // Your changes here
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
```

### 2. Be Defensive

Check if tables/columns exist before attempting changes:

```javascript
const tableExists = db.prepare(`
  SELECT name FROM sqlite_master WHERE type='table' AND name='my_table'
`).get();

if (!tableExists) {
  console.log('[Migration] Table does not exist, skipping');
  return;
}
```

### 3. Preserve Data

When altering tables, ensure data is preserved:

```javascript
// SQLite doesn't support ALTER COLUMN, so:
// 1. Create new table with correct schema
// 2. Copy data from old table
// 3. Drop old table
// 4. Rename new table
// 5. Recreate indexes/foreign keys
```

### 4. Make Migrations Idempotent

Use `IF NOT EXISTS` / `IF EXISTS` to allow migrations to run multiple times safely:

```javascript
db.exec(`
  CREATE TABLE IF NOT EXISTS my_table (...)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_my_index ON my_table(column)
`);
```

### 5. Handle Large Datasets

For tables with large amounts of data, consider:
- Progress logging
- Chunked processing
- Performance implications

### 6. Test Thoroughly

- Test on empty database (new installs)
- Test on database with existing data
- Test idempotency (running migration twice)
- Test rollback on errors
- Test with edge cases (null values, large values, etc.)

## Common Migration Patterns

### Adding a New Table

```javascript
{
  id: '00X_add_my_table',
  description: 'Add my_table for feature X',
  up: (db) => {
    db.exec('BEGIN TRANSACTION');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS my_table (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_my_table_name ON my_table(name)
      `);

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
```

### Adding a Column

```javascript
{
  id: '00X_add_column_to_table',
  description: 'Add new_column to existing_table',
  up: (db) => {
    db.exec('BEGIN TRANSACTION');
    try {
      // Check if column already exists
      const pragma = db.pragma('table_info(existing_table)');
      const columnExists = pragma.some(col => col.name === 'new_column');

      if (!columnExists) {
        db.exec(`
          ALTER TABLE existing_table ADD COLUMN new_column TEXT
        `);
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
```

### Changing Column Type

SQLite doesn't support `ALTER COLUMN`, so you need to recreate the table:

```javascript
{
  id: '00X_change_column_type',
  description: 'Change column_name from INTEGER to TEXT',
  up: (db) => {
    db.exec('BEGIN TRANSACTION');
    try {
      // 1. Create new table with correct schema
      db.exec(`
        CREATE TABLE my_table_new (
          id TEXT PRIMARY KEY,  -- Changed from INTEGER
          name TEXT NOT NULL
        )
      `);

      // 2. Copy data (convert types as needed)
      db.exec(`
        INSERT INTO my_table_new
        SELECT CAST(id AS TEXT), name
        FROM my_table
      `);

      // 3. Drop old table
      db.exec('DROP TABLE my_table');

      // 4. Rename new table
      db.exec('ALTER TABLE my_table_new RENAME TO my_table');

      // 5. Recreate indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_my_table_name ON my_table(name)
      `);

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
```

### Adding an Index

```javascript
{
  id: '00X_add_index',
  description: 'Add index on frequently queried column',
  up: (db) => {
    db.exec('BEGIN TRANSACTION');
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_my_table_column
        ON my_table(column)
      `);

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
```

### Data Migration

```javascript
{
  id: '00X_migrate_data',
  description: 'Migrate data from old format to new format',
  up: (db) => {
    db.exec('BEGIN TRANSACTION');
    try {
      // Example: Split full_name into first_name and last_name
      const rows = db.prepare('SELECT id, full_name FROM users').all();

      const updateStmt = db.prepare(`
        UPDATE users SET first_name = ?, last_name = ?
        WHERE id = ?
      `);

      for (const row of rows) {
        const [firstName, lastName] = row.full_name.split(' ');
        updateStmt.run(firstName, lastName || '', row.id);
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
```

## Troubleshooting

### Migration Failed During Development

If a migration fails during development:

1. Check the console logs for error details
2. Fix the migration code
3. Manually delete the migration from `schema_migrations` table:
   ```sql
   DELETE FROM schema_migrations WHERE id = '00X_my_migration';
   ```
4. Restart the application to retry

### Migration Failed in Production

If a migration fails in production:

1. The transaction rollback prevents partial changes
2. Application will not start until migration succeeds
3. Fix the migration code in a hotfix release
4. Users will apply the fixed migration on next update

### Checking Migration Status

You can check which migrations have been applied:

```javascript
const { getMigrationStatus } = require('./src/main/database-schema-migrations');

const status = getMigrationStatus();
console.log('Applied migrations:', status.appliedList);
console.log('Pending migrations:', status.pendingList);
```

## Example: Migration 001

The first migration converts the `assets` table `item_id` column from INTEGER to TEXT. This is necessary because ESI item IDs are 64-bit integers that can exceed JavaScript's safe integer range.

See the full implementation in `src/main/database-schema-migrations.js` and tests in `tests/unit/database-schema-migrations.test.js`.

Key features demonstrated:
- Schema detection (checking current column type)
- Conditional execution (skip if already TEXT)
- Table recreation pattern for SQLite ALTER limitations
- Dynamic column detection for flexible copying
- Comprehensive error handling
- Transaction safety

## Questions?

For questions about the migration system, refer to:
- This document: `DATABASE_MIGRATIONS.md`
- Source code: `src/main/database-schema-migrations.js`
- Tests: `tests/unit/database-schema-migrations.test.js`
- Project instructions: `CLAUDE.md`
