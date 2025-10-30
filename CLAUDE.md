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

### Dependencies
```bash
npm install            # Install all dependencies
```

**Note**: No test suite is currently configured.

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

**Market Pricing** (`src/main/market-pricing.js`):
- Multiple pricing methods: VWAP, percentile, historical average, hybrid
- Price overrides system for manual price setting
- Integrates ESI market data and Fuzzwork API as fallback
- Confidence indicators based on volume and data freshness

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
- Market page (loaded into main window): Market data viewer and pricing configuration
- Blueprint Calculator page (loaded into main window): Manufacturing calculator
- Facilities page (loaded into main window): Facility manager

**Window State**: Window positions/sizes persisted via `window-state-manager.js`

### Data Storage

**User Data Location**: `app.getPath('userData')` (platform-specific)
- `quantum_config.json`: All application settings
- `sde/sqlite-latest.sqlite`: Eve Online static data
- `sde/version.txt`: SDE version tracking
- `market-data.db`: Cached market orders and history

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

### Price Calculation Flow

1. Check for manual price override first
2. Fetch market data from cache or ESI
3. Apply pricing method (VWAP/percentile/historical/hybrid)
4. Apply price modifiers from market settings
5. Return price with confidence indicator

## Critical Files Reference

- `src/main/main.js` - Application entry point, all IPC handlers
- `src/preload/preload.js` - IPC API surface exposed to renderers
- `src/main/settings-manager.js` - Settings persistence and character management
- `src/main/sde-database.js` - SDE queries (async sqlite3)
- `src/main/blueprint-calculator.js` - Manufacturing calculations (sync better-sqlite3)
- `src/main/market-pricing.js` - Price calculation logic
- `src/main/esi-auth.js` - Eve SSO OAuth flow
- `public/index.html` - Main application dashboard
