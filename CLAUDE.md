# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Quantum Forge is an Electron-based desktop application for managing Eve Online industrial operations. It provides manufacturing management, resource tracking, production analytics, and market data analysis.

**Tech Stack**: Electron (main/renderer/preload architecture), vanilla JavaScript, SQLite databases (better-sqlite3 and sqlite3), Eve Online ESI API integration

## Development Commands

### Running the Application
```bash
npm start              # Run in production mode
npm run dev            # Run in development mode (opens DevTools)
```

### Building
```bash
npm run build          # Build for current platform
npm run build:win      # Build for Windows
npm run build:mac      # Build for macOS
npm run build:linux    # Build for Linux
npm run build:all      # Build for all platforms
```

### Testing
```bash
npm test               # Run all tests (auto-rebuilds better-sqlite3)
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Run tests with coverage report
npm run test:sde       # Run only SDE-related tests
```

**Run a single test file:**
```bash
npm test -- path/to/test.test.js
npm test -- tests/unit/blueprint-calculator-pure.test.js
```

**Run tests matching a pattern:**
```bash
npm test -- --testNamePattern="invention"
```

### Database Rebuilds
```bash
npm run rebuild:node      # Rebuild better-sqlite3 for Node.js (used in tests)
npm run rebuild:electron  # Rebuild better-sqlite3 for Electron (used in app)
npm run rebuild           # Rebuild for Electron
```

**Important**: Tests automatically run `rebuild:node` before and `rebuild:electron` after to ensure correct bindings.

### Dependencies
```bash
npm install            # Install all dependencies (runs postinstall: electron-builder install-app-deps)
```

## Architecture

### Electron Process Architecture

The application follows standard Electron architecture with three key components:

1. **Main Process** (`src/main/main.js`): Node.js environment that controls application lifecycle, creates windows, and handles IPC communication
2. **Renderer Process** (`src/renderer/*.js`, `public/*.html`): Browser environment for UI rendering
3. **Preload Scripts** (`src/preload/preload.js`): Bridge between main and renderer via `contextBridge`, exposing the `electronAPI` to renderers

### IPC Communication Pattern

All main-renderer communication uses IPC handlers registered in `src/main/main.js`:
- Renderer invokes via `window.electronAPI.<namespace>.<method>(args)`
- Main handles via `ipcMain.handle('<namespace>:<action>', handler)`
- Preload exposes via `contextBridge.exposeInMainWorld('electronAPI', {...})`

**Example**: Character authentication flow uses `esi:authenticate`, `esi:getCharacters`, etc.

### Key Subsystems

**Settings Manager** (`src/main/settings-manager.js`):
- Manages application configuration stored in `quantum_config.json` in userData directory
- Handles character data, market settings, blueprint ownership, skill overrides
- Characters include ESI OAuth tokens (access token, refresh token) managed by `esi-auth.js`

**SDE (Static Data Export) Management** (`src/main/sde-manager.js`, `src/main/sde-database.js`):
- Downloads and manages Eve Online's Static Data Export from Fuzzwork (bzip2 compressed SQLite)
- Provides type names, blueprint data, skill information, regions, systems, stations
- Two database libraries: `sqlite3` (async callbacks) in `sde-database.js`, `better-sqlite3` (synchronous) in `blueprint-calculator.js`
- SDE stored in userData/sde directory with version tracking

**ESI Integration** (`src/main/esi-*.js`):
- OAuth authentication flow with Eve SSO (`esi-auth.js`)
- Fetches character skills, blueprints, market orders, market history, cost indices
- Token refresh handled automatically when expired
- Market data cached in local SQLite database (`market-database.js`)

**Blueprint Calculator** (`src/main/blueprint-calculator.js`, `src/renderer/blueprint-calculator-renderer.js`):
- Calculates manufacturing material requirements from SDE
- Applies Material Efficiency (ME) reductions
- Considers character's owned blueprints and skill bonuses
- Supports facility bonuses (structure types and rigs)
- **Important**: `calculateBlueprintMaterials` is async and returns materials as an **object** with typeIDs as keys: `{ 34: 50, 35: 25 }`, not an array

