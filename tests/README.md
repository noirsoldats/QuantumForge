# Quantum Forge Tests

This directory contains tests for Quantum Forge, focusing on validating the Eve Online SDE database schema and ensuring application functionality doesn't break when Fuzzwork updates the SDE.

## Test Structure

```
tests/
├── sde/                          # SDE schema and data validation tests
│   ├── schema.test.js            # Table and column structure validation
│   ├── items.test.js             # Known items data validation
│   ├── blueprints.test.js        # Blueprint query validation
│   ├── structures.test.js        # Structure and rig query validation
│   ├── calculations.test.js      # Integration tests for app functions
│   └── fixtures/
│       └── known-items.js        # Test data constants (known Eve items)
└── README.md                     # This file
```

## Running Tests

### Prerequisites

1. **SDE Database Required**: Tests require a downloaded SDE database in the standard Quantum Forge location:
   - **Mac**: `~/Library/Application Support/Quantum Forge/sde/eve-sde.db`
   - **Windows**: `%APPDATA%\Quantum Forge\sde\eve-sde.db`
   - **Linux**: `~/.config/Quantum Forge/sde/eve-sde.db`

   **To download the SDE**: Run Quantum Forge and use the Settings to download the SDE, or manually download from Fuzzwork and place it in the above location.

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Electron Mock**: Tests use a mocked Electron environment (`tests/setup.js`) so they can run in Node.js without requiring a full Electron instance.

4. **Native Module Rebuilding**: The test suite automatically rebuilds `better-sqlite3` for Node.js before tests run, then rebuilds it back for Electron after tests complete. This happens automatically via `pretest` and `posttest` hooks.

### Test Commands

```bash
# Run all tests
npm test

# Run only SDE tests
npm run test:sde

# Run tests in watch mode (auto-rerun on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

## Test Categories

### 1. Schema Validation (`schema.test.js`)

Tests that verify the SDE database contains all required tables and columns.

**Purpose**: Detect if Fuzzwork changes table names, column names, or removes critical tables.

**Tests Include**:
- Required tables exist (invTypes, invGroups, industryActivityMaterials, etc.)
- Critical columns exist in each table
- Primary keys are correctly defined
- Foreign key relationships are intact

**When to Run**: After every SDE update from Fuzzwork.

### 2. Known Items Data (`items.test.js`)

Tests that verify well-known Eve items have expected data.

**Purpose**: Ensure fundamental Eve items (like Tritanium, Veldspar, Scourge Missiles) still have correct names, IDs, and classifications.

**Tests Include**:
- Basic materials (Tritanium, Isogen, etc.) exist with correct names
- Ships (Raven, Rifter) are properly categorized
- Tech levels (T1/T2/T3) are correctly identified via metaGroupID
- Volume data is available and correct

**When to Run**: After every SDE update, before releasing a new version.

### 3. Blueprint Queries (`blueprints.test.js`)

Tests that verify blueprint-related queries return expected data.

**Purpose**: Ensure blueprint manufacturing calculations don't break.

**Tests Include**:
- Blueprint products can be queried
- Blueprint materials can be retrieved
- Manufacturing activityID (1) is still valid
- Meta group detection works (T1/T2/T3 blueprints)
- Category classification is accurate
- Reverse blueprint lookup (product → blueprint) works

**When to Run**: Before using the Blueprint Calculator with a new SDE.

### 4. Structure/Rig Queries (`structures.test.js`)

Tests that verify structure and rig data is available and correct.

**Purpose**: Ensure facility management and bonus calculations work.

**Tests Include**:
- Structure types (Raitaru, Athanor) exist
- Structure rigs exist with attributes
- dgmTypeAttributes queries work
- Structure/rig attribute bonuses can be calculated

**When to Run**: Before using facilities with a new SDE.

### 5. Integration Tests (`calculations.test.js`)

Tests that verify actual application functions work end-to-end.

**Purpose**: Catch integration issues between SDE and application logic.

**Tests Include**:
- `getBlueprintMaterials()` returns valid data
- `getBlueprintProduct()` works
- `getTypeName()` lookups work
- `getAllBlueprints()` returns complete data with meta info
- Volume calculations work
- System security lookups work
- Regression tests for previous bugs (T2 detection, category classification)

**When to Run**: As part of CI/CD, before every release.

## Test Fixtures

The `fixtures/known-items.js` file contains well-known Eve Online items that should never change:

- **Materials**: Tritanium, Isogen, etc.
- **Ores**: Veldspar, Scordite
- **Ammunition**: Scourge Heavy Missile (T1), Scourge Fury (T2)
- **Ships**: Raven, Rifter
- **Structures**: Raitaru, Athanor
- **Rigs**: M-Set Material Efficiency rigs
- **Locations**: Jita, Amarr

These items serve as known-good data points for validation.

## When Tests Fail

### Schema Changed

If `schema.test.js` fails:
1. Check which table/column is missing
2. Verify Fuzzwork didn't rename or remove it
3. Update application code to use new schema
4. Update tests if schema legitimately changed

### Data Changed

If `items.test.js` fails:
1. Verify the item still exists in Eve Online
2. Check if CCP renamed or reclassified the item
3. Update fixtures if item legitimately changed
4. Update application code if needed

### Queries Broken

If `blueprints.test.js` or `structures.test.js` fails:
1. Check if query syntax needs updating
2. Verify foreign key relationships still exist
3. Update application queries
4. Update tests to match new schema

### Integration Failures

If `calculations.test.js` fails:
1. Check previous test categories first (schema, data, queries)
2. Debug the specific function that failed
3. Verify SDE path is correct
4. Ensure SDE database is not corrupted

## Adding New Tests

When adding new SDE-dependent features:

1. **Add to fixtures**: If using new items, add them to `fixtures/known-items.js`
2. **Add schema tests**: If using new tables, add to `schema.test.js`
3. **Add query tests**: Create tests for new query patterns
4. **Add integration tests**: Test the full feature end-to-end

## Coverage Goals

- **Schema Tests**: 100% of critical tables and columns
- **Known Items**: All major item types represented
- **Blueprint Queries**: All query patterns used in production
- **Integration**: All public API functions tested

## Continuous Integration

These tests are designed to run in CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run SDE Tests
  run: |
    # Download latest SDE
    npm run sde:download
    # Run tests
    npm test
```

## Debugging Failed Tests

Enable verbose output:
```bash
npm test -- --verbose
```

Run a single test file:
```bash
npm test tests/sde/schema.test.js
```

Run tests matching a pattern:
```bash
npm test -- --testNamePattern="Tritanium"
```

## Performance

- Full test suite: ~5-10 seconds
- Schema tests only: ~1-2 seconds
- Individual test file: <1 second

Tests use `better-sqlite3` for synchronous queries, which is faster than `sqlite3` for test scenarios.

## Notes

- Tests require Electron environment for `app.getPath('userData')`
- Tests use readonly database connections (no modifications)
- Tests do not require ESI authentication
- Tests do not require market data
- Tests can run offline (after SDE is downloaded)
