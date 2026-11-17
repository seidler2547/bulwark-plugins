// Connecting a Seafile account through the secret proxy.
//
// Sign-in through the browser: Seafile's own flow for its desktop clients
// ("client SSO via local browser", Seafile 11 and later, turned on with
// CLIENT_SSO_VIA_LOCAL_BROWSER). The plugin asks for a sign-in link, the
// user opens it and signs in the way Seafile is set up, with a password or
// through single sign-on (OAuth with Stalwart or another identity
// provider, SAML), and confirms. The plugin meanwhile asks for the result, and the
// proxy stores the token from that answer right away (capture), so the
// plugin never sees it. This is the only way in for accounts that have no
// Seafile password.
//
// With an API token: where the server doesn't offer the flow, the user
// pastes their Web API token into the host's own dialog.

import { CREDENTIAL, sfJson, sfRequest } from './client.js';
import { SfError } from './errors.js';
import { originOf } from './paths.js';

export const POLL_INTERVAL_MS = 3000;
/**
 * Seafile gives five minutes from the moment its page is opened; the link
 * itself waits for longer.
 */
export const POLL_TIMEOUT_MS = 15 * 60 * 1000;

// Seafile hands a token of its own to a client that says which device it
// is: it shows up under "Linked devices" and can be unlinked there, without
// touching the user's other tokens. It only knows desktop and mobile
// platforms. A client that says nothing gets the account's general token.
export const DEVICE_PLATFORM = 'linux';
export const DEVICE_NAME = 'Bulwark Mail';

/**
 * The first Seafile that was seen to cope when only part of the device
 * details reach it: it then hands out the general token. That does happen:
 * Seafile's login page drops all but the first of them when the user takes
 * "Single Sign-On" there. Older versions fail on the user's confirmation
 * in that case, so they are told nothing about the device.
 */
export const DEVICE_SINCE = [14, 0, 9];

/** Whether a Seafile of this version can be told which device signs in. */
export function takesDevice(version) {
  const parts = String(version ?? '').split('.').map((n) => parseInt(n, 10));
  if (!Number.isFinite(parts[0])) return false;
  for (let i = 0; i < DEVICE_SINCE.length; i++) {
    const have = Number.isFinite(parts[i]) ? parts[i] : 0;
    if (have !== DEVICE_SINCE[i]) return have > DEVICE_SINCE[i];
  }
  return true;
}

/**
 * The device id the webmail signs in with: 40 hex characters, the same for
 * a server from every browser, so that disconnecting anywhere unlinks it.
 */
