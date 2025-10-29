# Contributing to Quantum Forge

Thank you for your interest in contributing to Quantum Forge! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 20 or higher
- npm (comes with Node.js)
- Git

### Getting Started

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/NoirSoldats/QuantumForge.git
   cd QuantumForge
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```
   This will automatically rebuild native modules for Electron.

3. **Run in development mode**
   ```bash
   npm run dev
   ```
   This opens the app with DevTools enabled.

## Development Workflow

### Making Changes

1. Create a new branch for your feature/fix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes

3. Test your changes:
   ```bash
   npm run dev
   ```

4. Commit your changes:
   ```bash
   git add .
   git commit -m "Description of your changes"
   ```

5. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

6. Create a Pull Request on GitHub

### Code Style

- Use meaningful variable and function names
- Comment complex logic
- Follow the existing code structure
- Use JSDoc comments for functions when appropriate

### Testing

When you push or create a PR, GitHub Actions will automatically:
- Build the application for all platforms
- Run any configured tests
- Report build status

## Project Structure

```
QuantumForge/
├── src/
│   ├── main/           # Main process (Node.js)
│   ├── renderer/       # Renderer process (Browser)
│   └── preload/        # Preload scripts (Bridge)
├── public/             # HTML/CSS/Static assets
├── build/              # Build resources (icons, etc.)
├── .github/
│   └── workflows/      # GitHub Actions CI/CD
└── package.json        # Dependencies and scripts
```

### Key Files

- `src/main/main.js` - Application entry point, IPC handlers
- `src/preload/preload.js` - Bridge between main and renderer
- `src/main/settings-manager.js` - User settings and data
- `src/main/sde-database.js` - Eve Online static data queries
- `src/main/blueprint-calculator.js` - Manufacturing calculations

## Building

### Local Builds

```bash
# macOS (on Mac)
npm run build:mac

# Windows (on Windows)
npm run build:win

# Linux (on Linux)
npm run build:linux
```

**Important**: Due to native module dependencies, you must build on the target platform. See [BUILD.md](../BUILD.md) for details.

### CI/CD Builds

GitHub Actions automatically builds for all platforms when you push to `main` or `develop`.

## Release Process

Only maintainers can create releases, but here's the process:

1. Update version: `npm version patch|minor|major`
2. Push with tags: `git push origin main --tags`
3. GitHub Actions automatically builds and publishes the release

## Native Modules

This project uses native Node modules (`sqlite3`, `better-sqlite3`). If you have issues:

```bash
# Rebuild for Electron
npm run rebuild

# Or rebuild for Node.js (for testing)
npm run rebuild:node
```

## Getting Help

- Check existing [Issues](https://github.com/NoirSoldats/QuantumForge/issues)
- Read the [BUILD.md](../BUILD.md) for build-specific help
- Review [.github/workflows/README.md](workflows/README.md) for CI/CD info

## Pull Request Guidelines

- Keep PRs focused on a single feature/fix
- Update documentation if needed
- Ensure the build passes on all platforms (GitHub Actions will verify)
- Describe what your changes do and why

## Code of Conduct

Be respectful and constructive. We're all here to make a better tool for the Eve Online community!

## Questions?

Feel free to open an issue with the "question" label.