**Invention System** (`src/main/blueprint-calculator.js`):
- `getInventionData(blueprintTypeId, db)` - accepts optional database parameter for testing
- Returns invention data with convenience properties: `t2BlueprintTypeID`, `t2ProductTypeID`, `baseProbability`, plus full `products` array
- `calculateInventionProbability` - applies skill and decryptor modifiers
- `calculateInventionCost` - includes datacores, decryptors, and job costs
- `findBestDecryptor` - optimizes decryptor selection based on strategy (invention-only, profit-per-run, profit-per-attempt, time-efficiency, max-runs)
- Activity ID 8 = invention in SDE database

**Market Pricing** (`src/main/market-pricing.js`):
- Multiple pricing methods: VWAP, percentile, historical average, hybrid, immediate
- Price overrides system for manual price setting
- Integrates ESI market data and Fuzzwork API as fallback
- Confidence indicators based on volume and data freshness
- **Important**: Uses `fetchMarketData(regionId, typeId)` which returns `{ orders: [...], history: [...] }`

**Manufacturing Facilities** (`src/main/settings-manager.js` facilities section):
- Define manufacturing locations with system, structure type, and rigs
- Calculate bonuses: material reduction, time reduction, cost reduction
- Structure bonuses queried from SDE (invTypes, dgmTypeAttributes, dgmAttributeTypes)

### Window Management

**Multi-window Application**:
- Main window (`public/index.html`): Dashboard/navigation hub
- Settings window (`src/main/settings-window.js`, `public/settings.html`): Modal window for configuration
- Skills window (`src/main/skills-window.js`, `public/skills.html`): Character skill viewer per character
- Blueprints window (`src/main/blueprints-window.js`, `public/blueprints.html`): Blueprint library per character
- Manufacturing Plans window (`src/main/manufacturing-plans-window.js`, `public/manufacturing-plans.html`): Plan management and tracking
- Market page (loaded into main window): Market data viewer and pricing configuration
- Blueprint Calculator page (loaded into main window): Manufacturing calculator
- Facilities page (loaded into main window): Facility manager

**Window State**: Window positions/sizes persisted via `window-state-manager.js`

### Data Storage

**User Data Location**: `app.getPath('userData')` (platform-specific)
- `quantum_config.json`: All application settings
- `sde/eve-sde.db`: Eve Online static data
- `sde/version.txt`: SDE version tracking
- `market-data.db`: Cached market orders and history
- `character-data.db`: Per-character data including manufacturing plans, industry jobs, wallet transactions

**Settings Structure**:
```javascript
{
  general: { theme, notifications, etc. },
  accounts: { characters: [{ characterId, name, tokens, skills, blueprints, skillOverrides }] },
  market: { locationType, locationId, regionId, systemId, inputMaterials, outputProducts },
  owned_blueprints: [...],
  manufacturing_facilities: [{ id, name, systemId, structureTypeId, rigs, isDefault }]
}
```

## Important Implementation Details

### Database Connection Patterns

- **SDE Database (sde-database.js)**: Uses `sqlite3` with async callbacks, maintains singleton connection via `getDatabase()`
- **SDE Database (blueprint-calculator.js)**: Uses `better-sqlite3` synchronous API, creates/closes connections per operation
- **SDE Database (functions accepting db parameter)**: Many calculation functions accept optional `db` parameter for testing; only close connection if we opened it (`ownConnection` pattern)
- **Market Database**: Uses `better-sqlite3`, initialized once at app start via `initializeMarketDatabase()`

### Character & Blueprint Management

- Characters authenticated via Eve SSO flow returning OAuth tokens
- Skills and blueprints fetched from ESI and cached locally with timestamps
- Skill overrides allow "what-if" planning without affecting ESI data
- Blueprint overrides customize ME/TE levels beyond character's actual blueprints
- Default character system affects which character's blueprints/skills are used in calculations

### Market Data Refresh

- Market data has TTL (time-to-live) before automatic refresh
- Manual refresh available via UI (`manualRefreshMarketData`, `manualRefreshHistoryData`)
- Progress events sent via IPC during bulk downloads
- Fuzzwork API used as fallback when ESI data unavailable

### Navigation Pattern

Main window loads different pages by changing `window.location.href`:
- `index.html` → main dashboard
- `market.html` → market settings and viewer
- `blueprint-calculator.html` → manufacturing calculator
- `facilities.html` → facility manager

Secondary windows are separate BrowserWindow instances (Settings, Skills, Blueprints).

## Common Development Patterns

