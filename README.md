# Dank RSS Widget

A desktop widget plugin for [DankMaterialShell](https://github.com/AvengeMedia/DankMaterialShell) that displays RSS and Atom feeds directly on your desktop.

## Features

- RSS 2.0 and Atom feed support with auto-detection
- Configurable auto-refresh interval (5min - 24hr)
- Click items to open in your browser
- Add/edit/remove feeds via the settings panel
- Quick-add buttons for popular feeds (Hacker News, Reddit, Ars Technica, The Verge)
- Appearance customization (background opacity, borders)
- CDATA unwrapping and HTML entity decoding
- Feed source labels per item

## Installation

### From the DMS Plugin Manager

Search for "Dank RSS Widget" in the DMS plugin manager.

### Manual Installation

Clone or symlink this repo into your DMS plugins directory:

```bash
git clone https://github.com/BrendonJL/dms-rss-widget.git
ln -s /path/to/dms-rss-widget ~/.config/DankMaterialShell/plugins/dankRssWidget
```

Reload DMS (Ctrl+Shift+R) or restart your compositor.

## Configuration

Open the widget settings to:

1. **Add feeds** — Enter a name and RSS/Atom URL, or use the quick-add presets
2. **Set refresh interval** — How often feeds are fetched (default: 30 minutes)
3. **Max items** — Limit displayed items (default: 20)
4. **Appearance** — Background opacity, border toggle/color/thickness

## Requirements

- DankMaterialShell >= 1.2.0
- `curl` (used for fetching feeds)

## Screenshots

<!-- TODO: Add screenshots -->

## License

MIT
