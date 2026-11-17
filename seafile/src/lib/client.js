// Talks to the user's Seafile through the webmail's secret proxy. The proxy
// adds the access token; this code never sees it.
//
// Seafile keeps files in libraries. The web API (/api2, /api/v2.1) lists
// and changes them; the bytes of a file go through the file server, whose
// one-time links ("…/seafhttp/…") the web API hands out.

import { SfError, errorFromException, errorFromResponse } from './errors.js';
import { endOfDay } from './format.js';
import { mimeOf } from './mime.js';
import {
  baseName, encodePath, joinPath, libraryPath, normalizePath, parentPath, splitPath,
} from './paths.js';

export const CREDENTIAL = 'seafile';
/** Largest download taken in one piece; bigger ones are streamed. */
export const BUFFERED_LIMIT = 24 * 1024 * 1024;
/** How many libraries a search from the list of libraries looks into. */
export const MAX_SEARCH_LIBRARIES = 12;

const JSON_HEADERS = { Accept: 'application/json' };
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

/** Low-level request: throws SfError, returns the proxy result when it went through. */
export async function sfRequest(api, url, init = {}, { kind } = {}) {
  let res;
  try {
    res = await api.proxy.fetch(CREDENTIAL, url, init);
  } catch (err) {
    throw errorFromException(err, init.signal);
  }
  if (init.signal?.aborted) throw new SfError('cancelled');
  const err = errorFromResponse(res, { kind });
  if (err) throw err;
  return res;
}

export function parseJson(body) {
  if (body && typeof body === 'object') return body;
  try { return JSON.parse(String(body ?? '')); } catch { throw new SfError('bad_answer'); }
}

/** A request whose answer is JSON; returns the parsed answer. */
export async function sfJson(api, url, init = {}, opts = {}) {
  const res = await sfRequest(api, url, {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
    responseType: 'text',
  }, opts);
  return parseJson(res.body);
}

function query(params) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) q.set(key, String(value));
  // Seafile reads "+" as a space but a browser's download link keeps "%20".
  return q.toString().replace(/\+/g, '%20');
}

const canWrite = (permission) => permission === 'rw' || permission === 'admin';
const time = (value) => {
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : 0;
};

/** A library as the browser shows it: a folder at the top level. */
export function toLibrary(repo) {
  const repoId = String(repo?.repo_id ?? '');
  if (!repoId) return null;
  const permission = String(repo.permission ?? '');
  const encrypted = repo.encrypted === true || repo.encrypted === 1 || repo.encrypted === '1';
  return {
    path: `/${repoId}`,
    name: String(repo.repo_name ?? repoId),
    isFolder: true,
    isLibrary: true,
    size: Number(repo.size) || 0,
    sizeKnown: true,
    type: '',
    modified: time(repo.last_modified),
    repoId,
    kind: String(repo.type ?? ''),
    owner: repo.type === 'mine' ? '' : String(repo.group_name || repo.owner_name || ''),
    encrypted,
    writable: canWrite(permission) && !encrypted,
  };
}

/** One row of a folder listing. */
export function toEntry(repoId, parent, item) {
  const name = String(item?.name ?? '');
  if (!name) return null;
  const isFolder = item.type === 'dir';
  return {
    path: libraryPath(repoId, joinPath(parent, name)),
    name,
    isFolder,
    isLibrary: false,
    size: isFolder ? 0 : Number(item.size) || 0,
    sizeKnown: true,
    type: isFolder ? '' : mimeOf(name),
    modified: time(item.mtime),
    repoId,
    writable: canWrite(String(item.permission ?? '')),
  };
}

/** Own libraries first, then by name; in a folder, folders first. */
export function sortEntries(entries, locale) {
  const collator = new Intl.Collator(locale || undefined, { numeric: true, sensitivity: 'base' });
  const rank = (e) => (e.isLibrary ? (e.kind === 'mine' ? 0 : 1) : e.isFolder ? 2 : 3);
  return [...entries].sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name));
}

/** One library per id: the user's own, else the one they may write to. */
export function uniqueLibraries(repos) {
  const byId = new Map();
  for (const repo of repos ?? []) {
    const lib = toLibrary(repo);
    if (!lib) continue;
    const seen = byId.get(lib.repoId);
    if (!seen || (seen.kind !== 'mine' && (lib.kind === 'mine' || (lib.writable && !seen.writable)))) byId.set(lib.repoId, lib);
  }
  return [...byId.values()];
}

/**
 * A client for one connection: { origin }.
 */
