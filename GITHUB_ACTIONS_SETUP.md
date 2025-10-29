# GitHub Actions Setup Summary

GitHub Actions has been configured for Quantum Forge to automate building and releasing across all platforms.

## What's Been Set Up

### 1. Build Workflow (`.github/workflows/build.yml`)

**Triggers on**:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches

**What it does**:
- Builds for macOS (x64 + ARM64), Windows (x64), and Linux (AppImage + DEB)
- Uploads build artifacts (available for 7 days)
- Ensures code compiles on all platforms

### 2. Release Workflow (`.github/workflows/release.yml`)

**Triggers on**:
- Git tags matching `v*.*.*` (e.g., `v1.0.0`, `v0.5.1`)

**What it does**:
- Builds for all platforms
- Creates a GitHub Release
- Uploads installers and auto-update metadata
- Enables electron-updater to work for automatic updates

## How to Use

### Regular Development

Just push your code as normal:
```bash
git add .
git commit -m "Your changes"
git push origin main
```

GitHub Actions will automatically build for all platforms and show you if there are any build errors.

### Creating a Release

When you're ready to publish a new version:

```bash
# 1. Bump the version (updates package.json and creates a git tag)
npm version patch   # For bug fixes (0.5.0 → 0.5.1)
npm version minor   # For new features (0.5.0 → 0.6.0)
npm version major   # For breaking changes (0.5.0 → 1.0.0)

# 2. Push the commit and tag
git push origin main
git push origin --tags

# 3. That's it! GitHub Actions handles the rest
```

Within a few minutes:
- All platform builds will complete
- A new GitHub Release will be created
- Installers will be attached to the release
- Users with the app installed can auto-update

## What Gets Built

### macOS
- `Quantum Forge-{version}-arm64.dmg` (Apple Silicon)
- `Quantum Forge-{version}-x64.dmg` (Intel)
- `Quantum Forge-{version}-arm64-mac.zip` (Apple Silicon)
- `Quantum Forge-{version}-mac.zip` (Intel)
- `latest-mac.yml` (Auto-update metadata)

### Windows
- `Quantum Forge Setup {version}.exe` (NSIS installer)
- `Quantum Forge {version}.exe` (Portable)
- `latest.yml` (Auto-update metadata)

### Linux
- `Quantum Forge-{version}.AppImage` (Universal)
- `quantum-forge_{version}_amd64.deb` (Debian/Ubuntu)
- `latest-linux.yml` (Auto-update metadata)

## Monitoring

### View Build Status

1. Go to: https://github.com/NoirSoldats/QuantumForge/actions
2. See all workflow runs
3. Click any run for detailed logs

### Build Badges (Optional)

Add to your README.md:
```markdown
[![Build](https://github.com/NoirSoldats/QuantumForge/actions/workflows/build.yml/badge.svg)](https://github.com/NoirSoldats/QuantumForge/actions/workflows/build.yml)
```

## Code Signing (Optional Setup)

Currently, apps are built **without code signing**. This is fine for distribution, but:
- macOS: Users will see "unidentified developer" warning
- Windows: Users may see SmartScreen warning

To enable code signing, see: `.github/workflows/README.md` (Code Signing section)

## Troubleshooting

### Build Fails with "Native Module" Error

This should not happen since builds run on the native platform. If it does:
- Check the workflow logs in the Actions tab
- Ensure `package.json` dependencies are correct
- The `asarUnpack` and `npmRebuild` settings should handle this

### Release Not Created

Make sure:
- You pushed the tag: `git push origin --tags`
- Tag matches pattern: `v1.0.0` (not `1.0.0`)
- Check Actions tab for error messages

### Artifacts Missing

Check that the build succeeded in the Actions tab. Artifacts appear at the bottom of the workflow run page.

## Cost

GitHub Actions is **free** for public repositories with generous limits:
- 2,000 minutes/month for free
- Each platform build takes ~5-10 minutes
- Easily within free tier for normal development

## Next Steps

1. **First Release**: Try creating a test release:
   ```bash
   npm version patch
   git push origin main --tags
   ```

2. **Monitor**: Watch the Actions tab to see builds complete

3. **Download**: Once complete, check the Releases page for your installers

4. **Test Auto-Update**: Install the app and try publishing another version - the app should auto-update!

## Additional Resources

- [Build Documentation](BUILD.md)
- [GitHub Actions Workflows](/.github/workflows/README.md)
- [Contributing Guide](/.github/CONTRIBUTING.md)
- [electron-builder docs](https://www.electron.build/)
