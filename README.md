# FileSorter Desktop Agent

Tauri-based desktop application for automatic file organization.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (latest stable)
- [Tauri Prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites)

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev
```

## Build

```bash
# Build for production
npm run tauri build
```

The built application will be in `src-tauri/target/release/`.

## Project Structure

```
desktop/
├── src/                    # React UI
│   ├── components/
│   │   ├── Login.tsx      # Login form
│   │   ├── Dashboard.tsx  # Main dashboard
│   │   └── Settings.tsx   # Settings panel
│   ├── App.tsx            # Main app component
│   ├── main.tsx           # React entry point
│   └── styles.css         # Styles
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── main.rs        # Tauri app entry
│   │   ├── config.rs      # Configuration
│   │   ├── api_client.rs  # API communication
│   │   ├── file_watcher.rs # File monitoring
│   │   ├── classifier.rs  # Local classification
│   │   └── storage.rs     # Local storage
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── vite.config.ts
```

## Features

- 📁 Monitor folders for new files
- 🤖 AI-powered file classification
- 📋 Custom sorting rules
- 🔔 Desktop notifications
- ↩️ Undo support
- 🌙 Dark mode UI
- 📊 Statistics dashboard