export function createClient(api, conn) {
  const { origin } = conn;
  const host = new URL(origin).hostname;
  let known = null; // Map repoId -> library, from the last listing

  const repoUrl = (repoId, tail, params) => `${origin}/api/v2.1/repos/${encodeURIComponent(repoId)}/${tail}${params ? `?${query(params)}` : ''}`;
  const repoUrl2 = (repoId, tail, params) => `${origin}/api2/repos/${encodeURIComponent(repoId)}/${tail}${params ? `?${query(params)}` : ''}`;

  /**
   * A link the file server handed out, on the address the webmail is
   * connected to. Seafile builds these from its own settings; when they
   * name another server the proxy would refuse the request, so say so.
   */
  function fileServerUrl(link) {
    let url;
    try { url = new URL(String(link ?? '')); } catch { throw new SfError('bad_answer', { detail: 'file server link' }); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SfError('bad_answer', { detail: 'file server link' });
    if (url.origin === origin) return url;
    // The same host without a port: Seafile's settings leave out the port,
    // or say http where a TLS proxy in front makes it https. The file
    // server is under the connected address then; requests only ever go there.
    if (url.hostname === host && !url.port) return new URL(`${origin}${url.pathname}${url.search}`);
    throw new SfError('file_server', { detail: url.host });
  }

  async function loadLibraries(signal) {
    const data = await sfJson(api, `${origin}/api/v2.1/repos/`, { signal });
    const list = uniqueLibraries(data?.repos);
    known = new Map(list.map((lib) => [lib.repoId, lib]));
    return list;
  }

  /** The library with this id; asks the server once when it isn't known yet. */
  async function library(repoId) {
    if (!known || !known.has(repoId)) await loadLibraries();
    const lib = known.get(repoId);
    if (!lib) throw new SfError('not_found');
    return lib;
  }

  /** The library a path is in, opened: not the list of libraries, not an encrypted one. */
  async function inLibrary(path) {
    const { repoId, inner } = splitPath(path);
    if (!repoId) throw new SfError('no_library');
    const lib = await library(repoId);
    if (lib.encrypted) throw new SfError('encrypted');
    return { repoId, inner, lib };
  }

  async function searchLibrary(lib, text, signal) {
    let data;
    try {
      data = await sfJson(api, `${origin}/api/v2.1/search-file/?${query({ repo_id: lib.repoId, q: text })}`, { signal });
    } catch (err) {
      // A library that can't be searched doesn't spoil the others.
      if (err instanceof SfError && (err.code === 'not_found' || err.code === 'forbidden' || err.code === 'encrypted')) return [];
      throw err;
    }
    const out = [];
    for (const item of Array.isArray(data?.data) ? data.data : []) {
      const inner = normalizePath(item?.path);
      if (inner === '/') continue;
      const isFolder = item.type === 'folder';
      out.push({
        path: libraryPath(lib.repoId, inner),
        name: baseName(inner),
        isFolder,
        isLibrary: false,
        size: isFolder ? 0 : Number(item.size) || 0,
        sizeKnown: true,
        type: isFolder ? '' : mimeOf(inner),
        modified: time(item.mtime),
        repoId: lib.repoId,
        writable: lib.writable,
      });
    }
    return out;
  }

  const client = {
    origin,

    /** A library's name, as far as a listing told; '' before that. */
    nameOf: (repoId) => known?.get(repoId)?.name ?? '',

    /** The user's libraries, their own first. */
    async libraries(locale, { signal } = {}) {
      return sortEntries(await loadLibraries(signal), locale);
    },

    /**
     * What is in `path` (the libraries for "/"), folders first, and whether
     * the user may put files there.
     */
    async listing(path, locale) {
      const { repoId } = splitPath(path);
      if (!repoId) return { entries: await client.libraries(locale), writable: false };
      const { inner, lib } = await inLibrary(path);
      const data = await sfJson(api, repoUrl(repoId, 'dir/', { p: inner }));
      const entries = (Array.isArray(data?.dirent_list) ? data.dirent_list : []).map((item) => toEntry(repoId, inner, item)).filter(Boolean);
      return { entries: sortEntries(entries, locale), writable: lib.writable && canWrite(String(data?.user_perm ?? '')) };
    },

    async list(path, locale) {
      return (await client.listing(path, locale)).entries;
    },

    /** One file with its size, or null when there is none. */
    async stat(path) {
      const { repoId, inner } = splitPath(path);
      if (!repoId || inner === '/') return null;
      let data;
      try {
        data = await sfJson(api, repoUrl2(repoId, 'file/detail/', { p: inner }));
      } catch (err) {
        if (err instanceof SfError && err.code === 'not_found') return null;
        throw err;
      }
      return toEntry(repoId, parentPath(inner), { ...data, type: 'file', name: baseName(inner) });
    },

    /** Whether a folder is there. The list of libraries always is. */
    async folderExists(path) {
      const { repoId, inner } = splitPath(path);
      if (!repoId) return normalizePath(path) === '/';
      try {
        if (inner === '/') { await library(repoId); return true; }
        await sfJson(api, repoUrl(repoId, 'dir/detail/', { path: inner }));
        return true;
      } catch (err) {
        if (err instanceof SfError && err.code === 'not_found') return false;
        throw err;
      }
    },

    /**
     * Files and folders whose name contains the text: in the library `path`
     * is in, or from the list of libraries in the libraries themselves
     * (the first MAX_SEARCH_LIBRARIES; the names of all of them).
     */
    async search(text, { path = '/', limit = 100, signal, locale } = {}) {
      const q = String(text ?? '').trim();
      if (!q) return [];
      const { repoId } = splitPath(path);
      if (repoId) return (await searchLibrary((await inLibrary(path)).lib, q, signal)).slice(0, limit);
      const libs = await client.libraries(locale, { signal });
      const out = libs.filter((lib) => lib.name.toLowerCase().includes(q.toLowerCase()));
      for (const lib of libs.filter((l) => !l.encrypted).slice(0, MAX_SEARCH_LIBRARIES)) {
        if (out.length >= limit) break;
        if (signal?.aborted) throw new SfError('cancelled');
        out.push(...await searchLibrary(lib, q, signal));
      }
      return out.slice(0, limit);
    },

    /** The files, folders and libraries the user marked as favorites in Seafile. */
    async favorites({ signal } = {}) {
      const data = await sfJson(api, `${origin}/api/v2.1/starred-items/`, { signal });
      const out = [];
      for (const item of Array.isArray(data?.starred_item_list) ? data.starred_item_list : []) {
        const repoId = String(item?.repo_id ?? '');
        if (!repoId || item.deleted || item.repo_encrypted) continue;
        const inner = normalizePath(item.path);
        const isLibrary = inner === '/';
        const isFolder = isLibrary || item.is_dir === true;
        const lib = known?.get(repoId);
        out.push({
          path: libraryPath(repoId, inner),
          name: isLibrary ? String(item.repo_name ?? '') : baseName(inner),
          isFolder,
          isLibrary,
          // The list of favorites has no sizes: a library's comes from the
          // list of libraries once that was loaded, a file's from stat().
          size: isLibrary ? (lib?.size ?? 0) : 0,
          sizeKnown: isLibrary ? !!lib : isFolder,
          type: isFolder ? '' : mimeOf(inner),
          modified: time(item.mtime),
          repoId,
          repoName: String(item.repo_name ?? ''),
          kind: lib?.kind ?? '',
          owner: '',
          encrypted: false,
          writable: lib?.writable ?? false,
        });
      }
      return out;
    },

    /** Create a library; resolves to it. */
    async createLibrary(name) {
      const data = await sfJson(api, `${origin}/api2/repos/`, { method: 'POST', headers: FORM, body: query({ name }) });
      const lib = toLibrary({ ...data, type: 'mine', permission: 'rw', encrypted: false });
      if (!lib) throw new SfError('bad_answer');
      known?.set(lib.repoId, lib);
      return lib;
    },

    /** The user's library with this name that takes files, made if there is none. */
    async ensureLibrary(name) {
      const libs = (await loadLibraries()).filter((lib) => lib.name === name && lib.writable);
      return libs.find((lib) => lib.kind === 'mine') ?? libs[0] ?? client.createLibrary(name);
    },

    /**
     * Create a folder; resolves to its path. Seafile adds " (1)" to the
     * name when there is already something called that.
     */
    async mkdir(path) {
      const { repoId, inner } = await inLibrary(path);
      if (inner === '/') return libraryPath(repoId);
      const data = await sfJson(api, repoUrl(repoId, 'dir/', { p: inner }), { method: 'POST', headers: FORM, body: 'operation=mkdir' });
      const name = typeof data?.obj_name === 'string' && data.obj_name ? data.obj_name : baseName(inner);
      return libraryPath(repoId, joinPath(parentPath(inner), name));
    },

    /** Create a folder and its parents; an existing one is fine. Resolves to its path. */
    async mkdirp(path) {
      const { repoId, inner } = splitPath(path);
      if (!repoId) throw new SfError('no_library');
      if (inner === '/' || await client.folderExists(path)) return libraryPath(repoId, inner);
      const parent = await client.mkdirp(libraryPath(repoId, parentPath(inner)));
      return client.mkdir(joinPath(parent, baseName(inner)));
    },

    /** Names taken in a folder (for picking a free name). */
    async names(path) {
      try {
        return (await client.list(path)).map((e) => e.name);
      } catch (err) {
        if (err instanceof SfError && err.code === 'not_found') return [];
        throw err;
      }
    },

    /** The bytes of a file. Large files, and files of unknown size, come in as a stream. */
    async download(entry, { onProgress, signal } = {}) {
      const { repoId, inner } = await inLibrary(entry.path);
      const link = await sfJson(api, repoUrl2(repoId, 'file/', { p: inner, reuse: 1 }), { signal });
      const url = fileServerUrl(link).toString();
      const size = Number(entry.size) || 0;
      if (entry.sizeKnown !== false && size <= BUFFERED_LIMIT) {
        const res = await sfRequest(api, url, { method: 'GET', responseType: 'arraybuffer', signal });
        const bytes = new Uint8Array(res.body);
        onProgress?.(bytes.byteLength, bytes.byteLength);
        return bytes;
      }
      const res = await sfRequest(api, url, { method: 'GET', responseType: 'stream', signal });
      const reader = res.body.getReader();
      const parts = [];
      let loaded = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          loaded += value.byteLength;
          onProgress?.(loaded, Math.max(size, loaded));
        }
      } catch (err) {
        throw errorFromException(err, signal);
      }
      const out = new Uint8Array(loaded);
      let offset = 0;
      for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
      return out;
    },

    /** Where to send a file for the folder `dir` of a library (the file server's upload address). */
    async uploadLink(repoId, dir, { signal } = {}) {
      const link = await sfJson(api, repoUrl2(repoId, 'upload-link/', { p: dir }), { signal });
      const url = fileServerUrl(link);
      url.searchParams.set('ret-json', '1');
      return url.toString();
    },

    /** How much of an unfinished upload the file server already has. */
    async uploadedBytes(repoId, dir, name, { signal } = {}) {
      try {
        const data = await sfJson(api, repoUrl(repoId, 'file-uploaded-bytes/', { parent_dir: dir, file_name: name }), { signal });
        return Math.max(0, Number(data?.uploadedBytes) || 0);
      } catch (err) {
        if (err instanceof SfError && err.code === 'not_found') return 0;
        throw err;
      }
    },

    /**
     * A public, read-only share link. `password` and `expireDate`
     * (YYYY-MM-DD, the last day the link works) are optional.
     */
    async share(path, { password, expireDate } = {}) {
      const { repoId, inner } = await inLibrary(path);
      const body = { repo_id: repoId, path: inner, permissions: { can_edit: false, can_download: true, can_upload: false } };
      if (password) body.password = password;
      const expires = endOfDay(expireDate);
      if (expires) body.expiration_time = expires;
      const data = await sfJson(api, `${origin}/api/v2.1/multi-share-links/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, { kind: 'share' });
      const url = data?.link;
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new SfError('bad_answer');
      return { id: String(data.token ?? ''), url, password: password || '', expireDate: expireDate || '', name: baseName(inner) || (await library(repoId)).name };
    },

    /**
     * A password for a share link. Seafile has no generator of its own;
     * this one meets its strictest rules (all four kinds of characters).
     */
    async generatePassword() {
      return localPassword();
    },

    /** Where to open a file, folder or library in Seafile's web interface. */
    webUrl(entry) {
      const { repoId, inner } = splitPath(entry.path);
      if (!repoId) return origin;
      if (!entry.isFolder) return `${origin}/lib/${repoId}/file${encodePath(inner)}`;
      const name = encodeURIComponent(client.nameOf(repoId) || entry.repoName || repoId);
      return `${origin}/library/${repoId}/${name}${inner === '/' ? '/' : encodePath(inner)}`;
    },

    joinPath,
  };

  return client;
}

const ALPHABETS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '-_+!#'];

/** 20 characters with upper and lower case letters, digits and a symbol. */
export function localPassword(random = defaultRandom) {
  const all = ALPHABETS.join('');
  const chars = ALPHABETS.map((set) => set[random(set.length)]);
  while (chars.length < 20) chars.push(all[random(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function defaultRandom(n) {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] % n;
}
