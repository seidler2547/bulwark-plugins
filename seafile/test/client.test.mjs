import { describe, it, expect } from 'vitest';
import { fakeSeafile, seafileApi, ORIGIN } from './fake-seafile.mjs';
import { createClient, localPassword, uniqueLibraries, BUFFERED_LIMIT, MAX_SEARCH_LIBRARIES } from '../src/lib/client.js';
import { endOfDay } from '../src/lib/format.js';

function setup(options) {
  const sf = fakeSeafile(options);
  const docs = sf.addLibrary('Documents');
  sf.addFile(docs, '/Invoices/invoice-2026-10.pdf', 'PDF!');
  sf.addFile(docs, '/Welcome.txt', 'hello');
  sf.addFolder(docs, '/Empty');
  const api = seafileApi(sf);
  return { sf, api, docs, client: createClient(api, { origin: sf.origin }) };
}

describe('libraries', () => {
  it('lists the user\'s libraries, their own first, with what can be done with each', async () => {
    const { sf, client, docs } = setup();
    sf.addLibrary('Team', { type: 'shared', permission: 'r', owner: 'Bob Example' });
    sf.addLibrary('Archive', { type: 'group', permission: 'rw', owner: 'Staff' });
    sf.addLibrary('Vault', { encrypted: true });
    const libs = await client.libraries('en');
    expect(libs.map((l) => [l.name, l.kind, l.writable, l.encrypted, l.owner])).toEqual([
      ['Documents', 'mine', true, false, ''],
      ['Vault', 'mine', false, true, ''],
      ['Archive', 'group', true, false, 'Staff'],
      ['Team', 'shared', false, false, 'Bob Example'],
    ]);
    expect(libs[0]).toMatchObject({ path: `/${docs}`, isFolder: true, isLibrary: true, size: 9 });
    expect(client.nameOf(docs)).toBe('Documents');
    expect(sf.state.requests).toEqual(['GET /api/v2.1/repos/']);
  });

  it('shows a library once when it reaches the user two ways', () => {
    const libs = uniqueLibraries([
      { repo_id: 'a', repo_name: 'A', type: 'group', permission: 'r' },
      { repo_id: 'a', repo_name: 'A', type: 'shared', permission: 'rw' },
      { repo_id: 'b', repo_name: 'B', type: 'shared', permission: 'rw' },
      { repo_id: 'b', repo_name: 'B', type: 'mine', permission: 'rw' },
    ]);
    expect(libs.map((l) => [l.repoId, l.kind, l.writable])).toEqual([['a', 'shared', true], ['b', 'mine', true]]);
  });

  it('creates a library, and finds the upload library or makes it', async () => {
    const { sf, client } = setup();
    const made = await client.ensureLibrary('Mail attachments');
    expect(made).toMatchObject({ name: 'Mail attachments', kind: 'mine', writable: true });
    expect(sf.state.requests.at(-1)).toBe('POST /api2/repos/');
    expect((await client.ensureLibrary('Mail attachments')).repoId).toBe(made.repoId);
    expect(sf.state.requests.filter((r) => r.startsWith('POST'))).toHaveLength(1);
  });

  it('does not put uploads into a library the user can only read', async () => {
    const { sf, client } = setup();
    const theirs = sf.addLibrary('Mail attachments', { type: 'shared', permission: 'r', owner: 'Bob' });
    const lib = await client.ensureLibrary('Mail attachments');
    expect(lib.repoId).not.toBe(theirs);
    expect(lib.kind).toBe('mine');
  });
});

