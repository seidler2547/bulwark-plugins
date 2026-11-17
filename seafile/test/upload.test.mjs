import { describe, it, expect } from 'vitest';
import { fakeSeafile, seafileApi } from './fake-seafile.mjs';
import { createClient } from '../src/lib/client.js';
import { uploadFile, multipartBody, resumeKey, uploadKey, UPLOAD_PREFIX } from '../src/lib/upload.js';

const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251);
const fileOf = (data, name, lastModified = 1) => Object.assign(new Blob([data]), { name, lastModified });
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const noWait = async () => {};

function setup() {
  const sf = fakeSeafile();
  const lib = sf.addLibrary('Documents');
  sf.addFolder(lib, '/Up');
  const api = seafileApi(sf);
  return { sf, api, lib, client: createClient(api, { origin: sf.origin }) };
}

/** The records of unfinished uploads, by storage key. */
const records = (api) => Object.fromEntries(Object.entries(api.storageSnapshot()).filter(([k]) => k.startsWith(UPLOAD_PREFIX)));

describe('the upload form', () => {
  it('is multipart/form-data as a browser builds it', async () => {
    const form = multipartBody({ parent_dir: '/Up', replace: '0' }, new Blob(['abc']), 'Grüße "x".txt', 'MARK');
    expect(form.contentType).toBe('multipart/form-data; boundary=MARK');
    expect(await form.body.text()).toBe([
      '--MARK', 'Content-Disposition: form-data; name="parent_dir"', '', '/Up',
      '--MARK', 'Content-Disposition: form-data; name="replace"', '', '0',
      '--MARK', 'Content-Disposition: form-data; name="file"; filename="Grüße %22x%22.txt"', 'Content-Type: application/octet-stream', '', 'abc',
      '--MARK--', '',
    ].join('\r\n'));
  });

  it('keeps line breaks out of the fields', async () => {
    const form = multipartBody({ parent_dir: '/a\r\nX: y' }, new Blob(['']), 'a\r\nb.txt', 'M');
    expect(await form.body.text()).not.toMatch(/\r\nX: y|a\r\nb\.txt/);
  });
});

