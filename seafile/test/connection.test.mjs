import { describe, it, expect } from 'vitest';
import { fakeApi, proxyResponse } from '../../test-utils/fake-api.mjs';
import { fakeSeafile, seafileApi, ORIGIN, USER } from './fake-seafile.mjs';
import {
  adminServer, approveServer, getConnection, serverInfo, startSignIn, pollSignIn, connectWithToken, disconnect, sleepFor,
  deviceId, takesDevice, DEVICE_NAME, DEVICE_PLATFORM, POLL_INTERVAL_MS,
} from '../src/lib/connection.js';

const noSleep = async () => {};

describe('before signing in', () => {
  it('reads the server the admin fixed', async () => {
    const api = fakeApi({ handlers: { 'config.get': async () => ({ serverUrl: 'files.example.com/seafile/' }) } });
    expect(await adminServer(api)).toBe(ORIGIN);
    const none = fakeApi({ handlers: { 'config.get': async () => { throw new Error('no'); } } });
    expect(await adminServer(none)).toBeNull();
  });

  it('asks the host to approve the server in sign-in mode, with the fixed server', async () => {
    const api = fakeApi({ handlers: { 'proxy.connect': async () => ({ connected: false, origin: ORIGIN }) } });
    expect(await approveServer(api, { fixedServer: ORIGIN })).toBe(ORIGIN);
    expect(api.calls('proxy.connect')[0].args).toEqual(['seafile', { mode: 'signin', server: ORIGIN }]);
  });

  it('refuses and forgets a server other than the fixed one', async () => {
    const api = fakeApi({ handlers: { 'proxy.connect': async () => ({ connected: false, origin: 'https://evil.example' }), 'proxy.disconnect': async () => true } });
    await expect(approveServer(api, { fixedServer: ORIGIN })).rejects.toMatchObject({ code: 'wrong_server' });
    expect(api.calls('proxy.disconnect')).toHaveLength(1);
  });

  it('returns null when the user cancels the host dialog', async () => {
    const api = fakeApi({ handlers: { 'proxy.connect': async () => ({ connected: false }) } });
    expect(await approveServer(api, {})).toBeNull();
  });

  it('asks a server what it is', async () => {
    const sf = fakeSeafile();
    expect(await serverInfo(seafileApi(sf, { account: null }), ORIGIN)).toEqual({ version: '14.0.9', features: ['seafile-basic', 'client-sso-via-local-browser'] });
    const other = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse('<html>hello</html>') } });
    expect(await serverInfo(other, ORIGIN)).toBeNull();
  });
});

describe('the device the webmail signs in as', () => {
  it('has an id of 40 hex characters that only depends on the server', () => {
    const id = deviceId(ORIGIN);
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    // The same from every browser, so disconnecting anywhere can unlink it.
    expect(deviceId(ORIGIN)).toBe(id);
    expect(deviceId('https://other.example.com')).not.toBe(id);
    expect(DEVICE_PLATFORM).toBe('linux');
  });

  it('is only named to a Seafile that copes when part of it gets lost on the way', () => {
    // Seafile's login page drops all but the first detail on "Single Sign-On".
    for (const v of ['14.0.9', '14.0.10', '14.1.0', '15.0.0', '14.0.9-pro']) expect(takesDevice(v), v).toBe(true);
    for (const v of ['14.0.8', '13.0.29', '12.0.14', '11.0.3', '', 'unknown', undefined]) expect(takesDevice(v), String(v)).toBe(false);
  });
});

