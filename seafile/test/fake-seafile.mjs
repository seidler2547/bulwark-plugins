// A small Seafile behind `api.proxy.fetch`, for unit tests. It answers the
// way Seafile 14 was seen to answer (web API under /api2 and /api/v2.1,
// file server under /seafhttp), including what matters for uploads: the
// file server takes a piece at any offset, keeps unfinished uploads by
// folder and name, and adds " (1)" to a name that is taken.
//
//   const sf = fakeSeafile();
//   const lib = sf.addLibrary('Documents');
//   sf.addFile(lib, '/Invoices/a.pdf', 'bytes');
//   const api = seafileApi(sf);                 // fakeApi wired to it

import { fakeApi } from '../../test-utils/fake-api.mjs';

export const ORIGIN = 'https://files.example.com';
export const USER = { email: '0a1b2c3d4e5f@auth.local', name: 'Alice Example', contact_email: 'alice@example.org', login_id: '' };

const enc = new TextEncoder();
const bytesOf = (v) => (typeof v === 'string' ? enc.encode(v) : new Uint8Array(v));
const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const base = (p) => p.slice(p.lastIndexOf('/') + 1);
const clean = (p) => '/' + String(p ?? '').split('/').filter(Boolean).join('/');

function numbered(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) if (!taken.has(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
}

async function parseMultipart(body, contentType) {
  const mark = `--${/boundary=(.+)$/.exec(contentType ?? '')?.[1]}`;
  const buf = Buffer.from(body instanceof Blob ? await body.arrayBuffer() : body);
  const parts = {};
  let pos = buf.indexOf(mark);
  while (pos >= 0) {
    const start = pos + mark.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    const head = buf.subarray(start + 2, headEnd).toString('utf8');
    const next = buf.indexOf(`\r\n${mark}`, headEnd);
    const content = buf.subarray(headEnd + 4, next);
    const name = /name="([^"]*)"/.exec(head)[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    parts[name] = filename !== undefined ? { filename, bytes: new Uint8Array(content) } : content.toString('utf8');
    pos = next + 2;
  }
  return parts;
}

