#!/usr/bin/env bash
# One-command installer for the OpenRouter Usage GNOME extension.
#   curl -fsSL https://raw.githubusercontent.com/Qadees-ur-Rehman/openrouter-gnome-tray/main/install.sh | bash
set -euo pipefail

REPO="${OPENROUTER_USAGE_REPO:-Qadees-ur-Rehman/openrouter-gnome-tray}"
BRANCH="${OPENROUTER_USAGE_BRANCH:-main}"
UUID="openrouter-usage@tray"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

bold=$'\e[1m'; green=$'\e[32m'; yellow=$'\e[33m'; red=$'\e[31m'; reset=$'\e[0m'
info()  { printf '%s==>%s %s\n' "$green" "$reset" "$*"; }
warn()  { printf '%s!!%s  %s\n' "$yellow" "$reset" "$*"; }
die()   { printf '%sxx%s  %s\n' "$red" "$reset" "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "This extension is for Linux (GNOME desktop)."
[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not with sudo. It will ask for your password only if it needs to."

# --- GNOME Shell check -------------------------------------------------------
command -v gnome-shell >/dev/null 2>&1 ||
    die "GNOME Shell was not found. This extension needs the GNOME desktop (Ubuntu, Fedora, Debian, ...)."
shell_major="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)"
if [ -n "$shell_major" ] && [ "$shell_major" -lt 45 ]; then
    die "GNOME Shell $shell_major is too old. You need GNOME 45 or newer (Ubuntu 24.04+, Fedora 39+, Debian 13+)."
fi
info "Found GNOME Shell ${shell_major:-?}"

# --- libsecret (keyring access from JavaScript) -------------------------------
has_typelib() {
    local dir
    for dir in /usr/lib/girepository-1.0 /usr/lib64/girepository-1.0 /usr/lib/*/girepository-1.0 \
               /usr/local/lib/girepository-1.0 /usr/local/lib64/girepository-1.0; do
        [ -f "$dir/$1.typelib" ] && return 0
    done
    return 1
}

if ! has_typelib Secret-1; then
    info "Installing libsecret so the key can be stored in your keyring (may ask for your password)..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get install -y gir1.2-secret-1
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y libsecret
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --needed --noconfirm libsecret
    elif command -v zypper >/dev/null 2>&1; then
        sudo zypper --non-interactive install typelib-1_0-Secret-1
    else
        warn "Could not install libsecret automatically. Please install your distro's libsecret GObject-introspection package."
    fi
fi

# --- Get the extension files --------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

script_dir=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$script_dir" ] && [ -d "$script_dir/$UUID" ]; then
    info "Installing from local checkout"
    src="$script_dir/$UUID"
else
    url="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
    info "Downloading $url"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$tmp/src.tar.gz"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$tmp/src.tar.gz" "$url"
    else
        die "Need curl or wget to download the extension."
    fi
    tar -xzf "$tmp/src.tar.gz" -C "$tmp"
    src="$(find "$tmp" -mindepth 2 -maxdepth 2 -type d -name "$UUID" | head -n1)"
    [ -n "$src" ] || die "Download did not contain $UUID."
fi

# --- Install ------------------------------------------------------------------
info "Installing to $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$src"/. "$DEST"/

if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "$DEST/schemas"
elif [ ! -f "$DEST/schemas/gschemas.compiled" ]; then
    die "glib-compile-schemas is missing (package libglib2.0-bin / glib2)."
fi

# --- Enable -------------------------------------------------------------------
gsettings set org.gnome.shell disable-user-extensions false 2>/dev/null || true

enabled="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo '@as []')"
if [[ "$enabled" != *"'$UUID'"* ]]; then
    if [[ "$enabled" == "@as []" || "$enabled" == "[]" ]]; then
        enabled="['$UUID']"
    else
        enabled="${enabled%]}, '$UUID']"
    fi
    gsettings set org.gnome.shell enabled-extensions "$enabled"
fi

disabled="$(gsettings get org.gnome.shell disabled-extensions 2>/dev/null || echo '@as []')"
if [[ "$disabled" == *"'$UUID'"* ]]; then
    disabled="${disabled//\'$UUID\', /}"
    disabled="${disabled//, \'$UUID\'/}"
    disabled="${disabled//\'$UUID\'/}"
    [[ "$disabled" == "[]" ]] && disabled="@as []"
    gsettings set org.gnome.shell disabled-extensions "$disabled"
fi

gnome-extensions enable "$UUID" >/dev/null 2>&1 || true

echo
printf '%sInstalled!%s\n\n' "$bold$green" "$reset"
if [ "${XDG_SESSION_TYPE:-}" = "x11" ]; then
    echo "  Press Alt+F2, type r, press Enter (or log out and back in)."
else
    echo "  Log out and log back in so GNOME loads the extension."
fi
echo "  Then click the indicator in the top bar and paste your OpenRouter API key."
echo
echo "  Uninstall any time with:"
echo "    curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/uninstall.sh | bash"