### Adding New IPC Handlers

1. Register handler in `src/main/main.js`: `ipcMain.handle('namespace:action', handler)`
2. Expose in `src/preload/preload.js`: Add method to appropriate namespace in `electronAPI`
3. Call from renderer: `await window.electronAPI.namespace.action(args)`

### Calling an existing IPC method — check the contract, don't infer it

**Before calling any `electronAPI` method, read the handler's parameter list and
the destructure it performs.** IPC is untyped and silent: a wrong argument
position or a misspelled payload key throws nothing, logs nothing, and leaves a
`undefined` where a real value belonged. Every instance below shipped, and
every one was invisible until someone read the handler.

Three things to verify, in this order:

**1. Positional vs. object.** Some methods take positional arguments, not a
config object. `plans.create(characterId, planName, description)` is
positional — passing `{ name }` puts the object in the `characterId` slot,
drops the name, and creates a plan against a nonsense owner under an
auto-generated name. It still "succeeds".

**2. Payload keys must match the destructure exactly.**
`addBlueprintToPlan` destructures `{ blueprintTypeId, runs, lines, meLevel,
teLevel, facilityId, facilitySnapshot }`. Anything else is dropped on the
floor:

```js
// WRONG - none of these three keys are read
{ productionLines: 3, materialEfficiency: 10, timeEfficiency: 20 }
// RIGHT
{ lines: 3, meLevel: 10, teLevel: 20 }
```

`productionLines` cost Manufacturing Plans its Production Lines input — the
user's value was discarded and every blueprint went in on one line.
`materialEfficiency` meant every blueprint added from Manufacturing Summary
carried an **undefined ME**.

**3. Filter arguments are not optional just because they can be omitted.**
`plans.getAll(characterId)` filters on `character_id`. Calling `getAll()` with
no argument returns an empty list, so a plan dropdown shows nothing and reads
as "no plans exist".

**Return shapes count too.** `loot:getCharacterSkills` returns an ENVELOPE —
`{ found, skills }` — not the map. `cleanupTool:refreshAssets` reports
per-character failures in `errors[]` and leaves `success: true`, so checking
`success === false` alone silently swallows them.

**Test mocks must mirror the real signature.** Every bug above survived a green
suite because the mock accepted whatever the renderer happened to send:

```js
// WRONG - accepts any shape, so the assertion enshrines the bug
create: async (data) => { calls.push({ data }); return { planId: 'p1' }; }
// RIGHT - the real signature; a wrong call now fails loudly
create: async (characterId, planName, description) => { ... }
```

This is the same failure mode as inventing fixture column types or database
mock shapes (see **Mock Patterns** below), applied to the IPC boundary.

### Querying SDE Data

Always check if SDE exists before querying:
```javascript
const { sdeExists } = require('./sde-manager');
if (!sdeExists()) {
  // Handle missing SDE
}
```

Use appropriate database library based on module context.

### Working with ESI API

- Check token expiration before API calls: `isTokenExpired(character.tokenExpiry)`
- Refresh if needed: `refreshAccessToken(character.refreshToken)`
- Handle ESI rate limiting (error status 420)
- Cache responses when appropriate to reduce API load

### Manufacturing Plans System

**Overview**: Multi-tab planning and tracking system for managing industrial operations, combining planned blueprints with actual ESI data.

**Core Modules** (`src/main/`):
- `manufacturing-plans.js` - Plan CRUD operations, blueprint management, material/product calculation, summary analytics
- `plan-matching.js` - Heuristic-based matching of ESI jobs/transactions to plans with confidence scoring
- `esi-industry-jobs.js` - Fetch and cache character industry jobs from ESI
- `esi-wallet.js` - Fetch and cache character wallet transactions from ESI
- `character-database.js` - Database schema with 10 tables for plans, blueprints, materials, products, jobs, transactions, matches

**Database Tables** (in `character-data.db`):
- `manufacturing_plans` - Plan metadata (name, description, status, timestamps)
- `plan_blueprints` - Blueprints in plan with runs, lines, ME/TE, facility snapshot
- `plan_materials` - Aggregated materials with frozen prices
- `plan_products` - Aggregated products with frozen prices
- `industry_jobs` - Cached ESI industry jobs per character
- `wallet_transactions` - Cached ESI wallet transactions per character
- `plan_job_matches` - Job-to-blueprint matches with confidence scores
- `plan_transaction_matches` - Transaction-to-material/product matches with confidence scores

