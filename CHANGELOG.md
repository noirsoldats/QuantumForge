# Changelog

All notable changes to Quantum Forge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Auto-update functionality for Windows and Mac installers
- Version management scripts for easier release process

### Changed
- Enhanced build process with custom icons and branding support

## [1.0.0] - 2024-01-01

### Added
- Initial release of Quantum Forge
- Character authentication via Eve Online ESI
- Blueprint calculator with material efficiency calculations
- Manufacturing facility management with structure and rig bonuses
- Market data integration with pricing analysis
- Blueprint ownership tracking and skill override system
- Market settings configuration
- Manufacturing Summary report with profitability analysis
- Blueprint filtering by tech level and category
- Column configuration and sorting in Manufacturing Summary
- Volume calculations for manufacturing inputs/outputs
- Current sell orders display
- Manufacturing steps tracking

### Features
- **Blueprint Calculator**: Calculate manufacturing costs with ME/TE bonuses, structure bonuses, and rig effects
- **Market Integration**: Real-time market data from ESI with multiple pricing methods (VWAP, percentile, historical)
- **Facility Management**: Define manufacturing locations with system, structure, and rig configurations
- **Skills Management**: Character skill tracking with override capabilities for "what-if" scenarios
- **Manufacturing Summary**: Comprehensive profitability analysis across all owned blueprints
- **SDE Management**: Automatic Eve Online Static Data Export updates

### Technical
- Electron-based desktop application
- Multi-window architecture with IPC communication
- SQLite databases for local caching (SDE, market data, settings)
- Eve Online ESI OAuth integration
- Better-sqlite3 and sqlite3 database libraries
- Vanilla JavaScript with no framework dependencies

---

## Release Notes Format

When creating a new release, add a section with the version number and date:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes to existing functionality

### Deprecated
- Features that will be removed in future versions

### Removed
- Features that have been removed

### Fixed
- Bug fixes

### Security
- Security improvements or fixes
```

## Version Numbering

- **Major (X.0.0)**: Breaking changes, major new features
- **Minor (x.Y.0)**: New features, non-breaking changes
- **Patch (x.y.Z)**: Bug fixes, minor improvements

## How to Update

1. Add changes to the `[Unreleased]` section as you work
2. When ready to release:
   - Run `npm run version:patch`, `npm run version:minor`, or `npm run version:major`
   - Move items from `[Unreleased]` to new version section
   - Add release date
   - Commit changes
   - Build and publish release
