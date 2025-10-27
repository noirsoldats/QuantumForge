# Release Process Guide

This document describes the process for building and releasing Quantum Forge installers.

## Prerequisites

### GitHub Setup

1. **Repository Configuration**:
   - Update `package.json` → `build.publish.owner` with your GitHub username
   - Update `package.json` → `build.publish.repo` with your repository name

2. **GitHub Personal Access Token**:
   ```bash
   # Create a token at: https://github.com/settings/tokens
   # Required scopes: repo (all)

   # Set token as environment variable:
   export GH_TOKEN="your_github_token_here"

   # Or add to ~/.bash_profile or ~/.zshrc:
   echo 'export GH_TOKEN="your_github_token_here"' >> ~/.zshrc
   source ~/.zshrc
   ```

3. **Create a GitHub Release** (manually or via script):
   - Go to your repository → Releases → Draft a new release
   - Create a tag (e.g., v1.0.0)
   - Add release notes from CHANGELOG.md
   - Save as draft or publish

### Application Icons (Optional but Recommended)

Before building, add custom icons to the `build/` directory:

- `build/icon.icns` - Mac icon
- `build/icon.ico` - Windows icon
- `build/background.png` - Mac DMG background (540x380 or 1080x760)
- `build/installerHeader.bmp` - Windows installer header (150x57)
- `build/installerSidebar.bmp` - Windows installer sidebar (164x314)

See `build/ICONS_README.md` for detailed instructions.

## Version Management

### Updating Version Number

Use npm version commands to bump version and create git tags:

```bash
# Patch version (1.0.0 → 1.0.1) - Bug fixes
npm run version:patch

# Minor version (1.0.0 → 1.1.0) - New features
npm run version:minor

# Major version (1.0.0 → 2.0.0) - Breaking changes
npm run version:major
```

These commands will:
1. Update version in `package.json`
2. Create a git commit with version bump
3. Create a git tag (e.g., v1.0.1)

**Important**: Update `CHANGELOG.md` before bumping version!

## Building Installers

### Platform-Specific Requirements

#### Mac
- **Requirements**: macOS with Xcode Command Line Tools
- **Output**: DMG (disk image) and ZIP files
- No additional dependencies required

#### Windows
- **On Windows**: No additional requirements
- **On Mac/Linux**: Requires Wine
  ```bash
  # Mac
  brew install --cask wine-stable

  # Linux
  sudo apt-get install wine64  # Ubuntu/Debian
  sudo dnf install wine        # Fedora
  ```
- **Output**: NSIS installer (.exe) and portable executable

#### Linux
Building Linux packages requires additional tools:

**On Linux:**
```bash
# Ubuntu/Debian - Install all required tools
sudo apt-get install rpm fakeroot dpkg

# Fedora/RHEL - Install required tools
sudo dnf install rpm-build dpkg fakeroot

# Arch Linux
sudo pacman -S rpm-tools dpkg fakeroot
```

**On Mac:**
```bash
# fakeroot is needed for deb packages
brew install fakeroot
```

**Important Notes:**
- **rpm**: Required to build .rpm packages (Fedora, RHEL, openSUSE)
- **fakeroot**: Required to build .deb packages (Ubuntu, Debian, Mint)
- **dpkg**: Required to build .deb packages
- AppImage builds work without additional dependencies

**⚠️ RPM Build Limitation on Mac:**
Building .rpm packages does not work reliably on macOS, even with Homebrew's rpm package installed. The recommended approach is:
- Build AppImage and .deb on Mac (works perfectly)
- Build .rpm on a Linux machine or CI/CD system
- Or skip .rpm if you don't need Red Hat/Fedora support

The default configuration (`package.json`) only builds AppImage and .deb to avoid errors on Mac.

**Output**: AppImage (universal), .deb (Debian/Ubuntu)

### Local Development Builds

Build for your current platform:

```bash
# Mac
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux

# All platforms (requires all platform dependencies)
npm run build:all
```

Output will be in the `dist/` directory.

### Release Builds (with Auto-Update)

Release builds automatically upload to GitHub Releases:

```bash
# Ensure GH_TOKEN is set
echo $GH_TOKEN

# Build and publish for current platform
npm run release

# Or specific platform
npm run release:mac
npm run release:win

# All platforms
npm run build:all --publish always
```

**Important**: Make sure the GitHub release (draft or published) exists with the matching version tag before running release commands.

## Release Checklist

### Pre-Release

- [ ] Update `CHANGELOG.md` with all changes
- [ ] Move unreleased changes to new version section
- [ ] Update version number: `npm run version:[patch|minor|major]`
- [ ] Test the application locally: `npm start`
- [ ] Review all recent changes and features
- [ ] Update screenshots/documentation if UI changed

### Build & Test

- [ ] Build installer for target platform: `npm run build:mac` or `npm run build:win`
- [ ] Test installer on clean system
- [ ] Verify application starts and all features work
- [ ] Check that icons appear correctly
- [ ] Test auto-update check (should skip in dev, work in production)

### GitHub Release

- [ ] Create GitHub release with tag matching package.json version
- [ ] Copy release notes from CHANGELOG.md
- [ ] Set release as draft initially
- [ ] Run release build: `npm run release:mac` or `npm run release:win`
- [ ] Verify artifacts uploaded to GitHub release
- [ ] Test download and install from GitHub release
- [ ] Publish the GitHub release (remove draft status)

### Post-Release

- [ ] Test auto-update on previous version (should detect new version)
- [ ] Announce release to users
- [ ] Monitor for issues or bug reports
- [ ] Create new `[Unreleased]` section in CHANGELOG.md for next version

## Auto-Update Flow

### How It Works

1. **On App Start**: After 5 seconds, app checks GitHub for new releases
2. **Update Available**: User sees dialog with option to download
3. **Download**: Update downloads in background with progress
4. **Install**: User can continue working; update installs on next app close
5. **Restart**: Next launch runs new version

### Testing Auto-Update

1. Build and release version 1.0.0
2. Install version 1.0.0 on test machine
3. Create and release version 1.0.1
4. Launch version 1.0.0
5. Should see "Update Available" dialog within 5 seconds

### Disabling Auto-Update

Auto-update is automatically disabled in development mode (`NODE_ENV=development`).

To disable in production, comment out the auto-update initialization in `src/main/main.js`:

```javascript
// initAutoUpdater(mainWindow);
```

## Troubleshooting

### "GitHub token not set"

Set the `GH_TOKEN` environment variable:
```bash
export GH_TOKEN="your_github_token_here"
```

### "Cannot find GitHub release"

Create a GitHub release with a tag matching your `package.json` version before running release build.

### "Icon not found"

Add icon files to `build/` directory. The app will use default Electron icons if custom icons are missing (this is fine for testing).

### Build fails on native modules

Rebuild native modules for Electron:
```bash
npm run postinstall
# Or manually:
npx electron-rebuild
```

### "Please specify project homepage"

This error occurs when building Linux packages. Add to `package.json`:
```json
"homepage": "https://github.com/YOUR_USERNAME/QuantumForge",
"repository": {
  "type": "git",
  "url": "https://github.com/YOUR_USERNAME/QuantumForge.git"
}
```

### Linux: "rpm command not found" or ".rpm build failed"

**On Mac:**
RPM builds don't work reliably on macOS. This is a known limitation. Remove "rpm" from the linux targets in `package.json`:
```json
"linux": {
  "target": ["AppImage", "deb"]  // Removed "rpm"
}
```

To build RPM packages, use a Linux machine or CI/CD pipeline.

**On Linux:**
Install the rpm tool:
```bash
# Ubuntu/Debian
sudo apt-get install rpm

# Fedora (should be pre-installed)
sudo dnf install rpm-build
```

