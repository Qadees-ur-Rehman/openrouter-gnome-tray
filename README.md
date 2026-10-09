# OpenRouter Usage for GNOME

See your [OpenRouter](https://openrouter.ai) API key usage in the Linux top bar.

- The **top bar** shows the most useful number: how much budget is left (if your key has a limit), free requests left (free tier), or today's spend.
- **Click it** to see:
  - total usage against your limit, with a progress bar
  - spend for today, this week and this month
  - free-model requests used today
  - limit reset period and key expiry
  - refresh, change key, and settings buttons
- It refreshes on its own every 5 minutes, and again when you open it.
- The label turns yellow at 75% of your limit and red at 90%.

## Install (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/Qadees-ur-Rehman/openrouter-gnome-tray/main/install.sh | bash
```

Then **log out and log back in**. Click the new indicator in the top bar, paste your API key, and press **Save key**.

Requirements: GNOME 45 or newer (Ubuntu 24.04+, Fedora 39+, Debian 13+, Arch). The installer sets up everything else, and asks for your password only if it has to install `libsecret`.

## Your API key is stored securely

- The key goes into your **GNOME Keyring** through libsecret. The keyring is encrypted with your login password.
- The key is never written to a settings file, a log or the extension folder.
- It is checked with OpenRouter before it is saved, and it is only ever sent to `https://openrouter.ai`.
- Only your user account can read it.

The key is a normal keyring entry, so you can also manage it from a terminal:

```bash
secret-tool lookup service openrouter-tray key api-key   # show it
secret-tool clear  service openrouter-tray key api-key   # delete it

# store it without the UI (the key never touches your shell history):
read -rsp "OpenRouter API key: " K; echo
printf '%s' "$K" | secret-tool store --label="OpenRouter Tray API Key" service openrouter-tray key api-key
unset K
```

> Tip: give the key a **spending limit** on [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys). If it ever leaks, the damage is capped. A limit also makes the progress bar useful.

## Settings

Click **Settings** in the popup, or run `gnome-extensions prefs openrouter-usage@tray`. You can change:

- **Label shows**: Smart / Remaining budget / Total usage / Today / Percent / Icon only
- **Position**: right, center (next to the clock) or left
- **Show icon** and **refresh interval**
- Your saved key: replace it or remove it

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/Qadees-ur-Rehman/openrouter-gnome-tray/main/uninstall.sh | bash
```

This also deletes the key from your keyring. To keep the key, add `-s -- --keep-key` after `bash`.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Nothing shows in the top bar | Log out and back in. Then run `gnome-extensions info openrouter-usage@tray`; it should say `ENABLED`. |
| "Keyring unavailable" | Make sure GNOME Keyring is running and unlocked. With auto-login, the keyring may ask for your password once. |
| "OpenRouter rejected this key" | The key was revoked or mistyped. Create a new one at openrouter.ai/settings/keys. |
| See the logs | `journalctl -f -o cat /usr/bin/gnome-shell \| grep -i openrouter` |

KDE, XFCE and other desktops are not supported yet. This is a GNOME Shell extension.

## Development

```bash
git clone https://github.com/Qadees-ur-Rehman/openrouter-gnome-tray
cd openrouter-gnome-tray
./install.sh            # installs from the local checkout

# test in a nested shell without logging out:
dbus-run-session gnome-shell --devkit --wayland   # GNOME 49+
dbus-run-session -- gnome-shell --nested --wayland # GNOME 45-48
```

Files:

- `openrouter-usage@tray/extension.js`: the top-bar indicator and popup
- `openrouter-usage@tray/prefs.js`: the settings window
- `openrouter-usage@tray/keyring.js`: libsecret store, lookup and clear
- `openrouter-usage@tray/api.js`: calls `GET /api/v1/key`

## License

MIT
