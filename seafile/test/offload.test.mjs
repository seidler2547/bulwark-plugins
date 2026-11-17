import { describe, it, expect } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { fakeSeafile, seafileApi, ORIGIN } from './fake-seafile.mjs';
import { createClient } from '../src/lib/client.js';
import { offerLargeUpload, hooks, activate } from '../src/index.js';
import { offloadFile, settingsTarget, targetName } from '../src/ui/offload-dialog.js';
import manifest from '../manifest.json' with { type: 'json' };

const MB = 1024 * 1024;
const connected = async () => [{ credentialId: 'seafile', origin: ORIGIN, connected: true }];

function apiWith({ size, settings = {}, result, accounts = connected }) {
  return fakeApi({
    settings: { offerLargeUpload: true, largeFileMb: 10, ...settings },
    translations: manifest.locales,
    handlers: {
      'proxy.accounts': accounts,
      'upfiles.get': async () => ({ name: 'video.mp4', size, type: 'video/mp4' }),
      'ui.openDialog': async () => result,
    },
  });
}

describe('the large-file offer', () => {
  it('stays out of the way for small files', async () => {
    const api = apiWith({ size: 9 * MB });
    expect(await offerLargeUpload(api, 'f1')).toBeUndefined();
    expect(api.calls('ui.openDialog')).toHaveLength(0);
  });

  it('asks for files from the threshold on and passes the link back to the composer', async () => {
    const api = apiWith({ size: 10 * MB, result: { externalAttachment: true, html: '<p>L</p>', text: 'L', path: '/x' } });
    expect(await offerLargeUpload(api, 'f1')).toEqual({ externalAttachment: true, html: '<p>L</p>', text: 'L', fileId: 'f1' });
    expect(api.calls('ui.openDialog')[0].args[0]).toMatchObject({ slot: 'plugin-dialog', extraProps: { view: 'offload', fileId: 'f1', name: 'video.mp4', size: 10 * MB } });
  });

  it('attaches as usual when the user says so or closes the dialog', async () => {
    expect(await offerLargeUpload(apiWith({ size: 50 * MB, result: { action: 'attach' } }), 'f1')).toBeUndefined();
    expect(await offerLargeUpload(apiWith({ size: 50 * MB, result: null }), 'f1')).toBeUndefined();
  });

  it('respects the settings and needs a connected account', async () => {
    const off = apiWith({ size: 50 * MB, settings: { offerLargeUpload: false }, result: { externalAttachment: true, html: 'h', text: 't' } });
    expect(await offerLargeUpload(off, 'f1')).toBeUndefined();
    expect(off.calls('ui.openDialog')).toHaveLength(0);
    expect(await offerLargeUpload(apiWith({ size: 15 * MB, settings: { largeFileMb: 20 } }), 'f1')).toBeUndefined();
    const notConnected = apiWith({ size: 50 * MB, accounts: async () => [] });
    expect(await offerLargeUpload(notConnected, 'f1')).toBeUndefined();
    expect(notConnected.calls('upfiles.get')).toHaveLength(0);
  });

  it('is the onBeforeBlobUpload hook', async () => {
    const api = apiWith({ size: 50 * MB, result: { externalAttachment: true, html: 'h', text: 't' } });
    await activate(api);
    expect(await hooks.onBeforeBlobUpload('f9')).toMatchObject({ externalAttachment: true, fileId: 'f9' });
  });
});

describe('offloading a file', () => {
  const share = { usePassword: true, password: ' Abcdef-12345!x ', includePassword: true, expireDate: '2027-01-31' };
  const file = () => Object.assign(new Blob([new Uint8Array(3)]), { name: 'a.bin' });

  it('names the upload folder by library and folder', () => {
    const day = new Date(2026, 10, 12);
    expect(targetName(settingsTarget({}, day))).toBe('Mail attachments');
    expect(targetName(settingsTarget({ folderLayout: 'date' }, day))).toBe('Mail attachments/2026-11-12');
    expect(targetName(settingsTarget({ uploadFolder: 'My Library/Out', folderLayout: 'flat' }, day))).toBe('My Library/Out');
  });

  it('uploads to the folder the dialog named, also when the day changed since', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { translations: manifest.locales, settings: { folderLayout: 'date' } });
    const named = settingsTarget(api.plugin.settings, new Date(2026, 10, 12));
    const res = await offloadFile(api, createClient(api, { origin: ORIGIN }), file(), { share: { ...share, usePassword: false }, target: named });
    const lib = [...sf.state.repos.values()].find((r) => r.repo_name === 'Mail attachments');
    expect(res.path).toBe(`/${lib.repo_id}/2026-11-12/a.bin`);
  });

  it('makes the upload library when it is missing, uploads, shares and returns the link block', async () => {
    const sf = fakeSeafile();
    const api = seafileApi(sf, { translations: manifest.locales, settings: { uploadFolder: 'Mail attachments', folderLayout: 'flat' } });
    const client = createClient(api, { origin: ORIGIN });
    const res = await offloadFile(api, client, file(), { share });
    const lib = [...sf.state.repos.values()].find((r) => r.repo_name === 'Mail attachments');
    expect(lib).toBeTruthy();
    expect(res.externalAttachment).toBe(true);
    expect(res.path).toBe(`/${lib.repo_id}/a.bin`);
    expect(sf.bytes(lib.repo_id, '/a.bin').byteLength).toBe(3);
    expect(sf.state.shares[0]).toMatchObject({ repo_id: lib.repo_id, path: '/a.bin', password: 'Abcdef-12345!x' });
    expect(res.url).toBe(`${ORIGIN}/f/share1/`);
    expect(res.html).toContain(`<a href="${ORIGIN}/f/share1/">a.bin</a>`);
    expect(res.text).toContain('password: Abcdef-12345!x');
    expect(res.text).toContain('available until 2027-01-31');
  });

  it('uses a folder in a library the user already has, with a folder per day', async () => {
    const sf = fakeSeafile();
    const mine = sf.addLibrary('My Library');
    const api = seafileApi(sf, { translations: manifest.locales, settings: { uploadFolder: 'My Library/Out', folderLayout: 'date' } });
    const res = await offloadFile(api, createClient(api, { origin: ORIGIN }), file(), { share: { ...share, usePassword: false } });
    expect(res.path).toMatch(new RegExp(`^/${mine}/Out/\\d{4}-\\d{2}-\\d{2}/a\\.bin$`));
    expect(sf.state.repos.size).toBe(1);
    expect(sf.state.shares[0]).not.toHaveProperty('password');
    expect(res.text).not.toContain('password');
  });

  it('shares the file under the name Seafile stored it', async () => {
    const sf = fakeSeafile();
    const lib = sf.addLibrary('Mail attachments');
    const api = seafileApi(sf, { translations: manifest.locales, settings: { folderLayout: 'flat' } });
    const client = createClient(api, { origin: ORIGIN });
    // Someone put a.bin there between picking the name and the upload.
    sf.failNext('/seafhttp/upload-api/', async (url, init, pass) => { sf.addFile(lib, '/a.bin', 'theirs'); return pass(); });
    const res = await offloadFile(api, client, file(), { share: { ...share, usePassword: false } });
    expect(res.path).toBe(`/${lib}/a (1).bin`);
    expect(sf.state.shares[0].path).toBe('/a (1).bin');
  });
});
