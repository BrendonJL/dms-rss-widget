#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Dux Shell 2.0 moved the config dir from DankMaterialShell to dms and keeps the
# old path only as a compatibility symlink, which may be absent. Use the legacy
# dir only when it is the one that exists (DMS < 2.0).
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
PLUGINS_DIR="$CONFIG_HOME/dms/plugins"
if [ ! -d "$CONFIG_HOME/dms" ] && [ -d "$CONFIG_HOME/DankMaterialShell" ]; then
    PLUGINS_DIR="$CONFIG_HOME/DankMaterialShell/plugins"
fi
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
