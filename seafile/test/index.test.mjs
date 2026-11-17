import { describe, it, expect } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { ORIGIN } from './fake-seafile.mjs';
import { offerFirstRun, slots } from '../src/index.js';
import manifest from '../manifest.json' with { type: 'json' };

describe('first run', () => {
  const withServer = { 'config.get': async () => ({ serverUrl: ORIGIN }) };

  it('points a user without a Seafile account to Settings once, where the admin set up a server', async () => {
    const api = fakeApi({ translations: manifest.locales, handlers: { ...withServer, 'proxy.accounts': async () => [] } });
    expect(await offerFirstRun(api)).toBe(true);
    expect(api.calls('toast.info')[0].args[0]).toBe(manifest.locales.en['firstrun.offer']);
    expect(await offerFirstRun(api)).toBe(false);
    expect(api.calls('toast.info')).toHaveLength(1);
  });

  it('says nothing when no server is set: not everyone has a Seafile', async () => {
    const api = fakeApi({ translations: manifest.locales, handlers: { 'config.get': async () => ({ serverUrl: '' }), 'proxy.accounts': async () => [] } });
    expect(await offerFirstRun(api)).toBe(false);
    expect(api.calls('toast.info')).toHaveLength(0);
  });

  it('still offers once the administrator sets a server later', async () => {
    let serverUrl = '';
    const api = fakeApi({ translations: manifest.locales, handlers: { 'config.get': async () => ({ serverUrl }), 'proxy.accounts': async () => [] } });
    expect(await offerFirstRun(api)).toBe(false);
    serverUrl = ORIGIN;
    expect(await offerFirstRun(api)).toBe(true);
    expect(api.calls('toast.info')).toHaveLength(1);
  });

  it('says nothing when Seafile is already connected', async () => {
    const api = fakeApi({ handlers: { ...withServer, 'proxy.accounts': async () => [{ credentialId: 'seafile', origin: ORIGIN, connected: true }] } });
    expect(await offerFirstRun(api)).toBe(false);
    expect(api.calls('toast.info')).toHaveLength(0);
  });
});

describe('manifest', () => {
  it('keeps the token in a user credential, sent the way Seafile reads it, never in settings', () => {
    expect(manifest.credentials.seafile).toEqual({ label: 'Seafile', scope: 'user', inject: { type: 'header', name: 'Authorization', prefix: 'Token ' } });
    const fields = JSON.stringify({ ...manifest.settingsSchema, ...manifest.configSchema }).toLowerCase();
    expect(fields).not.toMatch(/"type"\s*:\s*"secret"/);
    expect(Object.keys({ ...manifest.settingsSchema, ...manifest.configSchema }).filter((k) => /token|password$|secret/i.test(k))).toEqual([]);
    expect(Object.keys(manifest.configSchema)).toEqual(['serverUrl']);
  });

  it('asks for what it uses and nothing about the calendar or the account', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'compose:open', 'compose:write', 'email:blob-read', 'email:blob-write', 'email:read', 'http:proxy',
      'ui:app-page', 'ui:composer-toolbar', 'ui:download-file', 'ui:settings-section', 'ui:toolbar',
    ]);
  });

  it('offers a settings section, the dialog and the page', () => {
    for (const slot of ['settings-section', 'plugin-dialog', 'app-page']) expect(typeof slots[slot].component, slot).toBe('function');
    expect(Object.keys(slots)).toHaveLength(3);
  });
});
