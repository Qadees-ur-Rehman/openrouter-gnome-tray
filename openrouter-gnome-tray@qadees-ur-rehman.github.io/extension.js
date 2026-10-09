import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ApiError, createSession, fetchKeyInfo} from './api.js';
import {lookupKey, storeKey} from './keyring.js';

const KEYS_URL = 'https://openrouter.ai/settings/keys';
const ACTIVITY_URL = 'https://openrouter.ai/activity';
const WARN_FRACTION = 0.75;
const CRITICAL_FRACTION = 0.9;

function vbox(params = {}) {
    const box = new St.BoxLayout(params);
    // GNOME 48 replaced `vertical` with `orientation`.
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

function isNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function formatMoney(v) {
    if (!isNumber(v))
        return '—';
    if (v !== 0 && Math.abs(v) < 0.01)
        return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function friendlyError(e) {
    if (e instanceof ApiError)
        return e.message;
    if (e instanceof GLib.Error)
        return "Can't reach OpenRouter";
    return e?.message ?? String(e);
}

// Fraction of the spending limit used, or null when the key has no limit.
function usedFraction(d) {
    if (!isNumber(d.limit) || d.limit <= 0)
        return null;
    const used = isNumber(d.limit_remaining) ? d.limit - d.limit_remaining : d.usage;
    return Math.min(Math.max(used / d.limit, 0), 1);
}

const OpenRouterIndicator = GObject.registerClass(
class OpenRouterIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'OpenRouter Usage', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._session = createSession();
        this._cancellable = new Gio.Cancellable();

        this._apiKey = null;
        this._data = null;
        this._lastUpdated = null;
        this._state = 'loading'; // loading | ok | error | nokey | invalid
        this._error = '';
        this._busy = false;
        this._editingKey = false;
        this._fraction = 0;
        this._timerId = 0;
        this._focusId = 0;
        this._destroyed = false;

        this._gicon = new Gio.FileIcon({
            file: Gio.File.new_for_path(
                GLib.build_filenamev([extension.path, 'icons', 'openrouter-symbolic.svg'])),
        });

        const panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({gicon: this._gicon, style_class: 'system-status-icon'});
        this._panelLabel = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'openrouter-panel-label',
        });
        panelBox.add_child(this._panelIcon);
        panelBox.add_child(this._panelLabel);
        this.add_child(panelBox);

        this.menu.box.add_style_class_name('openrouter-menu');
        this._buildMenu();
        this.menu.connect('open-state-changed', (_menu, open) => this._onMenuToggled(open));

        this._settingsIds = [
            this._settings.connect('changed::refresh-interval', () => {
                this._restartTimer();
                this._updateUI();
            }),
            this._settings.connect('changed::panel-display', () => this._updateUI()),
            this._settings.connect('changed::show-icon', () => this._updateUI()),
            this._settings.connect('changed::key-revision', () => this._loadKeyAndRefresh()),
        ];

        this._restartTimer();
        this._updateUI();
        this._loadKeyAndRefresh();
    }

    // ---------- menu construction ----------

    _buildMenu() {
        // Header: icon, title, connection status
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const headerBox = new St.BoxLayout({style_class: 'openrouter-header', x_expand: true});
        headerBox.add_child(new St.Icon({
            gicon: this._gicon,
            icon_size: 28,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const titleBox = vbox({y_align: Clutter.ActorAlign.CENTER});
        titleBox.add_child(new St.Label({text: 'OpenRouter', style_class: 'openrouter-title'}));
        const statusBox = new St.BoxLayout({style_class: 'openrouter-status-box'});
        this._statusDot = new St.Widget({
            style_class: 'openrouter-status-dot',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._statusText = new St.Label({
            text: 'Loading…',
            style_class: 'openrouter-status-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusBox.add_child(this._statusDot);
        statusBox.add_child(this._statusText);
        titleBox.add_child(statusBox);
        headerBox.add_child(titleBox);
        header.add_child(headerBox);
        this.menu.addMenuItem(header);

        this._buildSetupSection();
        this._buildDataSection();

        // Action buttons
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const actions = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const actionBox = new St.BoxLayout({style_class: 'openrouter-actions', x_expand: true});
        this._refreshButton = this._makeButton('view-refresh-symbolic', 'Refresh',
            () => this._refresh(), 'openrouter-primary');
        this._changeKeyButton = this._makeButton('dialog-password-symbolic', 'Key',
            () => this._startEditingKey());
        const settingsButton = this._makeButton('preferences-system-symbolic', 'Settings', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        actionBox.add_child(this._refreshButton);
        actionBox.add_child(this._changeKeyButton);
        actionBox.add_child(settingsButton);
        actions.add_child(actionBox);
        this.menu.addMenuItem(actions);

        const activityItem = new PopupMenu.PopupImageMenuItem('Open OpenRouter activity', 'web-browser-symbolic');
        activityItem.connect('activate', () => this._openUrl(ACTIVITY_URL));
        this.menu.addMenuItem(activityItem);
    }

    _buildSetupSection() {
        this._setupSection = new PopupMenu.PopupMenuSection();
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox({x_expand: true, style_class: 'openrouter-setup'});

        box.add_child(new St.Label({
            text: 'Paste your OpenRouter API key',
            style_class: 'openrouter-setup-title',
        }));
        const hint = new St.Label({
            text: 'It is checked with OpenRouter, then stored encrypted in your GNOME Keyring.',
            style_class: 'openrouter-dim',
        });
        hint.clutter_text.line_wrap = true;
        box.add_child(hint);

        this._keyEntry = new St.Entry({
            hint_text: 'sk-or-v1-…',
            can_focus: true,
            x_expand: true,
            style_class: 'openrouter-entry',
        });
        this._keyEntry.clutter_text.set_password_char('●');
        this._keyEntry.clutter_text.connect('activate', () => this._saveKeyFromEntry());
        box.add_child(this._keyEntry);

        this._setupError = new St.Label({style_class: 'openrouter-error', visible: false});
        this._setupError.clutter_text.line_wrap = true;
        box.add_child(this._setupError);

        const buttons = new St.BoxLayout({style_class: 'openrouter-actions', x_expand: true});
        this._saveButton = this._makeButton('emblem-ok-symbolic', 'Save key',
            () => this._saveKeyFromEntry(), 'openrouter-primary');
        this._cancelKeyButton = this._makeButton('window-close-symbolic', 'Cancel', () => {
            this._editingKey = false;
            this._keyEntry.set_text('');
            this._setupError.hide();
            this._updateUI();
        });
        const getKeyButton = this._makeButton('web-browser-symbolic', 'Get a key',
            () => this._openUrl(KEYS_URL));
        buttons.add_child(this._saveButton);
        buttons.add_child(getKeyButton);
        buttons.add_child(this._cancelKeyButton);
        box.add_child(buttons);

        item.add_child(box);
        this._setupSection.addMenuItem(item);
        this.menu.addMenuItem(this._setupSection);
    }

    _buildDataSection() {
        this._dataSection = new PopupMenu.PopupMenuSection();

        // Usage card with progress bar
        const cardItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const card = vbox({style_class: 'openrouter-card', x_expand: true});

        const top = new St.BoxLayout({x_expand: true});
        this._usageTitle = new St.Label({
            text: 'Usage',
            style_class: 'openrouter-usage-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        this._usageAmount = new St.Label({style_class: 'openrouter-usage-amount', y_align: Clutter.ActorAlign.END});
        this._usageLimit = new St.Label({style_class: 'openrouter-usage-limit', y_align: Clutter.ActorAlign.END});
        top.add_child(this._usageTitle);
        top.add_child(this._usageAmount);
        top.add_child(this._usageLimit);
        card.add_child(top);

        this._barTrack = new St.Widget({style_class: 'openrouter-progress-track', x_expand: true});
        this._barFill = new St.Widget({style_class: 'openrouter-progress-fill'});
        this._barTrack.add_child(this._barFill);
        this._barTrack.connect('notify::width', () => this._syncBar());
        card.add_child(this._barTrack);

        const bottom = new St.BoxLayout({x_expand: true});
        this._percentLabel = new St.Label({style_class: 'openrouter-dim', x_expand: true});
        this._remainingLabel = new St.Label({style_class: 'openrouter-good'});
        bottom.add_child(this._percentLabel);
        bottom.add_child(this._remainingLabel);
        card.add_child(bottom);

        cardItem.add_child(card);
        this._dataSection.addMenuItem(cardItem);

        this._dataSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._todayRow = this._addRow('x-office-calendar-symbolic', 'Today');
        this._weekRow = this._addRow('x-office-calendar-symbolic', 'This week');
        this._monthRow = this._addRow('x-office-calendar-symbolic', 'This month');
        this._byokRow = this._addRow('network-server-symbolic', 'BYOK usage (month)');

        this._dataSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._freeRow = this._addRow('starred-symbolic', 'Free-model requests today');
        this._limitRow = this._addRow('security-medium-symbolic', 'Spending limit');
        this._expiresRow = this._addRow('alarm-symbolic', 'Key expires');

        this._dataSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._updatedRow = this._addRow('document-open-recent-symbolic', 'Last updated');

        this.menu.addMenuItem(this._dataSection);
    }

    _addRow(iconName, text) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_child(new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon'}));
        const label = new St.Label({text, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const value = new St.Label({
            text: '—',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'openrouter-row-value',
        });
        item.add_child(label);
        item.add_child(value);
        this._dataSection.addMenuItem(item);
        return {item, label, value};
    }

    _makeButton(iconName, text, onClick, extraClass = '') {
        const box = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style_class: 'openrouter-button-box'});
        box.add_child(new St.Icon({icon_name: iconName, icon_size: 16}));
        const label = new St.Label({text, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(label);
        const button = new St.Button({
            child: box,
            style_class: `button openrouter-button ${extraClass}`.trim(),
            can_focus: true,
            x_expand: true,
        });
        button._label = label;
        button.connect('clicked', onClick);
        return button;
    }

    // ---------- behaviour ----------

    _onMenuToggled(open) {
        if (!open)
            return;
        if (this._needsKeyEntry()) {
            this._focusEntrySoon();
            return;
        }
        const ageSeconds = this._lastUpdated
            ? GLib.DateTime.new_now_local().difference(this._lastUpdated) / GLib.TIME_SPAN_SECOND
            : Infinity;
        if (ageSeconds > 20)
            this._refresh();
    }

    _focusEntrySoon() {
        if (this._focusId)
            GLib.source_remove(this._focusId);
        this._focusId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusId = 0;
            this._keyEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startEditingKey() {
        this._editingKey = true;
        this._setupError.hide();
        this._updateUI();
        this._focusEntrySoon();
    }

    _openUrl(url) {
        this.menu.close();
        try {
            Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1));
        } catch (e) {
            console.error(`OpenRouter Usage: could not open ${url}: ${e.message}`);
        }
    }

    _restartTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        const interval = Math.max(30, this._settings.get_int('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            if (this._state !== 'invalid')
                this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _loadKeyAndRefresh() {
        try {
            this._apiKey = await lookupKey(this._cancellable);
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return;
            this._apiKey = null;
            this._state = 'error';
            this._error = `Keyring unavailable: ${e.message}`;
            this._updateUI();
            return;
        }
        if (this._destroyed)
            return;

        if (!this._apiKey) {
            this._data = null;
            this._state = 'nokey';
            this._updateUI();
            return;
        }
        this._editingKey = false;
        this._state = 'loading';
        await this._refresh();
    }

    async _refresh() {
        if (this._busy || !this._apiKey || this._destroyed)
            return;
        this._busy = true;
        this._updateUI();
        try {
            this._data = await fetchKeyInfo(this._session, this._apiKey, this._cancellable);
            this._lastUpdated = GLib.DateTime.new_now_local();
            this._state = 'ok';
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return;
            if (e instanceof ApiError && e.isAuthError) {
                this._state = 'invalid';
                this._data = null;
            } else {
                this._state = 'error';
                this._error = friendlyError(e);
            }
        } finally {
            this._busy = false;
        }
        this._updateUI();
    }

    async _saveKeyFromEntry() {
        const key = this._keyEntry.get_text().trim();
        if (!key) {
            this._showSetupError('Paste your key first.');
            return;
        }
        if (!key.startsWith('sk-or-')) {
            this._showSetupError('That does not look like an OpenRouter key (it should start with "sk-or-").');
            return;
        }

        this._saveButton.reactive = false;
        this._saveButton._label.text = 'Checking…';
        this._setupError.hide();

        const data = await this._trySaveStep(
            () => fetchKeyInfo(this._session, key, this._cancellable),
            e => e instanceof ApiError && e.isAuthError
                ? 'OpenRouter rejected this key. Check it and try again.'
                : `${friendlyError(e)}. Your key was not saved.`);
        const stored = data && await this._trySaveStep(
            () => storeKey(key, this._cancellable).then(() => true),
            e => `Could not save to the keyring: ${e.message}`);

        if (this._destroyed)
            return;
        this._saveButton.reactive = true;
        this._saveButton._label.text = 'Save key';
        if (!stored)
            return;

        this._apiKey = key;
        this._data = data;
        this._lastUpdated = GLib.DateTime.new_now_local();
        this._state = 'ok';
        this._editingKey = false;
        this._keyEntry.set_text('');
        this._updateUI();
    }

    // Runs one step of saving a key; on failure shows a message and returns null.
    async _trySaveStep(step, describeError) {
        try {
            return await step();
        } catch (e) {
            if (!isCancelled(e) && !this._destroyed)
                this._showSetupError(describeError(e));
            return null;
        }
    }

    _showSetupError(text) {
        this._setupError.text = text;
        this._setupError.show();
    }

    _needsKeyEntry() {
        return !this._apiKey || this._editingKey || this._state === 'invalid';
    }

    // ---------- rendering ----------

    _updateUI() {
        if (this._destroyed)
            return;
        const d = this._data;
        const needsKey = this._needsKeyEntry();

        this._setupSection.actor.visible = needsKey;
        this._cancelKeyButton.visible = !!this._apiKey && this._state !== 'invalid';
        this._dataSection.actor.visible = !!d && !needsKey;
        this._refreshButton.reactive = !!this._apiKey && !this._busy;
        this._refreshButton._label.text = this._busy ? 'Updating…' : 'Refresh';
        this._changeKeyButton.visible = !needsKey;

        this._updateStatus();
        if (d)
            this._updateData(d);
        this._updatePanel();
    }

    _updateStatus() {
        let cls = 'idle';
        let text;
        switch (this._state) {
        case 'nokey':
            text = 'No API key yet';
            break;
        case 'invalid':
            cls = 'error';
            text = 'Key rejected, paste a new one';
            break;
        case 'error':
            cls = 'error';
            text = this._error || 'Error';
            break;
        case 'ok':
            cls = 'ok';
            text = this._data?.is_free_tier ? 'Connected · free tier' : 'Connected';
            break;
        default:
            cls = 'loading';
            text = 'Connecting…';
        }
        if (this._busy && this._state === 'ok')
            text = 'Updating…';

        for (const c of ['ok', 'error', 'loading', 'idle'])
            this._statusDot.remove_style_class_name(c);
        this._statusDot.add_style_class_name(cls);
        this._statusText.text = text;
    }

    _updateData(d) {
        const fraction = usedFraction(d);

        if (fraction !== null) {
            const used = isNumber(d.limit_remaining) ? d.limit - d.limit_remaining : d.usage;
            this._usageTitle.text = d.limit_reset ? `Usage (${d.limit_reset})` : 'Usage';
            this._usageAmount.text = formatMoney(used);
            this._usageLimit.text = ` / ${formatMoney(d.limit)}`;
            this._percentLabel.text = `${Math.round(fraction * 100)}% used`;
            this._remainingLabel.text = `${formatMoney(d.limit_remaining)} remaining`;
            this._setLevelClass(this._remainingLabel, fraction, 'openrouter-good');
            this._barTrack.show();
            this._fraction = fraction;
            this._setLevelClass(this._barFill, fraction);
            this._syncBar();
        } else {
            this._usageTitle.text = 'Total usage';
            this._usageAmount.text = formatMoney(d.usage);
            this._usageLimit.text = '';
            this._percentLabel.text = 'No spending limit on this key';
            this._remainingLabel.text = '';
            this._barTrack.hide();
        }

        this._todayRow.value.text = formatMoney(d.usage_daily);
        this._weekRow.value.text = formatMoney(d.usage_weekly);
        this._monthRow.value.text = formatMoney(d.usage_monthly);

        const byok = d.byok_usage_monthly;
        this._byokRow.item.visible = isNumber(byok) && byok > 0;
        this._byokRow.value.text = formatMoney(byok);

        const free = d.free_model_daily_requests;
        this._freeRow.item.visible = !!free && isNumber(free.limit);
        if (free)
            this._freeRow.value.text = `${free.used ?? 0} / ${free.limit}`;

        if (isNumber(d.limit)) {
            const reset = d.limit_reset ? `resets ${d.limit_reset}` : 'no reset';
            this._limitRow.value.text = `${formatMoney(d.limit)} · ${reset}`;
        } else {
            this._limitRow.value.text = 'None';
        }

        this._expiresRow.item.visible = !!d.expires_at;
        if (d.expires_at) {
            const dt = GLib.DateTime.new_from_iso8601(d.expires_at, null);
            this._expiresRow.value.text = dt ? dt.to_local().format('%b %e, %Y') : d.expires_at;
        }

        const interval = this._settings.get_int('refresh-interval');
        const every = interval % 60 === 0 ? `${interval / 60} min` : `${interval}s`;
        this._updatedRow.value.text = this._lastUpdated
            ? `${this._lastUpdated.format('%H:%M:%S')} · every ${every}`
            : '—';
    }

    _setLevelClass(actor, fraction, okClass = null) {
        actor.remove_style_class_name('warning');
        actor.remove_style_class_name('critical');
        if (okClass)
            actor.remove_style_class_name(okClass);
        if (fraction >= CRITICAL_FRACTION)
            actor.add_style_class_name('critical');
        else if (fraction >= WARN_FRACTION)
            actor.add_style_class_name('warning');
        else if (okClass)
            actor.add_style_class_name(okClass);
    }

    _syncBar() {
        const width = Math.round(this._barTrack.width * this._fraction);
        if (this._barFill.width !== width)
            this._barFill.width = width;
    }

    _panelText(d) {
        const mode = this._settings.get_string('panel-display');
        const fraction = usedFraction(d);
        const free = d.free_model_daily_requests;

        switch (mode) {
        case 'icon':
            return '';
        case 'usage':
            return formatMoney(d.usage);
        case 'today':
            return `${formatMoney(d.usage_daily)} today`;
        case 'remaining':
            return fraction !== null ? `${formatMoney(d.limit_remaining)} left` : formatMoney(d.usage);
        case 'percent':
            return fraction !== null ? `${Math.round(fraction * 100)}%` : formatMoney(d.usage);
        default: // smart
            if (fraction !== null)
                return `${formatMoney(d.limit_remaining)} left`;
            if (d.is_free_tier && free && isNumber(free.remaining))
                return `${free.remaining} free left`;
            return `${formatMoney(d.usage_daily)} today`;
        }
    }

    _updatePanel() {
        const label = this._panelLabel;
        for (const c of ['warning', 'critical', 'stale'])
            label.remove_style_class_name(c);

        let text;
        if (this._state === 'nokey')
            text = 'Set key';
        else if (this._state === 'invalid')
            text = 'Bad key';
        else if (!this._data)
            text = this._state === 'error' ? 'Offline' : '…';
        else
            text = this._panelText(this._data);

        if (this._data && this._state === 'ok') {
            const fraction = usedFraction(this._data);
            if (fraction !== null)
                this._setLevelClass(label, fraction);
        } else if (this._data && this._state === 'error') {
            label.add_style_class_name('stale');
        }

        label.text = text;
        label.visible = text !== '';
        this._panelIcon.visible = this._settings.get_boolean('show-icon') || text === '';
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._focusId) {
            GLib.source_remove(this._focusId);
            this._focusId = 0;
        }
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._settingsIds = [];
        this._session.abort();
        this._apiKey = null;
        this._data = null;
        super.destroy();
    }
});

export default class OpenRouterUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._addIndicator();
        this._positionId = this._settings.connect('changed::panel-position', () => {
            this._indicator?.destroy();
            this._addIndicator();
        });
    }

    _addIndicator() {
        this._indicator = new OpenRouterIndicator(this);
        const position = this._settings.get_string('panel-position');
        if (position === 'left')
            Main.panel.addToStatusArea(this.uuid, this._indicator, -1, 'left');
        else if (position === 'center')
            Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'center');
        else
            Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        if (this._positionId) {
            this._settings.disconnect(this._positionId);
            this._positionId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