describe('folders', () => {
  it('lists the libraries at the top and a folder below, folders first', async () => {
    const { client, docs } = setup();
    const top = await client.listing('/', 'en');
    expect(top.writable).toBe(false);
    expect(top.entries.map((e) => e.name)).toEqual(['Documents']);
    const inside = await client.listing(`/${docs}`, 'en');
    expect(inside.writable).toBe(true);
    expect(inside.entries.map((e) => [e.name, e.isFolder, e.size, e.type])).toEqual([
      ['Empty', true, 0, ''],
      ['Invoices', true, 0, ''],
      ['Welcome.txt', false, 5, 'text/plain'],
    ]);
    expect(inside.entries[2]).toMatchObject({ path: `/${docs}/Welcome.txt`, repoId: docs, modified: 1794505655000 });
  });

  it('says a read-only library is not for writing', async () => {
    const { sf, client } = setup();
    const team = sf.addLibrary('Team', { type: 'shared', permission: 'r' });
    expect((await client.listing(`/${team}`, 'en')).writable).toBe(false);
  });

  it('does not open an encrypted library, and asks Seafile nothing about it', async () => {
    const { sf, client } = setup();
    const vault = sf.addLibrary('Vault', { encrypted: true });
    await client.libraries('en');
    const before = sf.state.requests.length;
    await expect(client.listing(`/${vault}`, 'en')).rejects.toMatchObject({ code: 'encrypted' });
    await expect(client.share(`/${vault}/a.txt`)).rejects.toMatchObject({ code: 'encrypted' });
    expect(sf.state.requests).toHaveLength(before);
  });

  it('reports a folder or library that is gone', async () => {
    const { client, docs } = setup();
    await expect(client.listing(`/${docs}/Nope`, 'en')).rejects.toMatchObject({ code: 'not_found' });
    await expect(client.listing('/00000000-0000-4000-8000-00000000ffff', 'en')).rejects.toMatchObject({ code: 'not_found' });
    expect(await client.names(`/${docs}/Nope`)).toEqual([]);
    expect(await client.folderExists(`/${docs}/Invoices`)).toBe(true);
    expect(await client.folderExists(`/${docs}/Nope`)).toBe(false);
    expect(await client.folderExists('/')).toBe(true);
  });

  it('creates a folder and takes the name Seafile gave it', async () => {
    const { client, docs } = setup();
    expect(await client.mkdir(`/${docs}/New`)).toBe(`/${docs}/New`);
    // Seafile doesn't refuse a name that is taken, it numbers it.
    expect(await client.mkdir(`/${docs}/New`)).toBe(`/${docs}/New (1)`);
    await expect(client.mkdir('/New')).rejects.toMatchObject({ code: 'no_library' });
  });

  it('makes missing parent folders and leaves existing ones alone', async () => {
    const { sf, client, docs } = setup();
    expect(await client.mkdirp(`/${docs}/Invoices/2026/Q4`)).toBe(`/${docs}/Invoices/2026/Q4`);
    expect(sf.state.requests.filter((r) => r.startsWith('POST')).map((r) => decodeURIComponent(r))).toEqual([
      `POST /api/v2.1/repos/${docs}/dir/?p=/Invoices/2026`,
      `POST /api/v2.1/repos/${docs}/dir/?p=/Invoices/2026/Q4`,
    ]);
    const posts = sf.state.requests.length;
    expect(await client.mkdirp(`/${docs}/Invoices/2026/Q4`)).toBe(`/${docs}/Invoices/2026/Q4`);
    expect(sf.state.requests.slice(posts).every((r) => r.startsWith('GET'))).toBe(true);
    expect(await client.mkdirp(`/${docs}`)).toBe(`/${docs}`);
    await expect(client.mkdirp('/')).rejects.toMatchObject({ code: 'no_library' });
  });

  it('stats a file', async () => {
    const { client, docs } = setup();
    expect(await client.stat(`/${docs}/Welcome.txt`)).toMatchObject({ name: 'Welcome.txt', size: 5, isFolder: false, type: 'text/plain' });
    expect(await client.stat(`/${docs}/none.txt`)).toBeNull();
    expect(await client.stat('/')).toBeNull();
  });
});