**Key Features**:

1. **Plan Management**:
   - Create/update/delete manufacturing plans
   - Status workflow: active → completed → archived
   - Per-character plan organization

2. **Blueprint Configuration**:
   - Add blueprints with runs, production lines, ME/TE levels
   - Facility snapshot (frozen at blueprint add time to preserve historical data)
   - Automatic material/product aggregation across all blueprints
   - Price freezing at blueprint add time (manual refresh available)

3. **Smart Matching System**:
   - Heuristic-based confidence scoring (0.0 - 1.0 scale)
   - Job matching criteria: blueprint type (+0.3), exact runs (+0.4), facility (+0.3), time window (+0.2), recent (+0.1)
   - Transaction matching criteria: type (+0.3), direction (+0.3), price within 20% (+0.3), timing (+0.1)
   - User confirmation required (pending → confirmed/rejected)
   - Only confirmed matches count toward actuals

4. **Analytics & Tracking**:
   - Progress metrics: job completion, material purchases, product sales, overall completion
   - Planned vs Actual comparisons: material costs, product value, profit, ROI
   - Color-coded deltas (green = better than planned, red = worse)
   - Visual progress bars for completion tracking

5. **Auto-Refresh**:
   - Open plans re-match every 5 minutes against already-fetched ESI data (no network call)
   - ESI fetching itself is driven by the main-process background cycle
     (`esi-background-refresh.js`), not this timer
   - Only the Jobs and Transactions tabs are reloaded; other tabs are not refreshed
   - Manual refresh button available in Analytics tab (does an explicit fetch + match)

**UI Tabs** (`public/manufacturing-plans.html`, `src/renderer/manufacturing-plans-renderer.js`):
- **Overview**: Summary stats (material cost, product value, profit, ROI), plan description
- **Blueprints**: List of blueprints in plan with configuration details, add/remove buttons
- **Materials**: Shopping list with optional owned assets (personal/corp), price refresh
- **Products**: Expected output products with quantities and values
- **Jobs**: Pending/confirmed industry job matches with confidence badges, approve/reject actions
- **Transactions**: Pending/confirmed wallet transaction matches with confidence badges
- **Analytics**: Progress bars, planned vs actual comparison cards

**Error Handling & UX**:
- Loading overlay with spinner for async operations
- Toast notifications for success/error/warning/info messages
- Confirmation dialogs for destructive actions (delete plan, remove blueprint, etc.)
- Tooltips on key buttons explaining functionality
- Graceful error handling with user-friendly messages

### Price Calculation Flow

1. Check for manual price override first (`getPriceOverride`)
2. Fetch market data from cache or ESI (`fetchMarketData`)
3. Apply pricing method (VWAP/percentile/historical/hybrid/immediate)
4. Apply price modifiers from market settings
5. Return price with confidence indicator and metadata

## UI Redesign Conventions

Binding rules for the UI overhaul (porting the `Quantum Forge UI Redesign/` mockups). Each one
cost real debugging time in the mockup project — treat them as non-negotiable, not stylistic
preferences.

### 1. Row highlights use `box-shadow` only — never a toggled background

A `background-color` set on a row highlighted on its **first paint** does not clear reliably; the
inline-style diff leaves the tint stuck even when the next style sets `transparent`. `box-shadow`
toggles cleanly.

```css
/* on  */ box-shadow: inset 0 0 0 200px var(--qf-accent-dim), inset 3px 0 0 var(--qf-accent);
/* off */ box-shadow: none;
```

Keep `background-color: transparent` constant in the base. Never drive a row highlight with a
toggled `background` / `background-color`.

### 2. Keyboard-combobox highlight index lives on a plain instance field

Keep the moving highlight index on an instance field (`this.hiIndex`), mutate it synchronously in
the handler, then **move the highlight in place — never re-render the list** (see 2a).
**Start it at `-1`** so no row is highlighted on first paint — a row hot on first paint is exactly
what triggers rule 1. Reset to `-1` on open, close, query change, and select.

Standard contract to replicate everywhere: ↑/↓ move (first press opens and selects row 0), Enter
confirms the highlighted row (opens first if closed), Esc closes, mouse hover syncs the index.