describe('signing in through the browser', () => {
  it('asks Seafile for a link and adds the device to it', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { account: null, version: '1.2.3' });
    const flow = await startSignIn(api, ORIGIN);
    expect(sf.state.requests).toEqual(['POST /api2/client-sso-link/', 'GET /api2/server-info/']);
    expect(flow.device).toBe(true);
    const url = new URL(flow.loginUrl);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(`/client-sso/${flow.token}/`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      shib_platform: 'linux', shib_device_id: deviceId(ORIGIN), shib_device_name: DEVICE_NAME,
      shib_client_version: '1.2.3', shib_platform_version: 'web',
    });
  });

  it('tells an older Seafile nothing about the device: it would fail on part of it', async () => {
    const sf = fakeSeafile({ version: '13.0.29' });
    const flow = await startSignIn(seafileApi(sf, { account: null }), ORIGIN);
    expect(flow.device).toBe(false);
    expect(new URL(flow.loginUrl).search).toBe('');
    expect(new URL(flow.loginUrl).pathname).toBe(`/client-sso/${flow.token}/`);
  });

  it('says so when the server has the sign-in turned off', async () => {
    const sf = fakeSeafile({ browserSignIn: false });
    await expect(startSignIn(seafileApi(sf, { account: null }), ORIGIN)).rejects.toMatchObject({ code: 'no_browser_signin' });
    expect(sf.state.requests).toEqual(['POST /api2/client-sso-link/', 'GET /api2/server-info/']);
  });

  it('says so when the address is no Seafile at all', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse('<html>Not Found</html>', { status: 404 }) } });
    await expect(startSignIn(api, ORIGIN)).rejects.toMatchObject({ code: 'not_seafile' });
  });

  it('passes on other errors as they are', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => ({ status: 502, ok: false, headers: {}, body: 'Could not reach the server', proxyError: 'unreachable' }) } });
    await expect(startSignIn(api, ORIGIN)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('does not open a link that is no sign-in link', async () => {
    for (const link of ['javascript:alert(1)', `${ORIGIN}/accounts/login/`, 'nonsense', undefined]) {
      const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse(JSON.stringify({ link })) } });
      await expect(startSignIn(api, ORIGIN), String(link)).rejects.toMatchObject({ code: 'bad_answer' });
    }
  });

  it('waits until the user is done; the proxy keeps the token', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { account: null });
    const flow = await startSignIn(api, ORIGIN);
    const sleeps = [];
    const done = await pollSignIn(api, ORIGIN, flow, { sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 2) sf.completeSignIn(); } });
    expect(done).toBe(true);
    expect(sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    const [cred, url, init] = api.calls('proxy.fetch').at(-1).args;
    expect([cred, url, init.method]).toEqual(['seafile', `${ORIGIN}/api2/client-sso-link/${flow.token}/`, 'GET']);
    expect(init.capture).toEqual({ secret: 'apiToken', username: 'username' });
    // The plugin got neither the token nor the user id back.
    expect(sf.state.captured).toEqual({ secret: 'device-token', username: USER.email });
    for (const call of api.calls('proxy.fetch')) expect(JSON.stringify(await call.args)).not.toContain('device-token');
    expect(api.stored).toMatchObject({ connected: true, username: USER.email });
  });

  it('gives up when the time on Seafile\'s page ran out', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { account: null });
    const flow = await startSignIn(api, ORIGIN);
    sf.state.signIns.set(flow.token, 'error');
    await expect(pollSignIn(api, ORIGIN, flow, { sleep: noSleep })).rejects.toMatchObject({ code: 'login_expired' });
    await expect(pollSignIn(api, ORIGIN, { token: 'unknown0123456789' }, { sleep: noSleep })).rejects.toMatchObject({ code: 'login_expired' });
  });

  it('gives up after its own time limit', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { account: null });
    const flow = await startSignIn(api, ORIGIN);
    let clock = 0;
    await expect(pollSignIn(api, ORIGIN, flow, { timeoutMs: 10_000, now: () => clock, sleep: async (ms) => { clock += ms; } })).rejects.toMatchObject({ code: 'login_expired' });
  });

  it('asks more slowly when Seafile says it is asked too often', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { account: null });
    const flow = await startSignIn(api, ORIGIN);
    sf.failNext('client-sso-link', { status: 429, body: '{"detail":"Request was throttled. Expected available in 30 seconds."}' });
    const sleeps = [];
    await pollSignIn(api, ORIGIN, flow, { sleep: async (ms) => { sleeps.push(ms); sf.completeSignIn(); } });
    expect(sleeps).toEqual([POLL_INTERVAL_MS * 5]);
  });

  it('stops when cancelled', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { account: null });
    const flow = await startSignIn(api, ORIGIN);
    const ctrl = new AbortController();
    await expect(pollSignIn(api, ORIGIN, flow, { signal: ctrl.signal, sleep: async () => { ctrl.abort(); } })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('waits between questions without piling up listeners on the signal', async () => {
    const listeners = new Set();
    const signal = { aborted: false, addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f) };
    for (let i = 0; i < 3; i++) await sleepFor(1, signal);
    expect(listeners.size).toBe(0);
    const ctrl = new AbortController();
    const waiting = sleepFor(60_000, ctrl.signal);
    ctrl.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('fails when Seafile says success but hands out no token', async () => {
    const api = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse({ status: 'success', captured: false }) } });
    await expect(pollSignIn(api, ORIGIN, { token: 't'.repeat(20) }, { sleep: noSleep })).rejects.toMatchObject({ code: 'bad_answer' });
    const odd = fakeApi({ handlers: { 'proxy.fetch': async () => proxyResponse({ captured: false }) } });
    await expect(pollSignIn(odd, ORIGIN, { token: 't'.repeat(20) }, { sleep: noSleep })).rejects.toMatchObject({ code: 'bad_answer' });
  });
});

