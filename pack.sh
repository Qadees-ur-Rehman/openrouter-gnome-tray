#!/usr/bin/env bash
# Builds the zip to upload to https://extensions.gnome.org/upload/
set -euo pipefail
cd "$(dirname "$0")"
UUID="openrouter-gnome-tray@qadees-ur-rehman.github.io"
OUT="$PWD/$UUID.shell-extension.zip"
rm -f "$OUT"
# EGO compiles schemas itself for GNOME 44+, so gschemas.compiled is left out.
(cd "$UUID" && zip -qr "$OUT" . -x 'schemas/gschemas.compiled' -x '*.DS_Store')
unzip -l "$OUT"