### 2a. Moving the highlight must NOT rebuild the rows

**A `mouseenter` handler that re-renders the list makes the list unclickable by mouse.** A click
requires mousedown *and* mouseup on the same element, and `mouseenter` always fires first — so
rebuilding the rows destroys the element the mousedown landed on and the browser never delivers
the click. Keyboard selection keeps working, which is why this hides easily.

Toggle the class on the existing elements instead, and scroll the active row into view:

```js
function moveComboHighlight(host, index) {
  const rows = [...host.querySelectorAll('.combo-row')];
  rows.forEach((row, i) => {
    const on = i === index;
    row.classList.toggle('is-hi', on);
    row.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  rows[index]?.scrollIntoView({ block: 'nearest' });
}
```

Applies to **both** hover and ↑/↓ — a full re-render on arrow keys also discards scroll position
and every row listener for no benefit. Only rebuild when the row *set* changes (new query, new
results), never when only the selection moves.

`QFSearchSelect` already does this correctly (`_syncHighlight` + `_scrollHighlightIntoView`);
it is the reference. Testing note: assert **element identity across the hover**
(`after[0] === before[0]`), not just that the class moved — re-querying the DOM after a rebuild
passes while the bug is present.

### 3. Conditional styles must be symmetric

Both branches of any `cond ? A : B` style string must set the **same set of properties**, using
longhands (`background-color`, `background-image`, `border-color`, `box-shadow`) rather than
shorthands. A property set in only one branch never resets, and the highlight sticks.

### 4. Text input recipe

Raw `<input type="text|number">` and `<textarea>` must match the select/dropdown triggers sitting
beside them:

- `background: var(--qf-surface-sunken)` — **not** `--qf-surface`, which is nearly invisible on an
  elevated card and reads as "no background"
- `border: 1px solid var(--qf-border)`, `border-radius: var(--qf-radius-md)`
- `color: var(--qf-text-primary)`, `font-size: var(--qf-text-sm)`, padding `8px 12px`
- Mono fields (ISK, ME/TE, runs) add `font-family: var(--qf-font-mono)`
- Numeric fields (tax %, ME, runs) get an explicit small width — never full-bleed across a row

### 5. One shared searchable dropdown

All searchable dropdowns are the single shared `QFSearchSelect`
(`public/shared/qf-search-select.js`). **Never fork or re-implement it** — edit the shared file so
every screen stays identical. Non-searchable dropdowns with roughly five or fewer fixed options
stay a plain `<select class="qf-select">`.

It covers **both** shapes:

```js
// Fixed list — filters in memory
new QFSearchSelect(host, { options, value, onChange });

// Remote/async — the component owns debounce, out-of-order responses, and the
// loading / "type to search" / "no matches" states; you only run the query
new QFSearchSelect(host, {
  onSearch: (q) => searchSomething(q),   // -> Promise<options>
  minQueryLength: 2,
  debounceMs: 200,
});
```

If it does not do what a screen needs, **extend the shared component** — do not hand-roll a
local one. Hand-rolling is what reintroduced the rule-2a bug: the shared component never had it.

**Lifecycle:** each instance owns a document-level `mousedown` listener and can attach a popover
to `<body>`, so removing its container is not enough. Call `destroy()` when the form rebuilds or
the modal closes, and route *every* close path (X, Cancel, backdrop click, Escape) through the
same teardown. `market-view-renderer.js` (`searchSelectField` / `destroySearchSelects`) is the
reference implementation.

### 6. Keep the box-sizing rule

```css
.qf-input, .qf-select { box-sizing: border-box; }
```

Inputs overflow their containers without it. Do not drop it.

### 6a. `hidden` loses to any explicit `display`

The `hidden` attribute is only `display: none` at the **browser-default** level, so any
rule that sets `display` — `flex`, `grid`, `block` — overrides it and the element stays
visible. This has now shipped as a bug twice: the Market modals, and the Blueprint
Calculator opening straight into its Add to Plan modal with the empty state and both tab
panels rendered on top of each other.

Whenever an element is toggled with `el.hidden = …`, its CSS must win `hidden` back:

```css
/* per-view catch-all — preferred, covers every element in the view */
#my-view [hidden] { display: none !important; }

/* or per-class, if the view has only one such element */
.my-panel[hidden] { display: none; }
```

