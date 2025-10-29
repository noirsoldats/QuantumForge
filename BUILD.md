# Build Instructions for Quantum Forge

## Important: Platform-Specific Builds

Due to native module dependencies (`sqlite3` and `better-sqlite3`), builds **must be created on the target platform**. Cross-compilation is not supported.

### Build Requirements

- **Windows builds**: Must be built on Windows
- **macOS builds**: Must be built on macOS
- **Linux builds**: Must be built on Linux

### Why Platform-Specific Builds Are Required

Native Node modules (`.node` files) are compiled binaries that are platform and architecture specific. When you run `npm install`, these modules are compiled for your current platform. electron-builder will rebuild them for Electron's ABI, but it cannot cross-compile for different operating systems.

## Building on Each Platform

### Prerequisites (All Platforms)

```bash
npm install
```

This will:
1. Install all dependencies
2. Run `electron-builder install-app-deps` (via postinstall hook)
3. Rebuild native modules for Electron (via electron-rebuild)

### Windows

```bash
# Build for Windows (on Windows machine)
npm run build:win

# Or for release/publishing
npm run release:win
```

**Output**: `dist/` folder will contain:
- NSIS installer (`.exe`)
- Portable executable
- Latest YAML update metadata

**Supported Architecture**: x64 only

### macOS

```bash
# Build for macOS (on macOS machine)
npm run build:mac

# Or for release/publishing
npm run release:mac
```

**Output**: `dist/` folder will contain:
- DMG installer (`.dmg`)
- ZIP archive (`.zip`)
- Both x64 and ARM64 (Apple Silicon) versions

### Linux

```bash
# Build for Linux (on Linux machine)
npm run build:linux

# Or for release/publishing (not configured yet)
npm run release:linux
```

**Output**: `dist/` folder will contain:
- AppImage
- DEB package

### Building for All Platforms (CI/CD)

**Recommended**: Use GitHub Actions for automated multi-platform builds.

GitHub Actions workflows are configured in `.github/workflows/`:
- **`build.yml`**: Automatically builds all platforms on every push/PR
- **`release.yml`**: Publishes releases when you push a version tag

See [.github/workflows/README.md](.github/workflows/README.md) for detailed instructions.

**Quick Release Process**:
```bash
# 1. Update version
npm version patch  # or minor, or major

# 2. Push with tags
git push origin main --tags

# 3. GitHub Actions will automatically build and publish for all platforms!
```

## Troubleshooting

### "is not a valid Win32 application" Error on Windows

This error occurs when:
1. The Windows build was created on macOS/Linux (cross-compilation)
2. Wrong architecture (x64 vs ia32) was installed
3. Native modules weren't properly rebuilt

**Solution**:
- Build on a Windows machine
- Ensure you're installing the x64 version
- Run `npm install` and let the postinstall hook rebuild modules

### Development After Building

After running a build command, if you want to continue development:

```bash
npm start
```

The build scripts include a rebuild step to ensure native modules work with Electron in development mode.

## Configuration

The build configuration in `package.json` includes:

- `asarUnpack`: Explicitly unpacks native modules from the asar archive
- `npmRebuild: true`: Ensures native modules are rebuilt for Electron's ABI
- Platform-specific architecture targets
- Auto-update configuration (for release builds)

## Clean Build

To remove previous build artifacts:

```bash
npm run clean
npm run build:<platform>
```
