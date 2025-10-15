# Quantum Forge

Eve Online Industry Management Tool

## Description

Quantum Forge is a comprehensive desktop application for managing your Eve Online industrial operations. Track manufacturing, manage resources, and optimize your production efficiency.

## Features

- Manufacturing management
- Resource tracking
- Production analytics
- Cross-platform support (Windows, macOS, Linux)

## Development

### Prerequisites

- Node.js (v16 or higher)
- npm

### Installation

```bash
npm install
```

### Running in Development

```bash
npm run dev
```

or

```bash
npm start
```

### Building

Build for current platform:
```bash
npm run build
```

Build for specific platforms:
```bash
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

Build for all platforms:
```bash
npm run build:all
```

### Project Structure

```
quantum-forge/
├── src/
│   ├── main/          # Main process
│   ├── renderer/      # Renderer process
│   └── preload/       # Preload scripts
├── public/            # Static files
├── dist/              # Build output
└── package.json
```

## License

MIT
