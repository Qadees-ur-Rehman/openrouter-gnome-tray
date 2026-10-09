import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';

export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }

    get isAuthError() {
        return this.status === 401 || this.status === 403;
    }
}

export function createSession() {
    return new Soup.Session({timeout: 15, user_agent: 'openrouter-gnome-tray/1'});
}

// Returns the `data` object of GET /api/v1/key.
export async function fetchKeyInfo(session, apiKey, cancellable = null) {
    const message = Soup.Message.new('GET', KEY_ENDPOINT);
    message.request_headers.append('Authorization', `Bearer ${apiKey}`);
    message.request_headers.append('Accept', 'application/json');

    const bytes = await new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                resolve(s.send_and_read_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });

    const status = message.get_status();
    if (status === 401 || status === 403)
        throw new ApiError('OpenRouter rejected this API key', status);
    if (status === 429)
        throw new ApiError('Rate limited by OpenRouter, will retry', status);
    if (status !== 200)
        throw new ApiError(`OpenRouter returned HTTP ${status}`, status);

    let json;
    try {
        json = JSON.parse(new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()));
    } catch {
        throw new ApiError('OpenRouter sent an unreadable response', status);
    }
    if (!json?.data)
        throw new ApiError('OpenRouter sent an unexpected response', status);
    return json.data;
}