`.modal[hidden]` is already handled in `shared/components.css`. **jsdom does not apply
stylesheets**, so `expect(el.hidden).toBe(true)` passes while the user sees the element —
a renderer test cannot catch this. Assert against the stylesheet text instead.

### 6b. `styles.css` styles bare TAGS — they leak into ported views

`styles.css` predates the view system and styles two bare element tags:

```css
header { background: rgba(0,0,0,0.5); padding: …; border-bottom: 2px solid …; }  /* :161 */
header h1 { …gradient text fill… }                                               /* :168 */
main { … }                                                                       /* :185 */
```

Every view is loaded into `index.html`, which loads `styles.css`. A `<header>` inside a view
therefore picks up a full-bleed **page** header — dark wash, 2px border, page-scale padding —
**by tag name, with no class involved**. This shipped on ESI Status as a dark background behind
the character name, and `header h1` was simultaneously fighting the view's own title rule.

**Use `<div>` (or `<section>`) for in-view headers, not `<header>`.** A semantic `<header>` is
only safe if the view's own rule overrides `background`, `padding` *and* `border` — relying on
that is fragile, since a rule that merely sets layout leaves the wash in place. Do **not** fix
this by editing `styles.css`: every un-ported page still depends on those rules.

Known outstanding instance: `.fac-list-head` (`facilities-view.css:348`) sets neither
`background` nor `padding` and is carrying the wash today.

### 6c. Never put `display: flex`/`grid` on a `<td>` or `<th>`

A cell set to `display: flex` (or `grid`, or `block`) **stops being a table-cell**. It leaves the
table's internal box model, the browser wraps it in an *anonymous* table-cell to keep the row
valid, and the flex box sits inside that as an ordinary block. The cell then no longer shares
column widths or vertical alignment with the `<th>` above it or the other `<td>`s in its own row.

This shipped on the Manufacturing Plans **Materials** tab: `.mp-acq-cell` was a `<td>` with
`display: flex` to stack its pills, and the Acquisition column drifted out of line with its row.
It reads as *intermittent* — the anonymous cell sizes to that row's own content, so a one-pill
row, a two-pill row and a "Not Acquired" row each drift by a different amount.

**Stack or lay out inside a wrapper `<div>`, and leave the cell alone:**

```js
const cell = el('td', 'mp-acq-cell');      // stays a real table-cell
const stack = el('div', 'mp-acq-stack');   // flex lives HERE
cell.appendChild(stack);
```
```css
.mp-acq-cell  { text-align: center; }                        /* no display! */
.mp-acq-stack { display: flex; flex-direction: column; }
```

The same applies to a full-width row: give the `<td colSpan>` a `<div>` child rather than making
the cell itself a flex container.

**Use a real `<table>` for tabular data** — the browser sizes each column across every row at
once, which per-row grids cannot do, and which is why alignment kept fighting us here. The cell
rule above is the price of admission.

Testing note: **jsdom does not do layout**, so no renderer test can observe the misalignment.
Assert against the stylesheet text — that `.mp-acq-cell`'s rule declares no
`display: flex|grid|block` — and assert in the DOM that the pills are children of the wrapper,
not of the `<td>`.