describe('small files', () => {
  it('go up in one request to the folder\'s upload address', async () => {
    const { sf, api, lib, client } = setup();
    const data = bytes(100);
    const progress = [];
    const res = await uploadFile(api, client, fileOf(data, 'a.bin'), `/${lib}/Up/a.bin`, { onProgress: (l, t) => progress.push([l, t]) });
    expect(res).toEqual({ path: `/${lib}/Up/a.bin`, chunked: false, resumed: false });
    expect(same(sf.bytes(lib, '/Up/a.bin'), data)).toBe(true);
    expect(sf.state.requests.map((r) => r.replace(/up\d+/, 'up'))).toEqual([
      `GET /api2/repos/${lib}/upload-link/?p=%2FUp`,
      'POST /seafhttp/upload-api/up?ret-json=1',
    ]);
    expect(sf.state.uploads).toEqual([{ dir: '/Up', name: 'a.bin', range: null, size: 100 }]);
    expect(progress.at(-1)).toEqual([100, 100]);
    expect(api.calls('storage.set')).toHaveLength(0);
  });

  it('take the name Seafile stored them under', async () => {
    const { sf, api, lib, client } = setup();
    sf.addFile(lib, '/Up/a.bin', 'old');
    const res = await uploadFile(api, client, fileOf(bytes(5), 'a.bin'), `/${lib}/Up/a.bin`);
    expect(res.path).toBe(`/${lib}/Up/a (1).bin`);
    expect(new TextDecoder().decode(sf.bytes(lib, '/Up/a.bin'))).toBe('old');
  });

  it('are tried again after a network error', async () => {
    const { sf, api, lib, client } = setup();
    sf.failNext('/seafhttp/upload-api/', new Error('Network error'));
    const res = await uploadFile(api, client, fileOf(bytes(5), 'a.bin'), `/${lib}/Up/a.bin`, { wait: noWait });
    expect(res.path).toBe(`/${lib}/Up/a.bin`);
    expect(sf.state.uploads).toHaveLength(1);
  });

  it('are not stored twice when only the answer got lost', async () => {
    const { sf, api, lib, client } = setup();
    // The file arrives, the answer doesn't.
    sf.failNext('/seafhttp/upload-api/', async (url, init, pass) => { await pass(); return new Error('Network error'); });
    const res = await uploadFile(api, client, fileOf(bytes(5), 'a.bin'), `/${lib}/Up/a.bin`, { wait: noWait });
    expect(res.path).toBe(`/${lib}/Up/a.bin`);
    expect(sf.state.uploads).toHaveLength(1);
    expect(sf.bytes(lib, '/Up/a (1).bin')).toBeNull();
  });

  it('give up on an error that trying again does not fix', async () => {
    const { sf, api, lib, client } = setup();
    sf.failNext('/seafhttp/upload-api/', { status: 443, body: 'Out of quota.\n' });
    await expect(uploadFile(api, client, fileOf(bytes(5), 'a.bin'), `/${lib}/Up/a.bin`, { wait: noWait })).rejects.toMatchObject({ code: 'quota' });
    expect(sf.state.requests.filter((r) => r.startsWith('POST'))).toHaveLength(1);
  });

  it('need a library and a name', async () => {
    const { api, lib, client } = setup();
    await expect(uploadFile(api, client, fileOf(bytes(5), 'a.bin'), '/a.bin')).rejects.toMatchObject({ code: 'no_library' });
    await expect(uploadFile(api, client, fileOf(bytes(5), 'a.bin'), `/${lib}`)).rejects.toMatchObject({ code: 'no_library' });
    await expect(uploadFile(api, client, fileOf(bytes(5), 'a.bin'), `/${lib}/Nope/a.bin`)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('large files', () => {
  it('go up in pieces, in order, each saying where it belongs', async () => {
    const { sf, api, lib, client } = setup();
    const data = bytes(25);
    const progress = [];
    const res = await uploadFile(api, client, fileOf(data, 'Größe 100%.bin'), `/${lib}/Up/Größe 100%.bin`, { chunkSize: 10, onProgress: (l) => progress.push(l) });
    expect(res).toEqual({ path: `/${lib}/Up/Größe 100%.bin`, chunked: true, resumed: false });
    expect(same(sf.bytes(lib, '/Up/Größe 100%.bin'), data)).toBe(true);
    expect(sf.state.uploads.map((u) => u.range)).toEqual([[0, 9, 25], [10, 19, 25], [20, 24, 25]]);
    const posts = api.calls('proxy.fetch').map((c) => c.args[2]).filter((init) => init.method === 'POST');
    // The file server reads the name from this header, percent-decoded.
    expect(posts[0].headers['Content-Disposition']).toBe('attachment; filename="Gr%C3%B6%C3%9Fe%20100%25.bin"');
    expect(posts[0].headers['Content-Range']).toBe('bytes 0-9/25');
    expect(posts[0].headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(25);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(records(api)).toEqual({});
  });

  it('go on where a cancelled upload stopped', async () => {
    const { sf, api, lib, client } = setup();
    const data = bytes(25);
    const file = fileOf(data, 'big.bin');
    const dest = `/${lib}/Up/big.bin`;
    const ctrl = new AbortController();
    await expect(uploadFile(api, client, file, dest, {
      chunkSize: 10, signal: ctrl.signal, onProgress: (loaded) => { if (loaded >= 10) ctrl.abort(); },
    })).rejects.toMatchObject({ code: 'cancelled' });
    expect(sf.bytes(lib, '/Up/big.bin')).toBeNull();
    expect(api.storageSnapshot()[uploadKey(resumeKey(dest, file))]).toMatchObject({ key: resumeKey(dest, file), name: 'big.bin' });

    const sent = sf.state.uploads.length;
    const progress = [];
    const res = await uploadFile(api, client, file, dest, { chunkSize: 10, onProgress: (l) => progress.push(l) });
    expect(res).toEqual({ path: dest, chunked: true, resumed: true });
    expect(progress[0]).toBe(10);
    expect(sf.state.uploads.slice(sent).map((u) => u.range)).toEqual([[10, 19, 25], [20, 24, 25]]);
    expect(same(sf.bytes(lib, '/Up/big.bin'), data)).toBe(true);
  });

  it('never go on from an unfinished upload they did not start', async () => {
    const { sf, api, lib, client } = setup();
    // Someone else's pieces under the same folder and name, from another browser.
    sf.state.partial.set(`${lib}|/Up|big.bin`, bytes(10, 99));
    const data = bytes(25);
    const res = await uploadFile(api, client, fileOf(data, 'big.bin'), `/${lib}/Up/big.bin`, { chunkSize: 10 });
    expect(res.path).toBe(`/${lib}/Up/big (2).bin`);
    expect(res.resumed).toBe(false);
    expect(same(sf.bytes(lib, '/Up/big (2).bin'), data)).toBe(true);
    expect(sf.state.uploads[0].range).toEqual([0, 9, 25]);
    // The other upload is as it was.
    expect(same(sf.state.partial.get(`${lib}|/Up|big.bin`), bytes(10, 99))).toBe(true);
  });

  it('take a failed piece up again from what the file server really has', async () => {
    const { sf, api, lib, client } = setup();
    const data = bytes(25);
    let seen = 0;
    // The second piece arrives, its answer doesn't.
    sf.failNext((method, url) => method === 'POST' && url.pathname.includes('/upload-api/') && ++seen === 2,
      async (url, init, pass) => { await pass(); return new Error('Network error'); });
    const res = await uploadFile(api, client, fileOf(data, 'big.bin'), `/${lib}/Up/big.bin`, { chunkSize: 10, wait: noWait });
    expect(res.path).toBe(`/${lib}/Up/big.bin`);
    expect(same(sf.bytes(lib, '/Up/big.bin'), data)).toBe(true);
    // Not sent a second time: the third request is the third piece.
    expect(sf.state.uploads.map((u) => u.range)).toEqual([[0, 9, 25], [10, 19, 25], [20, 24, 25]]);
  });

  it('do not upload again when only the answer to the last piece got lost', async () => {
    const { sf, api, lib, client } = setup();
    const data = bytes(25);
    let seen = 0;
    sf.failNext((method, url) => method === 'POST' && url.pathname.includes('/upload-api/') && ++seen === 3,
      async (url, init, pass) => { await pass(); return { status: 504, body: '' }; });
    const res = await uploadFile(api, client, fileOf(data, 'big.bin'), `/${lib}/Up/big.bin`, { chunkSize: 10, wait: noWait });
    expect(res.path).toBe(`/${lib}/Up/big.bin`);
    expect(sf.state.uploads).toHaveLength(3);
    expect(sf.bytes(lib, '/Up/big (1).bin')).toBeNull();
    expect(records(api)).toEqual({});
  });

  it('stop after too many failures and keep what was sent for later', async () => {
    const { sf, api, lib, client } = setup();
    const file = fileOf(bytes(25), 'big.bin');
    let seen = 0;
    sf.failNext((method, url) => method === 'POST' && url.pathname.includes('/upload-api/') && ++seen >= 2, { status: 500, body: 'Internal error.\n' }, 10);
    await expect(uploadFile(api, client, file, `/${lib}/Up/big.bin`, { chunkSize: 10, retries: 2, wait: noWait })).rejects.toMatchObject({ code: 'server' });
    expect(sf.state.partial.get(`${lib}|/Up|big.bin`).byteLength).toBe(10);
    expect(Object.keys(records(api))).toHaveLength(1);
  });

  it('take a new upload address after a while', async () => {
    const { sf, api, lib, client } = setup();
    let clock = 0;
    await uploadFile(api, client, fileOf(bytes(30), 'big.bin'), `/${lib}/Up/big.bin`, { chunkSize: 10, now: () => (clock += 6 * 60 * 1000) });
    expect(sf.state.requests.filter((r) => r.includes('/upload-link/')).length).toBeGreaterThan(1);
    expect(sf.bytes(lib, '/Up/big.bin').byteLength).toBe(30);
  });

  it('forget unfinished uploads the file server has dropped by now', async () => {
    const { sf, api, lib, client } = setup();
    const file = fileOf(bytes(25), 'big.bin');
    const dest = `/${lib}/Up/big.bin`;
    const day = 24 * 60 * 60 * 1000;
    const mine = resumeKey(dest, file);
    await api.storage.set(uploadKey(mine), { key: mine, name: 'big.bin', startedAt: -4 * day });
    await api.storage.set(uploadKey('other|1|1|x'), { key: 'other|1|1|x', name: 'x', startedAt: -1 * day });
    await api.storage.set(uploadKey('old|1|1|y'), { key: 'old|1|1|y', name: 'y', startedAt: -5 * day });
    await api.storage.set('saveFolder', '/somewhere');
    // Pieces under the name although the record is too old to be trusted: not ours any more.
    sf.state.partial.set(`${lib}|/Up|big.bin`, bytes(10, 99));
    const ctrl = new AbortController();
    await uploadFile(api, client, file, dest, { chunkSize: 10, now: () => 0, signal: ctrl.signal, onProgress: (l) => { if (l >= 10) ctrl.abort(); } }).catch(() => {});
    const kept = records(api);
    expect(Object.keys(kept).sort()).toEqual([uploadKey(mine), uploadKey('other|1|1|x')].sort());
    expect(kept[uploadKey(mine)]).toEqual({ key: mine, name: 'big (2).bin', startedAt: 0 });
    // Other things the plugin keeps are left alone.
    expect(api.storageSnapshot().saveFolder).toBe('/somewhere');
  });

  it('keep each unfinished upload under a short key of its own', async () => {
    const { api, lib, client } = setup();
    const long = `${'n'.repeat(200)}.bin`;
    const stop = async (name) => {
      const ctrl = new AbortController();
      await uploadFile(api, client, fileOf(bytes(25), name), `/${lib}/Up/${name}`, {
        chunkSize: 10, signal: ctrl.signal, onProgress: (l) => { if (l >= 10) ctrl.abort(); },
      }).catch(() => {});
    };
    await stop(long);
    await stop('b.bin');
    const keys = Object.keys(records(api));
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(256);
  });

  it('do not take the record of another upload that shares the storage key', async () => {
    const { sf, api, lib, client } = setup();
    const file = fileOf(bytes(25), 'big.bin');
    const dest = `/${lib}/Up/big.bin`;
    await api.storage.set(uploadKey(resumeKey(dest, file)), { key: 'something else', name: 'big.bin', startedAt: 0 });
    // Without a record of its own, pieces under the name are someone else's.
    sf.state.partial.set(`${lib}|/Up|big.bin`, bytes(10, 99));
    const res = await uploadFile(api, client, file, dest, { chunkSize: 10, now: () => 0 });
    expect(res.path).toBe(`/${lib}/Up/big (2).bin`);
    expect(res.resumed).toBe(false);
  });
});