describe('search and favorites', () => {
  it('searches the library the user is in', async () => {
    const { sf, client, docs } = setup();
    const other = sf.addLibrary('Other');
    sf.addFile(other, '/invoice-copy.pdf', 'x');
    expect(await client.search('  ', { path: `/${docs}` })).toEqual([]);
    const found = await client.search('invoice', { path: `/${docs}/Invoices` });
    expect(found.map((e) => [e.name, e.isFolder, e.path])).toEqual([
      ['Invoices', true, `/${docs}/Invoices`],
      ['invoice-2026-10.pdf', false, `/${docs}/Invoices/invoice-2026-10.pdf`],
    ]);
    expect(sf.state.requests.filter((r) => r.includes('search-file'))).toEqual([`GET /api/v2.1/search-file/?repo_id=${docs}&q=invoice`]);
  });

  it('searches every library from the list of libraries, and their names', async () => {
    const { sf, client } = setup();
    const other = sf.addLibrary('Invoice archive');
    sf.addFile(other, '/old-invoice.pdf', 'x');
    sf.addLibrary('Vault', { encrypted: true });
    const found = await client.search('invoice', { path: '/' });
    expect(found.map((e) => e.name)).toEqual(['Invoice archive', 'Invoices', 'invoice-2026-10.pdf', 'old-invoice.pdf']);
    expect(found[0].isLibrary).toBe(true);
    // Not the encrypted one.
    expect(sf.state.requests.filter((r) => r.includes('search-file'))).toHaveLength(2);
  });

  it('looks into a limited number of libraries', async () => {
    const { sf, client } = setup();
    for (let i = 0; i < MAX_SEARCH_LIBRARIES + 5; i++) sf.addLibrary(`Lib ${i}`);
    await client.search('x', { path: '/' });
    expect(sf.state.requests.filter((r) => r.includes('search-file'))).toHaveLength(MAX_SEARCH_LIBRARIES);
  });

  it('lists favorites: files without a size, folders and libraries to open', async () => {
    const { sf, client, docs } = setup();
    sf.state.starred = [
      { repo_id: docs, repo_name: 'Documents', repo_encrypted: false, is_dir: true, path: '/Invoices/', obj_name: 'Invoices', mtime: '2026-11-12T18:47:35+01:00', deleted: false },
      { repo_id: docs, repo_name: 'Documents', repo_encrypted: false, is_dir: false, path: '/Welcome.txt', obj_name: 'Welcome.txt', mtime: '2026-11-12T18:47:35+01:00', deleted: false },
      { repo_id: docs, repo_name: 'Documents', repo_encrypted: false, is_dir: true, path: '/', obj_name: 'Documents', mtime: '', deleted: false },
      { repo_id: docs, repo_name: 'Documents', repo_encrypted: false, is_dir: false, path: '/gone.txt', obj_name: 'gone.txt', mtime: '', deleted: true },
      { repo_id: 'enc', repo_name: 'Vault', repo_encrypted: true, is_dir: false, path: '/secret.txt', obj_name: 'secret.txt', mtime: '', deleted: false },
    ];
    const fav = await client.favorites();
    expect(fav.map((e) => [e.name, e.isFolder, e.isLibrary, e.sizeKnown, e.path])).toEqual([
      ['Invoices', true, false, true, `/${docs}/Invoices`],
      ['Welcome.txt', false, false, false, `/${docs}/Welcome.txt`],
      ['Documents', true, true, false, `/${docs}`],
    ]);
    expect(fav[1]).toMatchObject({ type: 'text/plain', repoName: 'Documents' });
  });

  it('gives a starred library the size from the list of libraries once that is known', async () => {
    const { sf, client, docs } = setup();
    sf.state.starred = [{ repo_id: docs, repo_name: 'Documents', repo_encrypted: false, is_dir: true, path: '/', obj_name: 'Documents', mtime: '', deleted: false }];
    const listed = (await client.libraries()).find((lib) => lib.repoId === docs);
    expect(listed.size).toBeGreaterThan(0);
    const [fav] = await client.favorites();
    expect(fav).toMatchObject({ isLibrary: true, sizeKnown: true, size: listed.size });
  });
});