export function fakeSeafile({ origin = ORIGIN, fileServer = origin, user = USER, browserSignIn = true, passwordMinLength = 10, version = '14.0.9' } = {}) {
  let counter = 0;
  const id = () => `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const state = {
    origin,
    /** false: the token stopped working; null: no token is sent */
    token: 'valid',
    repos: new Map(),
    partial: new Map(),
    shares: [],
    starred: [],
    signIns: new Map(),
    unlinked: [],
    /** every request as "METHOD /path?query" */
    requests: [],
    /** the multipart uploads the file server got: { dir, name, range, size } */
    uploads: [],
    /** answer the next matching requests with this instead: [{ match, response, times }] */
    failures: [],
  };

  const json = (data, status = 200) => ({ status, body: JSON.stringify(data) });
  const fail = (status, error_msg) => json({ error_msg }, status);
  const repoOf = (repoId) => state.repos.get(repoId);
  const entries = (repo, dir) => [...repo.files.entries()].filter(([p]) => p !== '/' && parent(p) === dir);

  function addLibrary(name, { type = 'mine', permission = 'rw', encrypted = false, owner = '' } = {}) {
    const repo = { repo_id: id(), repo_name: name, type, permission, encrypted, owner_name: owner || user.name, files: new Map([['/', null]]), mtime: 1794505655 };
    state.repos.set(repo.repo_id, repo);
    return repo.repo_id;
  }
  function addFolder(repoId, path) {
    const repo = repoOf(repoId);
    let acc = '';
    for (const part of clean(path).slice(1).split('/')) { acc += `/${part}`; if (!repo.files.has(acc)) repo.files.set(acc, null); }
    return clean(path);
  }
  function addFile(repoId, path, content = '') {
    addFolder(repoId, parent(clean(path)));
    repoOf(repoId).files.set(clean(path), bytesOf(content));
    return clean(path);
  }
  const bytes = (repoId, path) => repoOf(repoId)?.files.get(clean(path)) ?? null;
  /** The user finished on Seafile's page: the sign-in link's next answer carries the token. */
  const completeSignIn = (token = [...state.signIns.keys()].pop()) => { state.signIns.set(token, 'success'); };

  function repoInfo(repo) {
    return {
      type: repo.type, repo_id: repo.repo_id, repo_name: repo.repo_name, owner_name: repo.owner_name,
      last_modified: '2026-11-12T18:47:35+01:00', size: [...repo.files.values()].reduce((n, b) => n + (b?.byteLength ?? 0), 0),
      encrypted: repo.encrypted, permission: repo.permission, starred: false,
    };
  }
  function dirent(repo, path) {
    const content = repo.files.get(path);
    return content === null
      ? { type: 'dir', id: 'd', name: base(path), mtime: repo.mtime, permission: repo.permission, parent_dir: parent(path) }
      : { type: 'file', id: 'f', name: base(path), mtime: repo.mtime, permission: repo.permission, parent_dir: parent(path), size: content.byteLength };
  }

  async function upload(url, init) {
    const link = state.uploadLinks.get(url.pathname.split('/').pop());
    if (!link) return { status: 403, body: 'Access token not found\n' };
    const repo = repoOf(link.repoId);
    const form = await parseMultipart(init.body, init.headers?.['Content-Type']);
    const dir = clean(form.parent_dir);
    if (!repo.files.has(dir) || repo.files.get(dir) !== null) return { status: 400, body: "Parent dir doesn't exist.\n" };
    const range = init.headers?.['Content-Range'];
    const piece = form.file.bytes;
    if (!range) {
      const name = numbered(form.file.filename, new Set(entries(repo, dir).map(([p]) => base(p))));
      repo.files.set(clean(`${dir}/${name}`), piece);
      state.uploads.push({ dir, name: form.file.filename, range: null, size: piece.byteLength });
      return json([{ id: 'f', name, size: piece.byteLength }]);
    }
    const [, from, to, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(range).map(Number);
    const name = decodeURIComponent(/filename="([^"]*)"/.exec(init.headers?.['Content-Disposition'] ?? '')?.[1] ?? '');
    if (!name) return { status: 400, body: 'Invalid filename in mime header.\n' };
    const key = `${link.repoId}|${dir}|${name}`;
    // Like the file server: write the piece where it says, whatever is there.
    const have = state.partial.get(key) ?? new Uint8Array(0);
    const next = new Uint8Array(Math.max(have.byteLength, to + 1));
    next.set(have);
    next.set(piece, from);
    state.uploads.push({ dir, name, range: [from, to, total], size: piece.byteLength });
    if (to !== total - 1) { state.partial.set(key, next); return json({ success: true }); }
    state.partial.delete(key);
    const stored = numbered(name, new Set(entries(repo, dir).map(([p]) => base(p))));
    repo.files.set(clean(`${dir}/${stored}`), next);
    return json([{ id: 'f', name: stored, size: next.byteLength }]);
  }
  state.uploadLinks = new Map();
  state.downloads = new Map();

  async function route(url, init) {
    const method = (init.method ?? (init.body ? 'POST' : 'GET')).toUpperCase();
    const path = url.pathname;
    const q = url.searchParams;
    const form = () => new URLSearchParams(typeof init.body === 'string' ? init.body : '');

    // The file server: its links carry their own token.
    if (path.startsWith('/seafhttp/upload-api/')) return upload(url, init);
    if (path.startsWith('/seafhttp/files/')) {
      const target = state.downloads.get(path.split('/')[3]);
      if (!target) return { status: 400, body: 'Bad access token' };
      return { status: 200, raw: bytes(target.repoId, target.path) };
    }

    // Open to everyone.
    if (path === '/api2/server-info/') return json({ version, features: ['seafile-basic', ...(browserSignIn ? ['client-sso-via-local-browser'] : [])] });
    if (path === '/api2/client-sso-link/' && method === 'POST') {
      if (!browserSignIn) return { status: 404, body: '<html>Not Found</html>' };
      const token = `signin${String(++counter).padStart(54, '0')}`;
      state.signIns.set(token, 'waiting');
      return json({ link: `${origin}/client-sso/${token}/` });
    }
    const signIn = /^\/api2\/client-sso-link\/([^/]+)\/$/.exec(path);
    if (signIn) {
      const status = state.signIns.get(signIn[1]);
      if (!status) return { status: 404, body: '<html>Not Found</html>' };
      return json(status === 'success' ? { status, username: user.email, apiToken: 'device-token' } : { status });
    }

    // Everything else needs the token.
    if (state.token === null) return json({ detail: 'Authentication credentials were not provided.' }, 403);
    if (state.token === false) return json({ detail: 'Invalid token' }, 401);

    if (path === '/api2/account/info/') return json({ ...user, total: -2, usage: 0 });
    if (path === '/api2/devices/' && method === 'DELETE') { state.unlinked.push(Object.fromEntries(form())); return json({ success: true }); }
    if (path === '/api/v2.1/repos/') return json({ repos: [...state.repos.values()].map(repoInfo) });
    if (path === '/api2/repos/' && method === 'POST') {
      const repoId = addLibrary(form().get('name'));
      return json({ repo_id: repoId, repo_name: form().get('name'), repo_size: 0, permission: 'rw' });
    }
    if (path === '/api/v2.1/starred-items/') return json({ starred_item_list: state.starred });
    if (path === '/api/v2.1/search-file/') {
      const repo = repoOf(q.get('repo_id'));
      if (!repo) return fail(404, 'Library not found.');
      const text = q.get('q').toLowerCase();
      return json({ data: [...repo.files.keys()].filter((p) => p !== '/' && base(p).toLowerCase().includes(text)).map((p) => ({
        path: repo.files.get(p) === null ? `${p}/` : p, size: repo.files.get(p)?.byteLength ?? 0, mtime: '2026-11-12T18:47:35+01:00', type: repo.files.get(p) === null ? 'folder' : 'file',
      })) });
    }
    if (path === '/api/v2.1/multi-share-links/' && method === 'POST') {
      const body = JSON.parse(init.body);
      const repo = repoOf(body.repo_id);
      if (!repo || !repo.files.has(clean(body.path))) return fail(404, 'Folder or file not found.');
      if (body.password && body.password.length < passwordMinLength) return fail(400, 'Password is too short.');
      const token = `share${state.shares.length + 1}`;
      state.shares.push({ token, ...body });
      return json({ token, link: `${origin}/${repo.files.get(clean(body.path)) === null ? 'd' : 'f'}/${token}/`, expire_date: body.expiration_time ?? '' });
    }

    const m = /^\/api(?:2|\/v2\.1)\/repos\/([0-9a-f-]{36})\/(.*)$/.exec(path);
    if (!m) return fail(404, 'Not found');
    const repo = repoOf(m[1]);
    if (!repo) return fail(404, `Library ${m[1]} not found.`);
    const tail = m[2];
    const v2 = path.startsWith('/api/v2.1/');
    if (v2 && tail === 'dir/' && method === 'GET') {
      const dir = clean(q.get('p'));
      if (repo.files.get(dir) !== null) return fail(404, `Folder ${dir}/ not found.`);
      return json({ user_perm: repo.permission, dir_id: 'd', dirent_list: entries(repo, dir).map(([p]) => dirent(repo, p)) });
    }
    if (v2 && tail === 'dir/' && method === 'POST') {
      const dir = clean(q.get('p'));
      if (repo.files.get(parent(dir)) !== null) return fail(404, `Folder ${parent(dir)} not found.`);
      if (repo.permission !== 'rw') return fail(403, 'Permission denied.');
      const name = numbered(base(dir), new Set(entries(repo, parent(dir)).map(([p]) => base(p))));
      repo.files.set(clean(`${parent(dir)}/${name}`), null);
      return json({ type: 'dir', repo_id: repo.repo_id, parent_dir: parent(dir), obj_name: name });
    }
    if (v2 && tail === 'dir/detail/') {
      const dir = clean(q.get('path'));
      return repo.files.get(dir) === null ? json({ repo_id: repo.repo_id, path: `${dir}/`, name: base(dir) }) : fail(404, `Folder ${dir}/ not found.`);
    }
    if (v2 && tail === 'file-uploaded-bytes/') {
      return json({ uploadedBytes: state.partial.get(`${repo.repo_id}|${clean(q.get('parent_dir'))}|${q.get('file_name')}`)?.byteLength ?? 0 });
    }
    if (!v2 && tail === 'file/detail/') {
      const file = clean(q.get('p'));
      return repo.files.get(file) ? json({ ...dirent(repo, file), last_modified: '2026-11-12T18:47:35+01:00' }) : fail(404, 'File not found');
    }
    if (!v2 && tail === 'file/') {
      const file = clean(q.get('p'));
      if (!repo.files.get(file)) return fail(404, 'File not found');
      const key = `dl${++counter}`;
      state.downloads.set(key, { repoId: repo.repo_id, path: file });
      return json(`${fileServer}/seafhttp/files/${key}/${encodeURIComponent(base(file))}`);
    }
    if (!v2 && tail === 'upload-link/') {
      const dir = clean(q.get('p'));
      if (repo.files.get(dir) !== null) return fail(404, `Folder ${dir} not found.`);
      if (repo.permission !== 'rw') return fail(403, 'You do not have permission to access this folder.');
      const key = `up${++counter}`;
      state.uploadLinks.set(key, { repoId: repo.repo_id, dir });
      return json(`${fileServer}/seafhttp/upload-api/${key}`);
    }
    return fail(404, 'Not found');
  }

  /** The handler for 'proxy.fetch': the proxy's own rules, then Seafile's answer. */
  async function handler(credentialId, target, init = {}) {
    const url = new URL(target);
    const method = (init.method ?? (init.body ? 'POST' : 'GET')).toUpperCase();
    state.requests.push(`${method} ${url.pathname}${url.search}`);
    if (credentialId !== 'seafile') return { status: 404, ok: false, headers: {}, body: 'No such credential', proxyError: 'no_credential' };
    if (url.origin !== origin) return { status: 403, ok: false, headers: {}, body: 'This credential is only for its own server', proxyError: 'wrong_origin' };
    if (init.signal?.aborted) throw new Error('cancelled');
    let res;
    const planned = state.failures.find((f) => f.times > 0 && f.match(method, url));
    if (planned) {
      planned.times--;
      res = typeof planned.response === 'function' ? await planned.response(url, init, () => route(url, init)) : planned.response;
      if (res instanceof Error) throw res;
    } else {
      res = await route(url, init);
    }
    const ok = res.status >= 200 && res.status < 300;
    if (res.proxyError) return { status: res.status, ok: false, headers: {}, body: res.body ?? '', proxyError: res.proxyError };
    // Like the proxy: a captured answer comes back as JSON without the secret.
    if (init.capture) {
      let data = null;
      try { data = JSON.parse(res.body); } catch { /* not JSON */ }
      if (!ok || !data || typeof data !== 'object') return { status: res.status, ok, headers: {}, body: { captured: false } };
      const rest = { ...data };
      delete rest[init.capture.secret];
      delete rest[init.capture.username];
      const captured = typeof data[init.capture.secret] === 'string' && !!data[init.capture.secret];
      if (captured) { state.token = 'valid'; state.captured = { secret: data[init.capture.secret], username: data[init.capture.username] }; }
      return { status: res.status, ok, headers: {}, body: { ...rest, captured } };
    }
    const type = init.responseType ?? 'text';
    if (res.raw) {
      if (type === 'stream') {
        const half = Math.ceil(res.raw.byteLength / 2);
        return { status: 200, ok: true, headers: {}, body: new ReadableStream({ start(c) { c.enqueue(res.raw.slice(0, half)); if (half < res.raw.byteLength) c.enqueue(res.raw.slice(half)); c.close(); } }) };
      }
      return { status: 200, ok: true, headers: {}, body: res.raw.slice().buffer };
    }
    return { status: res.status, ok, headers: {}, body: type === 'json' ? JSON.parse(res.body) : res.body };
  }

  /** Answer the next `times` requests that match with `response` (a result, an Error to throw, or a function). */
  function failNext(match, response, times = 1) {
    const test = typeof match === 'function' ? match : (method, url) => `${method} ${url.pathname}`.includes(match);
    state.failures.push({ match: test, response, times });
  }

  return { state, origin, handler, addLibrary, addFolder, addFile, bytes, completeSignIn, failNext };
}

/**
 * An api whose proxy talks to the fake Seafile. `account`: 'browser' (signed
 * in through the browser, the proxy knows the user id), 'token' (a pasted
 * token) or null (nothing connected).
 */
export function seafileApi(sf, { account = 'browser', fixed = '', settings = {}, translations, handlers = {}, version = '1.0.0' } = {}) {
  const stored = { exists: account !== null, connected: account !== null, username: account === 'browser' ? USER.email : '' };
  if (account === null) sf.state.token = null;
  const api = fakeApi({
    version, settings, translations,
    handlers: {
      'config.get': async () => ({ serverUrl: fixed }),
      'proxy.accounts': async () => (stored.exists
        ? [{ credentialId: 'seafile', scope: 'user', origin: sf.origin, ...(stored.username ? { username: stored.username } : {}), connected: stored.connected }]
        : []),
      'proxy.fetch': async (...args) => {
        const res = await sf.handler(...args);
        if (res.body?.captured === true) { stored.exists = true; stored.connected = true; stored.username = sf.state.captured.username; }
        return res;
      },
      'proxy.disconnect': async () => { stored.exists = false; stored.connected = false; stored.username = ''; sf.state.token = null; return true; },
      // The host's dialog: sign-in mode approves the server, password mode stores what was typed.
      'proxy.connect': async (id, opts) => {
        stored.exists = true;
        if (opts?.mode === 'password') { stored.connected = true; stored.username = ''; if (sf.state.token === null) sf.state.token = 'valid'; return { connected: true, origin: sf.origin }; }
        return { connected: false, origin: sf.origin };
      },
      ...handlers,
    },
  });
  api.stored = stored;
  return api;
}