### Linux: ".deb build failed" or "fakeroot not found"

Install fakeroot and dpkg:
```bash
# Mac
brew install fakeroot

# Ubuntu/Debian
sudo apt-get install fakeroot dpkg

# Fedora/RHEL
sudo dnf install fakeroot dpkg
```

### Linux: Building only specific package types

If you only need certain Linux package formats, modify `package.json`:
```json
"linux": {
  "target": ["AppImage"]  // Or ["deb"], ["rpm"], etc.
}
```

### Windows build on Mac

Windows builds on Mac require Wine. Install via Homebrew:
```bash
brew install --cask wine-stable
```

Or use a Windows VM/machine for Windows builds.

## Installer Size Optimization

The build process includes several optimizations to reduce installer size:

### Current Optimizations

1. **ASAR Compression** (`compression: "maximum"`):
   - Compresses JavaScript, HTML, CSS files in the app.asar archive
   - Reduces app code size by ~30-40%
   - Minor trade-off: ~50-100ms slower app startup

2. **Language Removal** (`electronLanguages: ["en"]`):
   - Only includes English language pack
   - Removes ~70 unused language localizations
   - Saves ~5-10 MB per installer

3. **DMG Compression** (`format: "ULFO"`):
   - Uses LZFSE compression for Mac DMG files
   - Better compression than default UDZO format
   - Reduces DMG size by ~5-10%

### Size Breakdown

**Typical installer sizes:**
- Mac DMG: ~85-95 MB per architecture
- Mac ZIP (for auto-update): ~90-100 MB per architecture
- Windows NSIS: ~80-90 MB
- Linux AppImage: ~100-110 MB
- Linux .deb: ~90-100 MB

**What contributes to size:**
- Electron Framework (Chromium + Node.js): ~252 MB (~90% of app)
- App code (compressed): ~6-7 MB
- Native modules (SQLite): ~17 MB
- Icon and resources: ~2-3 MB

### Further Optimization Options

If you need smaller installers, consider:

**1. Single Architecture Builds** (50% reduction per platform):
```json
// In package.json, instead of:
"target": [{"target": "dmg", "arch": ["x64", "arm64"]}]

// Use separate builds:
"target": [{"target": "dmg", "arch": ["x64"]}]  // x64 only
// or
"target": [{"target": "dmg", "arch": ["arm64"]}]  // ARM64 only
```

Users download only their architecture, but you distribute multiple files.

**2. Add More Languages** (if needed):
```json
"electronLanguages": ["en", "fr", "de", "es"]  // Add as needed
```

Each language adds ~100-200 KB.

**3. Use Web-Based Distribution:**
- Host the SDE database on a server
- Download on first run instead of bundling
- Reduces installer by ~100-200 MB (if SDE is included)

### What Cannot Be Reduced

- **Electron Framework**: This is the full Chromium browser + Node.js runtime. It's the same size regardless of your app's features.
- **Native Modules**: SQLite binaries must be included for database functionality.

The current configuration provides a good balance between size and functionality.

## File Locations

### Source Files
- `src/` - Application source code
- `public/` - HTML, CSS, static assets
- `build/` - Build resources (icons, installers branding)

### Generated Files
- `dist/` - Built installers (not committed to git)
- `dist/mac/` - Mac .app and .dmg
- `dist/win/` - Windows .exe and portable
- `dist/linux/` - Linux AppImage, deb, rpm

### Configuration
- `package.json` - Version, build config, scripts
- `CHANGELOG.md` - Release notes
- `.gitignore` - Excludes dist/, node_modules/, etc.

## Additional Resources

- [electron-builder docs](https://www.electron.build/)
- [electron-updater docs](https://www.electron.build/auto-update)
- [Semantic Versioning](https://semver.org/)
- [Keep a Changelog](https://keepachangelog.com/)