describe('downloads', () => {
  it('asks for a download link, then takes small files in one piece', async () => {
    const { sf, client, docs } = setup();
    const data = await client.download({ path: `/${docs}/Welcome.txt`, size: 5, sizeKnown: true });
    expect(new TextDecoder().decode(data)).toBe('hello');
    expect(sf.state.requests.slice(-2).map((r) => r.replace(/dl\d+/, 'dl'))).toEqual([
      `GET /api2/repos/${docs}/file/?p=%2FWelcome.txt&reuse=1`,
      'GET /seafhttp/files/dl/Welcome.txt',
    ]);
  });

  it('streams large files and files whose size it does not know', async () => {
    const { api, client, docs } = setup();
    const progress = [];
    const big = await client.download({ path: `/${docs}/Welcome.txt`, size: BUFFERED_LIMIT + 1, sizeKnown: true }, { onProgress: (l) => progress.push(l) });
    expect(new TextDecoder().decode(big)).toBe('hello');
    expect(progress).toEqual([3, 5]);
    expect(api.calls('proxy.fetch').at(-1).args[2].responseType).toBe('stream');
    const fav = await client.download({ path: `/${docs}/Welcome.txt`, size: 0, sizeKnown: false });
    expect(fav.byteLength).toBe(5);
    expect(api.calls('proxy.fetch').at(-1).args[2].responseType).toBe('stream');
  });

  it('says so when Seafile hands out file addresses on another server', async () => {
    const { client, docs } = setup({ fileServer: 'http://seafile.internal:8082' });
    await expect(client.download({ path: `/${docs}/Welcome.txt`, size: 5 })).rejects.toMatchObject({ code: 'file_server', detail: 'seafile.internal:8082' });
    await expect(client.uploadLink(docs, '/')).rejects.toMatchObject({ code: 'file_server' });
  });

  it('goes through the connected address when Seafile only got the scheme wrong', async () => {
    // Seafile behind a TLS proxy that still says http in its own settings.
    const { sf, client, docs } = setup({ fileServer: 'http://files.example.com' });
    const data = await client.download({ path: `/${docs}/Welcome.txt`, size: 5, sizeKnown: true });
    expect(new TextDecoder().decode(data)).toBe('hello');
    expect(sf.state.requests.at(-1)).toMatch(/^GET \/seafhttp\/files\//);
    expect(await client.uploadLink(docs, '/')).toMatch(/^https:\/\/files\.example\.com\/seafhttp\/upload-api\/up\d+\?ret-json=1$/);
  });
});

describe('share links', () => {
  it('creates a public read-only link with password and expiry', async () => {
    const { sf, api, client, docs } = setup();
    const share = await client.share(`/${docs}/Welcome.txt`, { password: 'Abcdef-12345!x', expireDate: '2027-01-31' });
    expect(share).toEqual({ id: 'share1', url: `${ORIGIN}/f/share1/`, password: 'Abcdef-12345!x', expireDate: '2027-01-31', name: 'Welcome.txt' });
    const [, url, init] = api.calls('proxy.fetch').at(-1).args;
    expect(url).toBe(`${ORIGIN}/api/v2.1/multi-share-links/`);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      repo_id: docs, path: '/Welcome.txt', permissions: { can_edit: false, can_download: true, can_upload: false },
      password: 'Abcdef-12345!x', expiration_time: endOfDay('2027-01-31'),
    });
    // A second link for the same file is fine.
    expect((await client.share(`/${docs}/Welcome.txt`)).url).toBe(`${ORIGIN}/f/share2/`);
    expect(sf.state.shares[1]).not.toHaveProperty('password');
    expect(sf.state.shares[1]).not.toHaveProperty('expiration_time');
  });

  it('passes on what Seafile says about a password it does not take', async () => {
    const { client, docs } = setup();
    await expect(client.share(`/${docs}/Welcome.txt`, { password: 'abc' })).rejects.toMatchObject({ code: 'rejected', detail: 'Password is too short.' });
  });

  it('says plainly when sharing is not allowed', async () => {
    const { sf, client, docs } = setup();
    sf.failNext('multi-share-links', { status: 403, body: '{"error_msg":"Permission denied."}' });
    await expect(client.share(`/${docs}/Welcome.txt`)).rejects.toMatchObject({ code: 'share_forbidden', detail: 'Permission denied.' });
    await expect(client.share('/Welcome.txt')).rejects.toMatchObject({ code: 'no_library' });
  });

  it('makes passwords that meet Seafile\'s strictest rules', async () => {
    const { client } = setup();
    const pw = await client.generatePassword();
    expect(pw).toHaveLength(20);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[-_+!#]/);
    expect(localPassword(() => 0)).toHaveLength(20);
  });
});

describe('opening things in Seafile', () => {
  it('links to the file, the folder and the library', async () => {
    const { client, docs } = setup();
    await client.libraries('en');
    expect(client.webUrl({ path: `/${docs}/Invoices/a b.pdf`, isFolder: false })).toBe(`${ORIGIN}/lib/${docs}/file/Invoices/a%20b.pdf`);
    expect(client.webUrl({ path: `/${docs}/Invoices`, isFolder: true })).toBe(`${ORIGIN}/library/${docs}/Documents/Invoices`);
    expect(client.webUrl({ path: `/${docs}`, isFolder: true })).toBe(`${ORIGIN}/library/${docs}/Documents/`);
  });
});

describe('a token that stopped working', () => {
  it('is an "auth" error, whether Seafile says 401 or 403', async () => {
    const { sf, client, docs } = setup();
    await client.libraries('en');
    sf.state.token = false;
    await expect(client.listing(`/${docs}`, 'en')).rejects.toMatchObject({ code: 'auth', status: 401 });
    sf.state.token = null;
    await expect(client.listing(`/${docs}`, 'en')).rejects.toMatchObject({ code: 'auth', status: 403 });
  });
});