To sweep for it, intersect every class landing on a `<td>`/`<th>` with every rule declaring a
block-level `display`, matching only where the class is the **last** compound selector (so
descendant rules don't produce false hits). Validate any such scan by confirming it flags a
known-bad revision before trusting a clean result.

### 7. Manufacturing Plan prices are locked

Plan prices are frozen at a user-chosen point and **never auto-update on market refresh**. Only an
explicit "Re-lock Prices" action adopts live prices. Live-data subscriptions may update *drift
indicators* against the locked values, but must never write the locked price itself.

## Testing Patterns

### Test Structure
- `tests/unit/` - Pure unit tests with mocks
- `tests/integration/` - Integration tests using in-memory databases
- `tests/sde/` - Tests requiring actual SDE database

### Common Test Utilities

**Database Mocks** (`tests/unit/helpers/database-mocks.js`):
- `createMockDatabase(fixtures)` - Creates jest mock database
- `createInMemoryDatabase()` - Creates real SQLite in-memory database for integration tests
- `populateDatabase(db, fixtures)` - Populates database with blueprint and invention data
- Supports both blueprint data and invention data via `fixtures.blueprint` and `fixtures.inventionData`

**Important Database Tables**:
- Manufacturing: `industryActivityMaterials`, `industryActivityProducts`, `industryActivity`
- Invention: `industryActivityProbabilities`, `industryActivitySkills` (activityID = 8)
- Types: `invTypes`, `invGroups`

**Settings Mocks** (`tests/unit/helpers/settings-mocks.js`):
- `createMockSettingsManager(data)` - Mocks settings with character/blueprint data

**Test Fixtures** (`tests/unit/fixtures/`):
- `blueprints.js` - Blueprint data (scourgeBlueprint, ravenBlueprint, scourgeFuryBlueprint, scourgeT2InventionData)
- `facilities.js` - Facility configurations (npcStation, raitaruNoRigs, azbel, sotiyo)
- `skills.js` - Character skill sets (basicSkills, advancedSkills)
- `market-data.js` - Market orders and history data

### Test Data Structures

**Materials Format**: Functions return materials as objects, not arrays:
```javascript
// Correct
{ 34: 50, 35: 25, 36: 10 }  // typeID: quantity

// Wrong
[{ typeID: 34, quantity: 50 }, ...]
```

**Async Functions**: Many calculation functions are async:
- `calculateBlueprintMaterials` - MUST use await
- `calculateRealisticPrice` - MUST use await
- `findBestDecryptor` - MUST use await

### Mock Patterns

**ESI Market Mocks**: Mock `fetchMarketData` to return:
```javascript
{
  orders: [{ price, volume_remain, is_buy_order, location_id }],
  history: [{ date, average, volume }]
}
```

**Market Database Mocks**: The `run()` function is called for multiple purposes:
- 1 arg: Delete operation
- 4 args: Price override `(typeId, price, notes, timestamp)`
- 14 args: Price cache `(typeId, locationId, regionId, ...)`

### One big suite sets the floor — split it, share the harness

Jest runs suites in parallel but **cannot split a single file across workers**, so wall clock is
bounded below by the slowest single suite. Two 2,600-4,700 line files were the entire critical
path; splitting them by feature area took the run from ~32s to ~19s.

The harness — fake IPC backend, mount helpers, DOM utilities — lives in
`tests/renderer/helpers/<view>-harness.js`, and each split file does:

```js
const h = require('./helpers/plans-harness');
h.installHooks();                                    // opt-in, not on require
const { state, mountView, openTab, settle } = h;
```

**Fixture state must be reached through a `state` facade of getters/setters**, not bare exported
bindings. The fakes close over the harness's `let` bindings; a test file assigning to an imported
copy could mutate (`state.plans[0].x = 1`) but never REPLACE (`state.plans = []`) — the second
would silently not reach the fake.

`mock-contract.test.js` audits the mock, so its PAIRS entry points at the **harness**, not at any
one split test file.

When splitting, watch for these — each one cost a round of failures:

- A mechanical `foo` → `state.foo` rename must be **string- and comment-aware**. A regex pass
  corrupted test names (`'2 items'` → `'2 state.items'`), prose in comments, and regex literals
  (`/\.mp-materials-frame/` → `/\.mp-state.materials-frame/`). Scan with a tokenizer that tracks
  string/template/comment/regex state, then verify: zero bare refs, zero `state.` inside string
  literals, zero in comments, and the test COUNT unchanged.
- **`...spread`** reads as a property access if you only look at the previous character.
- **Local variables that shadow a fixture name** (`const drift = document.getElementById(…)`)
  become `const state.drift = …`, a syntax error. `node --check` each split file.
- Suites reading files (`fs`/`path` for stylesheet assertions) need those requires re-added.

### Await the work, don't drain the queue

A DOM event handler **cannot be awaited** — the browser discards an event listener's return
value — so clicking a button leaves an `async` handler running with nothing to wait on. The
tempting fix is to drain the macrotask queue a fixed number of times:

```js
// DON'T - slow and only probabilistically correct
async function flush() {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}
```

`12` is a guess. Too low and tests fail intermittently as chains get deeper; too high and every
call burns hops on an idle queue (~1.4ms each in jsdom — this was several seconds per run).

**Instead, give the work a handle.** The renderer registers handler promises and exposes
`whenSettled()`; the test awaits the actual work:

```js
// renderer
const pending = new Set();
function trackPending(result) {
  if (!result || typeof result.then !== 'function') return result;
  pending.add(result);
  result.then(() => pending.delete(result), () => pending.delete(result));
  return result;
}
async function whenSettled() {
  while (pending.size > 0) await Promise.allSettled([...pending]);   // loops: a handler can start another
}
// bind through one choke point so nothing is missed
const bindClick = (id, h) => el.addEventListener('click', (...a) => trackPending(h(...a)));
// register: { title, mount, whenSettled }
```

`market-view-renderer.js` is the reference. Note the loop in `whenSettled` — a save that triggers
a reload adds new work while the first batch is settling.

**Inline `async` listeners bypass the choke point.** An `addEventListener('click', async () => …)`
written by hand is invisible to `bindClick`; wrap it explicitly with
`trackPending((async () => { … })())`. One such listener kept a test failing after every other
case was fixed.

Only 4 of 152 tests in that suite ever needed the draining — the other 148 were paying for it
because `mount()` already awaits its own `loadAll()`. If `await mountView(...)` covers the case,
no flush is needed at all.

### Templates: cache on the document, not the module

View renderers load their markup once and clone it per mount, via
`QFUI.loadViewTemplate(container, url)` (writes into a container) or
`QFUI.loadViewFragment(url, templateId)` (returns a fragment). Cloning measures ~3.3x faster than
re-parsing (12ms → 3.6ms for an 8.6KB view under jsdom), and mounting happens on every navigation
and pop-out, so this is a real app win and not only a test one.

**The cache must live on `window`, not in the module closure.** Renderer suites call
`jest.resetModules()` in `beforeEach`, which wipes a module-scoped cache — so the old per-renderer
`let templateCache = null` re-parsed the view on all ~292 tests of a suite while looking like it
cached. Fixing that one line took `manufacturing-plans-ui` from 32s to 16s.

A renderer using these helpers depends on `QFUI`, so its test suite must
`require('../../public/shared/ui-helpers.js')` — the app gets it from `index.html`, which loads it
before every renderer.

### No test may touch the network

`tests/setup.js` installs a guard that makes any outbound connection throw.
**ESI's error limit is app-wide** and a 4xx costs ~2.5x a success, so a test looping over ESI
burns the real application's budget — on every CI run.

Mock at the module boundary (`jest.mock('../../src/main/esi-fetch')`) or assign `global.fetch`.
If a test genuinely needs a socket, call `global.allowNetwork()` in it and `global.blockNetwork()`
in its `afterEach`; the guard re-blocks before every test regardless.

Two things about the guard that are easy to get wrong if you touch it:

**It lives on `net.Socket.prototype.connect`, not `global.fetch`.** Every renderer suite assigns
its own `global.fetch = jest.fn()` in `beforeEach` to serve view HTML — a guard on `global.fetch`
would be silently overwritten by those, leaving the appearance of protection and none of it. The
socket is the layer undici's `fetch`, `http.request` and `tls.connect` all funnel through.

**It must install exactly once per worker.** Jest runs `setup.js` per test *file*, but files in a
worker share the `net` module, so a naive install stacks wrappers — each closing over its own
flag, so the outer one reports "allowed" while an inner one still throws. Blocking keeps working,
which is what makes this easy to miss; only `allowNetwork()` breaks, and only once a second file
runs in the same worker. The state therefore lives on `Symbol.for('quantumforge.test.networkGuard')`
on the `net` module and the patch is applied only if absent.

`tests/unit/network-guard.test.js` covers all of this, including the stacking regression. Its
escape-hatch test deliberately does **not** open a real listening server: a live handle inside a
jest worker stops the worker exiting and showed up as a hang in the full run.

## Critical Files Reference

- `src/main/main.js` - Application entry point, all IPC handlers
- `src/preload/preload.js` - IPC API surface exposed to renderers
- `src/main/settings-manager.js` - Settings persistence and character management
- `src/main/sde-database.js` - SDE queries (async sqlite3)
- `src/main/blueprint-calculator.js` - Manufacturing and invention calculations (sync better-sqlite3)
- `src/main/market-pricing.js` - Price calculation logic
- `src/main/esi-auth.js` - Eve SSO OAuth flow
- `public/index.html` - Main application dashboard
- Please don't run the tests automatically, I will handle testing when I'm ready.
- Stop automatically running tests.