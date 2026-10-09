import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ApiError, createSession, fetchKeyInfo} from './api.js';
import {clearKey, lookupKey, maskKey, storeKey} from './keyring.js';

const KEYS_URL = 'https://openrouter.ai/settings/keys';

const DISPLAY_MODES = [
    ['smart', 'Smart (remaining if a limit is set, else today)'],
    ['remaining', 'Remaining budget'],
    ['usage', 'Total usage'],
    ['today', "Today's usage"],
    ['percent', 'Percent of limit used'],
    ['icon', 'Icon only'],
];

const POSITIONS = [
    ['right', 'Right (next to system menu)'],
    ['center', 'Center (next to clock)'],
    ['left', 'Left'],
];

function bindChoice(settings, key, choices, row) {
    row.model = Gtk.StringList.new(choices.map(([, label]) => label));
    const sync = () => {
        const index = choices.findIndex(([id]) => id === settings.get_string(key));
        row.selected = Math.max(index, 0);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const id = choices[row.selected]?.[0];
        if (id && id !== settings.get_string(key))
            settings.set_string(key, id);
    });
}

export default class OpenRouterUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const session = createSession();
        window._settings = settings;
        window.set_default_size(560, 680);

        const toast = text => window.add_toast(new Adw.Toast({
            title: GLib.markup_escape_text(text, -1),
            timeout: 4,
        }));
        const keyChanged = () => settings.set_int('key-revision', settings.get_int('key-revision') + 1);

        const page = new Adw.PreferencesPage({title: 'OpenRouter Usage', icon_name: 'dialog-password-symbolic'});
        window.add(page);

        // --- API key ---
        const keyGroup = new Adw.PreferencesGroup({
            title: 'API key',
            description: 'Your key is stored encrypted in the GNOME Keyring, never in a plain file.',
        });
        page.add(keyGroup);

        const statusRow = new Adw.ActionRow({title: 'Saved key', subtitle: 'Checking keyring…'});
        const removeButton = new Gtk.Button({
            label: 'Remove',
            valign: Gtk.Align.CENTER,
            sensitive: false,
            css_classes: ['destructive-action'],
        });
        statusRow.add_suffix(removeButton);
        keyGroup.add(statusRow);

        const keyRow = new Adw.PasswordEntryRow({
            title: 'Paste a new key and press Enter',
            show_apply_button: true,
        });
        keyGroup.add(keyRow);

        const getKeyRow = new Adw.ActionRow({
            title: 'Get or manage keys on openrouter.ai',
            activatable: true,
        });
        getKeyRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        getKeyRow.connect('activated', () =>
            new Gtk.UriLauncher({uri: KEYS_URL}).launch(window, null, null));
        keyGroup.add(getKeyRow);

        const refreshStatus = async () => {
            try {
                const key = await lookupKey();
                statusRow.subtitle = key ? `${maskKey(key)} (in GNOME Keyring)` : 'No key saved yet';
                removeButton.sensitive = !!key;
            } catch (e) {
                statusRow.subtitle = `Keyring unavailable: ${e.message}`;
                removeButton.sensitive = false;
            }
        };

        keyRow.connect('apply', async () => {
            const key = keyRow.text.trim();
            if (!key)
                return;
            if (!key.startsWith('sk-or-')) {
                toast('That does not look like an OpenRouter key (it starts with "sk-or-").');
                return;
            }
            keyRow.sensitive = false;
            statusRow.subtitle = 'Checking the key with OpenRouter…';
            try {
                await fetchKeyInfo(session, key);
            } catch (e) {
                toast(e instanceof ApiError && e.isAuthError
                    ? 'OpenRouter rejected this key.'
                    : `Could not verify the key: ${e.message}`);
                keyRow.sensitive = true;
                await refreshStatus();
                return;
            }
            try {
                await storeKey(key);
                keyRow.text = '';
                keyChanged();
                toast('Key saved to your keyring');
            } catch (e) {
                toast(`Could not save to the keyring: ${e.message}`);
            }
            keyRow.sensitive = true;
            await refreshStatus();
        });

        removeButton.connect('clicked', async () => {
            try {
                await clearKey();
                keyChanged();
                toast('Key removed from your keyring');
            } catch (e) {
                toast(`Could not remove the key: ${e.message}`);
            }
            await refreshStatus();
        });

        refreshStatus();

        // --- Display ---
        const displayGroup = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(displayGroup);

        const modeRow = new Adw.ComboRow({title: 'Label shows'});
        bindChoice(settings, 'panel-display', DISPLAY_MODES, modeRow);
        displayGroup.add(modeRow);

        const positionRow = new Adw.ComboRow({title: 'Position'});
        bindChoice(settings, 'panel-position', POSITIONS, positionRow);
        displayGroup.add(positionRow);

        const iconRow = new Adw.SwitchRow({title: 'Show icon'});
        settings.bind('show-icon', iconRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(iconRow);

        const intervalRow = Adw.SpinRow.new_with_range(30, 3600, 30);
        intervalRow.title = 'Refresh every (seconds)';
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(intervalRow);

        // --- Security note ---
        const aboutGroup = new Adw.PreferencesGroup({
            title: 'How your key is protected',
            description:
                '• Stored through libsecret in your login keyring, encrypted with your login password.\n' +
                '• Never written to settings, logs or files by this extension.\n' +
                '• Sent only to openrouter.ai over HTTPS.\n' +
                '• Tip: give this key a spending limit on openrouter.ai so a leak can only cost so much.',
        });
        page.add(aboutGroup);
    }
}
