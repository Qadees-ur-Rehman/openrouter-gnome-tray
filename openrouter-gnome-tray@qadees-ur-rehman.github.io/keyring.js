// Stores the OpenRouter API key in the user's Secret Service keyring
// (GNOME Keyring). The key is encrypted at rest with the login password and
// is never written to disk by this extension.
//
// Same entry as:
//   secret-tool lookup service openrouter-tray key api-key

const ATTRIBUTES = {service: 'openrouter-tray', key: 'api-key'};
const LABEL = 'OpenRouter Tray API Key';

let Secret = null;
let schema = null;

async function getSecret() {
    if (!Secret) {
        try {
            Secret = (await import('gi://Secret?version=1')).default;
        } catch {
            throw new Error('libsecret is missing. Install "gir1.2-secret-1" (Ubuntu/Debian) or "libsecret" (Fedora/Arch).');
        }
        // DONT_MATCH_NAME so keys stored with `secret-tool store` are found too.
        schema = new Secret.Schema(
            'org.gnome.shell.extensions.openrouter-usage',
            Secret.SchemaFlags.DONT_MATCH_NAME,
            {
                service: Secret.SchemaAttributeType.STRING,
                key: Secret.SchemaAttributeType.STRING,
            });
    }
    return Secret;
}

export async function lookupKey(cancellable = null) {
    const S = await getSecret();
    return new Promise((resolve, reject) => {
        S.password_lookup(schema, ATTRIBUTES, cancellable, (_src, res) => {
            try {
                resolve(S.password_lookup_finish(res) || null);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export async function storeKey(apiKey, cancellable = null) {
    const S = await getSecret();
    return new Promise((resolve, reject) => {
        S.password_store(schema, ATTRIBUTES, S.COLLECTION_DEFAULT, LABEL, apiKey,
            cancellable, (_src, res) => {
                try {
                    resolve(S.password_store_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export async function clearKey(cancellable = null) {
    const S = await getSecret();
    return new Promise((resolve, reject) => {
        S.password_clear(schema, ATTRIBUTES, cancellable, (_src, res) => {
            try {
                resolve(S.password_clear_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function maskKey(apiKey) {
    if (!apiKey || apiKey.length < 16)
        return '••••';
    return `${apiKey.slice(0, 10)}…${apiKey.slice(-3)}`;
}
