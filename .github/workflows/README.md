# GitHub Actions Workflows

This directory contains GitHub Actions workflows for automated building and releasing of Quantum Forge.

## Workflows

### 1. Build Workflow (`build.yml`)

**Trigger**: Manual only (via workflow_dispatch)

**Purpose**: On-demand builds for testing purposes without creating a release

**Platforms**:
- macOS (x64 and ARM64)
- Linux (AppImage and DEB)
- Windows (x64)

**Artifacts**: Build artifacts are uploaded and available for download for 7 days

**What it does**:
1. Checks out the code
2. Sets up Node.js 20
3. Installs dependencies with `npm ci`
4. Builds the application for the platform
5. Uploads build artifacts

### 2. Release Workflow (`release.yml`)

**Trigger**: Runs when you push a git tag matching `v*.*.*` (e.g., `v1.0.0`)

**Purpose**: Builds and publishes a new release to GitHub Releases with auto-update support

**Platforms**: Same as build workflow

**What it does**:
1. Checks out the code
2. Sets up Node.js 20
3. Installs dependencies with `npm ci`
4. Builds and publishes the application
5. Creates a GitHub Release
6. Uploads release assets (installers, update metadata)

## How to Use

### Manual Builds (Optional)

If you want to test a build without creating a release:

1. Go to **Actions** tab on GitHub
2. Select **Build** workflow
3. Click **Run workflow**
4. Choose the branch and click **Run workflow**
5. Download artifacts when complete

### Creating a Release

1. **Update version in package.json**:
   ```bash
   npm version patch  # or minor, or major
   ```

2. **Push the version commit and tag**:
   ```bash
   git push origin main
   git push origin --tags
   ```

3. **GitHub Actions will**:
   - Build for all platforms
   - Create a GitHub Release with the tag name
   - Upload all installers and update metadata
   - Your users can use auto-update to get the new version!

## Configuration

### Code Signing (Optional)

For production releases, you should set up code signing:

#### macOS Code Signing

1. Export your Apple Developer certificates as a `.p12` file
2. Base64 encode it: `base64 -i certificate.p12 -o encoded.txt`
3. Add GitHub secrets:
   - `MAC_CERTS`: The base64 encoded certificate
   - `MAC_CERTS_PASSWORD`: The certificate password
4. Uncomment the CSC lines in `release.yml` for macOS

#### Windows Code Signing

1. Export your code signing certificate as a `.pfx` file
2. Base64 encode it: `certutil -encode certificate.pfx encoded.txt` (Windows) or `base64 -i certificate.pfx -o encoded.txt` (Mac/Linux)
3. Add GitHub secrets:
   - `WIN_CERTS`: The base64 encoded certificate
   - `WIN_CERTS_PASSWORD`: The certificate password
4. Uncomment the CSC lines in `release.yml` for Windows

### GitHub Token and Permissions

The `GITHUB_TOKEN` is automatically provided by GitHub Actions - no setup needed!

**Permissions**:
The release workflow has `permissions: contents: write` which allows it to:
- Create GitHub Releases
- Upload release assets (installers, update files)
- Push tags and commits

**Important Notes**:
- The **build workflow** uses `--publish never` to prevent publishing (only builds)
- The **release workflow** uses `--publish always` with `GH_TOKEN` to publish to GitHub Releases
- electron-builder automatically handles uploading to GitHub Releases when `GH_TOKEN` is set
- No additional secrets or configuration needed - it just works!

## Monitoring Builds

1. Go to your repository on GitHub
2. Click the "Actions" tab
3. You'll see all workflow runs
4. Click on any run to see details and logs

## Troubleshooting

### Build Fails on Native Modules

This is already handled! The workflows use `npm ci` which installs dependencies from scratch, and electron-builder automatically rebuilds native modules for each platform.

### Release Not Publishing

Make sure:
1. Your tag matches the pattern `v*.*.*` (e.g., `v1.0.0`)
2. The tag is pushed to GitHub: `git push origin --tags`
3. The workflow has `permissions: contents: write` (already configured)
4. Check the Actions tab for error messages

**Common Error**: `403 Forbidden - Resource not accessible by integration`
- This means the workflow lacks permissions
- Already fixed with `permissions: contents: write` in the workflow file

### Artifacts Not Appearing

Check the workflow logs in the Actions tab. The artifacts should appear at the bottom of the workflow run page if the build succeeded.

## Local Testing

Before pushing a tag for release, you can test the build locally:

```bash
# macOS
npm run build:mac

# Windows (on Windows machine)
npm run build:win

# Linux (on Linux machine)
npm run build:linux
```

## Caching

The workflows use Node.js caching to speed up dependency installation:
- `cache: 'npm'` in the setup-node action caches npm dependencies
- This significantly reduces build times for subsequent runs
