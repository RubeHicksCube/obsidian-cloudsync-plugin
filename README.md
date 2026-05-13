# CloudSync for Obsidian

An Obsidian plugin for syncing your vault with an [ObsidianCloudSync](https://github.com/RubeHicksCube/obsidian-cloud-sync) server.

## Features

- **Delta sync** -- only uploads/downloads files that have changed
- **End-to-end encryption** -- AES-256-GCM with PBKDF2 key derivation; your notes are encrypted before leaving your device
- **Real-time sync** -- WebSocket connection triggers instant sync when another device pushes changes
- **Conflict resolution** -- detects simultaneous edits and preserves both versions
- **Selective sync** -- exclude files/folders with configurable glob patterns
- **Progress tracking** -- status bar shows sync progress ("Syncing 3/12 files...")
- **Auto-sync** -- configurable interval (default: 5 minutes) plus debounced sync on file changes
- **Passphrase change** -- re-encrypt and re-upload all files with a new passphrase

## Requirements

A running [ObsidianCloudSync server](https://github.com/RubeHicksCube/obsidian-cloud-sync). See the server repo for setup instructions.

## Install

The plugin is not yet in the Obsidian Community Plugins directory. Install manually:

```bash
cd /path/to/your/vault/.obsidian/plugins
git clone https://github.com/RubeHicksCube/obsidian-cloudsync-plugin.git obsidian-cloudsync
cd obsidian-cloudsync
npm install && npm run build
```

Restart Obsidian, then enable **CloudSync** in Settings > Community Plugins.

## Configure

Open Settings > CloudSync and set:

- **Server URL** -- your server address (e.g. `https://sync.yourdomain.com`)
- **Username / Password** -- your registered credentials
- **Encryption Passphrase** -- must be identical on all devices syncing the same vault
- **Auto-sync Interval** -- minutes between automatic syncs (0 to disable)

Click **Login** to connect.

## Usage

- **Manual sync**: Command palette > "CloudSync: Sync now", or click the refresh icon in the ribbon
- **Auto sync**: Runs on the configured interval and when files are modified
- **Real-time**: Other devices' changes are pushed via WebSocket automatically
- **Status bar**: Shows last sync time, or progress during active sync
- **Exclude patterns**: Add glob patterns in settings to skip files (e.g. `.trash/`, `*.tmp`)

## Important

- **Encryption passphrase cannot be recovered.** If you lose it, your server-side data is unreadable.
- **All devices must use the same passphrase.** Mismatched passphrases will result in decryption failures.
- Sync before switching devices to minimize conflicts.

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```

## License

MIT