export function deviceId(origin) {
  const text = `bulwark-mail:${origin}`;
  let out = '';
  for (let round = 0; round < 5; round++) {
    let h = (0x811c9dc5 ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

/**
 * The server the administrator fixed (configSchema serverUrl), as an origin,
 * or null. api.config.get returns the plugin's non-secret admin settings
 * without the admin:config permission.
 */
export async function adminServer(api) {
  try {
    const config = await api.config.get();
    return originOf(config?.serverUrl) ?? null;
  } catch {
    return null;
  }
}

/** The stored account for this plugin, connected or not, or null. */
export async function storedAccount(api) {
  let list;
  try {
    list = await api.proxy.accounts();
  } catch {
    return null;
  }
  const account = Array.isArray(list) ? list.find((a) => a.credentialId === CREDENTIAL) : null;
  return account ?? null;
}

function userKey(origin, username) {
  return `user:${origin}:${username ?? ''}`;
}

/**
 * The connection to use, or null when there is none. Throws SfError
 * "wrong_server" when the account is for a server other than the one the
 * administrator fixed, and the errors of the account lookup.
 */
export async function getConnection(api, { fixedServer } = {}) {
  const account = await storedAccount(api);
  if (!account || !account.connected) return null;
  const fixed = fixedServer === undefined ? await adminServer(api) : fixedServer;
  if (fixed && account.origin !== fixed) throw new SfError('wrong_server');
  const base = { origin: account.origin, username: account.username ?? '' };
  // A sign-in through the browser stores Seafile's user id with the token,
  // so what is remembered about that user can't be someone else's. A pasted
  // token names nobody: ask every time.
  const key = account.username ? userKey(account.origin, account.username) : null;
  const cached = key ? await api.storage.get(key) : null;
  if (cached && typeof cached.userId === 'string' && cached.userId) {
    return { ...base, userId: cached.userId, displayName: cached.displayName ?? '', email: cached.email ?? '' };
  }
  const data = await sfJson(api, `${account.origin}/api2/account/info/`);
  const userId = typeof data?.email === 'string' && data.email ? data.email : '';
  if (!userId) throw new SfError('bad_answer');
  const who = {
    userId,
    displayName: typeof data.name === 'string' ? data.name : '',
    email: [data.contact_email, data.login_id].find((v) => typeof v === 'string' && v) ?? '',
  };
  if (key) await api.storage.set(key, who);
  return { ...base, ...who };
}

/**
 * Step 1: the host's dialog, where the user approves the server. Returns the
 * approved origin, or null when they cancelled.
 */
export async function approveServer(api, { fixedServer, suggestedServer } = {}) {
  const server = fixedServer || suggestedServer || undefined;
  const result = await api.proxy.connect(CREDENTIAL, { mode: 'signin', ...(server ? { server } : {}) });
  const origin = result?.origin ? originOf(result.origin) : null;
  if (!origin) return null;
  if (fixedServer && origin !== fixedServer) {
    await api.proxy.disconnect(CREDENTIAL).catch(() => {});
    throw new SfError('wrong_server');
  }
  return origin;
}

/** Whether a Seafile answers at this address, and what it says about itself. */
export async function serverInfo(api, origin) {
  try {
    const data = await sfJson(api, `${origin}/api2/server-info/`);
    if (typeof data?.version !== 'string') return null;
    return { version: data.version, features: Array.isArray(data.features) ? data.features.map(String) : [] };
  } catch {
    return null;
  }
}

/**
 * Step 2: ask Seafile for a sign-in link. The link works once: opening the
 * page again takes a new one.
 */
export async function startSignIn(api, origin) {
  let data;
  try {
    data = await sfJson(api, `${origin}/api2/client-sso-link/`, { method: 'POST' });
  } catch (err) {
    // Seafile only has this address when the administrator turned the flow on.
    if (err instanceof SfError && ['not_found', 'forbidden', 'rejected', 'bad_answer', 'unknown'].includes(err.code)) {
      throw new SfError((await serverInfo(api, origin)) ? 'no_browser_signin' : 'not_seafile');
    }
    throw err;
  }
  let link;
  try { link = new URL(String(data?.link ?? '')); } catch { throw new SfError('bad_answer', { detail: 'sign-in link' }); }
  const token = /\/client-sso\/([A-Za-z0-9]{16,128})\/?$/.exec(link.pathname)?.[1];
  if ((link.protocol !== 'https:' && link.protocol !== 'http:') || !token) throw new SfError('bad_answer', { detail: 'sign-in link' });
  // The device goes into the page's address, which Seafile carries through
  // its login to the confirmation.
  const device = takesDevice((await serverInfo(api, origin))?.version);
  if (device) {
    link.searchParams.set('shib_platform', DEVICE_PLATFORM);
    link.searchParams.set('shib_device_id', deviceId(origin));
    link.searchParams.set('shib_device_name', DEVICE_NAME);
    link.searchParams.set('shib_client_version', String(api.plugin?.version ?? '1'));
    link.searchParams.set('shib_platform_version', 'web');
  }
  return { loginUrl: link.toString(), token, device };
}

/** Wait `ms`, or reject with "cancelled" when `signal` aborts first. Leaves no listener behind. */
export function sleepFor(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new SfError('cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Step 3: wait until the user signed in and confirmed on Seafile's page.
 * The proxy keeps the token; resolves once it did.
 */
export async function pollSignIn(api, origin, { token }, { signal, intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS, sleep = sleepFor, now = Date.now } = {}) {
  const started = now();
  const url = `${origin}/api2/client-sso-link/${encodeURIComponent(token)}/`;
  for (;;) {
    if (signal?.aborted) throw new SfError('cancelled');
    let pause = intervalMs;
    try {
      const res = await sfRequest(api, url, {
        method: 'GET',
        responseType: 'json',
        capture: { secret: 'apiToken', username: 'username' },
        signal,
      });
      if (res.body?.captured) return true;
      const status = res.body?.status;
      if (status === 'success') throw new SfError('bad_answer', { detail: 'no token' });
      // "error": the five minutes on Seafile's page ran out.
      if (status === 'error') throw new SfError('login_expired');
      if (status !== 'waiting') throw new SfError('bad_answer', { detail: 'sign-in status' });
    } catch (err) {
      if (err instanceof SfError && err.code === 'not_found') throw new SfError('login_expired');
      // Everyone signing in from this webmail asks from one address, and
      // Seafile counts them together. Ask again later.
      if (!(err instanceof SfError) || err.code !== 'rate_limited') throw err;
      pause = intervalMs * 5;
    }
    if (now() - started > timeoutMs) throw new SfError('login_expired');
    await sleep(pause, signal);
  }
}

/**
 * Connect with a token the user pastes into the host's dialog: the Web API
 * token from their Seafile profile. Resolves to the connection, or null
 * when they cancelled. A token Seafile doesn't take is forgotten again.
 */
export async function connectWithToken(api, { fixedServer, suggestedServer } = {}) {
  const server = fixedServer || suggestedServer || undefined;
  const result = await api.proxy.connect(CREDENTIAL, { mode: 'password', ...(server ? { server } : {}) });
  if (!result?.connected) return null;
  const drop = () => api.proxy.disconnect(CREDENTIAL).catch(() => {});
  try {
    return await getConnection(api, { fixedServer: fixedServer ?? null });
  } catch (err) {
    if (!(err instanceof SfError)) throw err;
    if (err.code === 'wrong_server') { await drop(); throw err; }
    if (err.code === 'auth' || err.code === 'forbidden') { await drop(); throw new SfError('token_rejected'); }
    if (err.code === 'not_found' || err.code === 'bad_answer') { await drop(); throw new SfError('not_seafile'); }
    throw err;
  }
}

/**
 * Forget the account here. After a sign-in through the browser the webmail
 * is also unlinked in Seafile, which ends its token where Seafile gave it
 * one of its own. The account's general token, which the user pasted or
 * Seafile handed out instead, may be used elsewhere too and stays as it is:
 * unlinking a device that isn't there changes nothing.
 */
export async function disconnect(api) {
  const account = await storedAccount(api);
  if (account?.connected && account.username) {
    // Best effort: a token that stopped working can't unlink itself.
    await sfRequest(api, `${account.origin}/api2/devices/`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: `platform=${DEVICE_PLATFORM}&device_id=${deviceId(account.origin)}`,
    }).catch(() => {});
  }
  if (account) await api.storage.remove(userKey(account.origin, account.username)).catch(() => {});
  await api.proxy.disconnect(CREDENTIAL);
}
