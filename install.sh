#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_DIR="$HOME/.config/DankMaterialShell/plugins"
PLUGIN_ID="dankRssWidget"

mkdir -p "$PLUGINS_DIR"

if [ -L "$PLUGINS_DIR/$PLUGIN_ID" ]; then
    rm "$PLUGINS_DIR/$PLUGIN_ID"
fi

ln -sf "$REPO_DIR" "$PLUGINS_DIR/$PLUGIN_ID"

echo "Installed: $PLUGINS_DIR/$PLUGIN_ID -> $REPO_DIR"
echo ""
echo "Next steps:"
echo "  1. Open DankMaterialShell Settings"
echo "  2. Go to Plugins → Scan for plugins"
echo "  3. Enable 'Dank RSS Widget'"
echo "  4. Add the widget to your desktop"
