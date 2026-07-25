# DingTalk Minutes Sync for Obsidian

**DingTalk Minutes Sync** imports DingTalk AI Minutes into an Obsidian vault as readable Markdown notes. It runs on desktop Obsidian and uses the locally authenticated [DingTalk Workspace CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli) (`dws`) to access your own DingTalk data.

## Features

- Imports AI summaries, keywords, action items, and optional transcripts.
- Names notes with the actual meeting start date, not the sync date.
- Supports 7-day, 30-day, and one-year initial sync ranges.
- Supports manual sync, sync-on-startup, and scheduled sync.
- Preserves existing notes when the DingTalk transcript API is unavailable.
- Stores no DingTalk password, cookie, or AppSecret.

## Requirements

- Obsidian desktop 1.5.0 or later.
- DingTalk Workspace CLI installed and authenticated on the same computer.
- Access to DingTalk AI Minutes in your DingTalk account.

## Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release.
2. Create the folder `<your-vault>/.obsidian/plugins/dingtalk-minutes-sync/`.
3. Copy the three downloaded files into that folder.
4. Restart Obsidian, open **Settings → Community plugins**, and enable **DingTalk Minutes Sync**.

## Usage

1. Open **Settings → DingTalk Minutes Sync**.
2. Leave **dws path** as `dws` unless it is installed in a custom location. The plugin automatically detects common macOS locations, including `~/.local/bin/dws`.
3. Select the sync scope and initial date range.
4. Choose whether to include transcripts.
5. Click **Sync now** or run **Sync DingTalk AI Minutes now** from the command palette.

Notes are written to the configured `DingTalk Minutes` folder. Every note includes frontmatter with the source task UUID, the actual meeting start time, and the sync time.

## Limitations

This plugin is desktop-only because it invokes a local CLI. DingTalk occasionally does not provide a transcript for a meeting; in that case, the note still includes the available summary, keywords, and action items.

## License

This project is released under the [MIT License](LICENSE).
