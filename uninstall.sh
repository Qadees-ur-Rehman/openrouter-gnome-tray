#!/usr/bin/env bash
# Removes the OpenRouter Usage GNOME extension and (optionally) the saved key.
#   curl -fsSL https://raw.githubusercontent.com/Qadees-ur-Rehman/openrouter-gnome-tray/main/uninstall.sh | bash
#   ... | bash -s -- --keep-key     # keep the API key in the keyring
set -euo pipefail

UUID="openrouter-usage@tray"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
keep_key=0
[ "${1:-}" = "--keep-key" ] && keep_key=1

gnome-extensions disable "$UUID" >/dev/null 2>&1 || true

enabled="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo '@as []')"
if [[ "$enabled" == *"'$UUID'"* ]]; then
    enabled="${enabled//\'$UUID\', /}"
    enabled="${enabled//, \'$UUID\'/}"
    enabled="${enabled//\'$UUID\'/}"
    [[ "$enabled" == "[]" ]] && enabled="@as []"
    gsettings set org.gnome.shell enabled-extensions "$enabled"
fi

rm -rf "$DEST"
dconf reset -f /org/gnome/shell/extensions/openrouter-usage/ 2>/dev/null || true

if [ "$keep_key" -eq 0 ]; then
    if command -v secret-tool >/dev/null 2>&1; then
        secret-tool clear service openrouter-tray key api-key 2>/dev/null || true
        echo "Removed the API key from your keyring."
    else
        echo "Note: open 'Passwords and Keys' (Seahorse) and delete 'OpenRouter Tray API Key' to remove the saved key."
    fi
fi

echo "OpenRouter Usage was uninstalled. Log out and back in to remove it from the top bar."