describe('the connection', () => {
  it('is null without a connected account', async () => {
    expect(await getConnection(seafileApi(fakeSeafile(), { account: null }), { fixedServer: null })).toBeNull();
  });

  it('looks up who it is once after a sign-in through the browser', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf);
    const conn = await getConnection(api, { fixedServer: null });
    expect(conn).toEqual({ origin: ORIGIN, username: USER.email, userId: USER.email, displayName: 'Alice Example', email: 'alice@example.org' });
    await getConnection(api, { fixedServer: null });
    expect(sf.state.requests).toEqual(['GET /api2/account/info/']);
  });

  it('asks every time for a pasted token, which names nobody', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { account: 'token' });
    expect(await getConnection(api, { fixedServer: null })).toMatchObject({ username: '', displayName: 'Alice Example' });
    await getConnection(api, { fixedServer: null });
    expect(sf.state.requests).toHaveLength(2);
    expect(await api.storage.keys()).toEqual([]);
  });

  it('reports a token that stopped working', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf);
    sf.state.token = false;
    await expect(getConnection(api, { fixedServer: null })).rejects.toMatchObject({ code: 'auth' });
  });

  it('does not use an account for another server than the fixed one', async () => {
    const api = seafileApi(fakeSeafile());
    await expect(getConnection(api, { fixedServer: 'https://other.example' })).rejects.toMatchObject({ code: 'wrong_server' });
    await expect(getConnection(seafileApi(fakeSeafile(), { fixed: 'https://other.example' }))).rejects.toMatchObject({ code: 'wrong_server' });
  });
});

describe('connecting with a pasted token', () => {
  it('lets the host ask for it and checks that Seafile takes it', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { account: null });
    const conn = await connectWithToken(api, { suggestedServer: ORIGIN });
    expect(api.calls('proxy.connect')[0].args).toEqual(['seafile', { mode: 'password', server: ORIGIN }]);
    expect(conn).toMatchObject({ origin: ORIGIN, username: '', displayName: 'Alice Example', email: 'alice@example.org' });
  });

  it('forgets a token Seafile does not take', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { account: null, handlers: { 'proxy.connect': async () => { api.stored.exists = true; api.stored.connected = true; sf.state.token = false; return { connected: true, origin: ORIGIN }; } } });
    await expect(connectWithToken(api, {})).rejects.toMatchObject({ code: 'token_rejected' });
    expect(api.calls('proxy.disconnect')).toHaveLength(1);
  });

  it('forgets a token for something that is no Seafile', async () => {
    const api = fakeApi({ handlers: {
      'proxy.connect': async () => ({ connected: true, origin: ORIGIN }),
      'proxy.accounts': async () => [{ credentialId: 'seafile', origin: ORIGIN, connected: true }],
      'proxy.fetch': async () => proxyResponse('<html>Welcome to nginx</html>'),
      'proxy.disconnect': async () => true,
    } });
    await expect(connectWithToken(api, {})).rejects.toMatchObject({ code: 'not_seafile' });
    expect(api.calls('proxy.disconnect')).toHaveLength(1);
  });

  it('returns null when the user cancels', async () => {
    const api = fakeApi({ handlers: { 'proxy.connect': async () => ({ connected: false }) } });
    expect(await connectWithToken(api, {})).toBeNull();
    expect(api.calls('proxy.fetch')).toHaveLength(0);
  });

  it('keeps to the server the admin fixed', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { account: null });
    await expect(connectWithToken(api, { fixedServer: 'https://other.example' })).rejects.toMatchObject({ code: 'wrong_server' });
    expect(api.calls('proxy.connect')[0].args[1]).toEqual({ mode: 'password', server: 'https://other.example' });
    expect(api.calls('proxy.disconnect')).toHaveLength(1);
  });
});

describe('disconnecting', () => {
  it('unlinks the webmail in Seafile after a sign-in through the browser', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf);
    await getConnection(api, { fixedServer: null });
    await disconnect(api);
    expect(sf.state.unlinked).toEqual([{ platform: 'linux', device_id: deviceId(ORIGIN) }]);
    const init = api.calls('proxy.fetch').at(-1).args[2];
    expect(init.method).toBe('DELETE');
    expect(api.calls('proxy.disconnect')).toHaveLength(1);
    expect(await api.storage.keys()).toEqual([]);
  });

  it('leaves a pasted token as it is: it is the user\'s own', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { account: 'token' });
    await disconnect(api);
    expect(sf.state.unlinked).toEqual([]);
    expect(sf.state.requests).toEqual([]);
    expect(api.calls('proxy.disconnect')).toHaveLength(1);
  });

  it('forgets the account here even when Seafile can\'t be reached', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf);
    sf.failNext('/api2/devices/', new Error('Network error'));
    await disconnect(api);
    expect(api.calls('proxy.disconnect')).toHaveLength(1);
  });
});
