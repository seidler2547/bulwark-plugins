// Uploads to Seafile. The web API hands out an upload address on the file
// server; a file goes there as a multipart form. Small files take one
// request. Bigger ones go up in pieces, each with a Content-Range: the file
// server keeps what it has under the file's name and folder, says how much
// that is (file-uploaded-bytes), and puts the file in place with the last
// piece. A cancelled or failed upload goes on from there.
//
// The file server takes any piece at any offset, so the pieces must come in
// order and from the same file. What it holds under a name the plugin didn't
// start is left alone: the upload takes another name. What the plugin did
// start is remembered here for as long as the file server keeps it, so the
// same file to the same place goes on from there, also after its row was
// removed from the page. Each unfinished upload has a storage key of its
// own, so uploads in different frames don't overwrite each other's records.

import { parseJson, sfRequest } from './client.js';
import { SfError } from './errors.js';
import { baseName, joinPath, libraryPath, parentPath, splitPath, uniqueName } from './paths.js';

export const CHUNK_SIZE = 10 * 1024 * 1024;
export const UPLOAD_PREFIX = 'upload:';
/** An upload address works for an hour; take a new one well before that. */
const LINK_MAX_AGE_MS = 10 * 60 * 1000;
/** The file server drops the pieces of an unfinished upload after three days. */
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const RETRYABLE = new Set(['unreachable', 'timeout', 'server', 'maintenance', 'rate_limited']);

/** Identifies "the same file to the same place" across attempts. */
export function resumeKey(destPath, file) {
  return `${destPath}|${file.size}|${file.lastModified ?? 0}|${file.name ?? ''}`;
}

function fnv1a(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The storage key for the record of an unfinished upload. Storage keys are
 * short and a resumeKey() may not be, so this is a hash of it; the record
 * keeps the resumeKey to tell two uploads apart.
 */
export function uploadKey(resume) {
  return `${UPLOAD_PREFIX}${fnv1a(resume, 0x811c9dc5)}${fnv1a(resume, 0x9e3779b1)}`;
}

/** Forget the unfinished uploads the file server has dropped by now: there is nothing to go on from. */
async function dropExpired(api, now) {
  for (const key of await api.storage.keys()) {
    if (!key.startsWith(UPLOAD_PREFIX)) continue;
    const record = await api.storage.get(key);
    if (!(now() - Number(record?.startedAt) < KEEP_MS)) await api.storage.remove(key);
  }
}

function boundary() {
  return `----bulwark${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

/** A multipart/form-data body with the form fields and one file, as browsers build it. */
export function multipartBody(fields, blob, filename, mark = boundary()) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${mark}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value).replace(/[\r\n]/g, ' ')}\r\n`);
  }
  const safe = String(filename).replace(/[\r\n]/g, ' ').replace(/"/g, '%22');
  parts.push(`--${mark}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  parts.push(blob);
  parts.push(`\r\n--${mark}--\r\n`);
  return { body: new Blob(parts), contentType: `multipart/form-data; boundary=${mark}` };
}

/** The name Seafile gave the file: it adds " (1)" when the name was taken. */
function storedName(body, fallback) {
  let data;
  try { data = parseJson(body); } catch { return fallback; }
  const first = Array.isArray(data) ? data[0] : data;
  return typeof first?.name === 'string' && first.name ? first.name : fallback;
}

const retryable = (err) => err instanceof SfError
  && (RETRYABLE.has(err.code) || (err.code === 'rejected' && /offset/i.test(err.detail)));

/**
 * Upload `file` (a Blob/File) to `destPath`, a path in a library whose
 * folder exists. onProgress(loaded, total). Resolves to
 * { path, chunked, resumed }; the path has the name Seafile stored.
 */
export async function uploadFile(api, client, file, destPath, {
  onProgress, signal, chunkSize = CHUNK_SIZE, retries = 2, wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
} = {}) {
  const { repoId, inner } = splitPath(destPath);
  if (!repoId || inner === '/') throw new SfError('no_library');
  const dir = parentPath(inner);
  const size = file.size;
  const at = (name) => libraryPath(repoId, joinPath(dir, name));
  const stopped = () => { if (signal?.aborted) throw new SfError('cancelled'); };
  /** Whether the file is in place although the answer to its last piece got lost. */
  const arrived = async (name) => {
    const entry = await client.stat(at(name)).catch(() => null);
    return !!entry && entry.size === size;
  };

  let link = null;
  let linkAt = 0;
  const address = async () => {
    if (!link || now() - linkAt > LINK_MAX_AGE_MS) {
      link = await client.uploadLink(repoId, dir, { signal });
      linkAt = now();
    }
    return link;
  };
  const send = async (name, blob, headers, progress) => {
    const form = multipartBody({ parent_dir: dir, replace: '0' }, blob, name);
    return sfRequest(api, await address(), {
      method: 'POST',
      headers: { 'Content-Type': form.contentType, ...headers },
      body: form.body,
      responseType: 'text',
      onProgress: progress,
      signal,
    });
  };

  if (size <= chunkSize) {
    const name = baseName(inner);
    for (let attempt = 0; ; attempt++) {
      stopped();
      try {
        const res = await send(name, file, {}, (loaded) => onProgress?.(Math.min(loaded, size), size));
        onProgress?.(size, size);
        return { path: at(storedName(res.body, name)), chunked: false, resumed: false };
      } catch (err) {
        if (signal?.aborted) throw new SfError('cancelled');
        if (!retryable(err) || attempt >= retries) throw err;
        await wait(1000 * (attempt + 1));
        // Sending it again would store a second copy.
        if (await arrived(name)) { onProgress?.(size, size); return { path: at(name), chunked: false, resumed: false }; }
        link = null;
      }
    }
  }

  const resume = resumeKey(destPath, file);
  const key = uploadKey(resume);
  await dropExpired(api, now);
  const found = await api.storage.get(key);
  let record = found?.key === resume ? found : null;
  let name = typeof record?.name === 'string' && record.name ? record.name : baseName(inner);
  let offset = await client.uploadedBytes(repoId, dir, name, { signal });
  if (!record || offset >= size) {
    // Bytes under this name that this upload didn't send belong to another
    // file. Going on from them would mix the two.
    const taken = [];
    for (let i = 0; offset > 0 && i < 20; i++) {
      taken.push(name);
      name = uniqueName(baseName(inner), taken);
      offset = await client.uploadedBytes(repoId, dir, name, { signal });
    }
    if (offset > 0) throw new SfError('exists');
    record = { key: resume, name, startedAt: now() };
    await api.storage.set(key, record);
  }
  const resumed = offset > 0;
  const header = { 'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"` };
  onProgress?.(offset, size);

  let stored = name;
  for (let attempt = 0; ;) {
    stopped();
    const start = offset;
    const end = Math.min(size, start + chunkSize);
    const last = end === size;
    try {
      const res = await send(name, file.slice(start, end), { ...header, 'Content-Range': `bytes ${start}-${end - 1}/${size}` },
        (loaded) => onProgress?.(Math.min(end, start + loaded), size));
      attempt = 0;
      offset = end;
      onProgress?.(offset, size);
      if (last) { stored = storedName(res.body, name); break; }
    } catch (err) {
      if (signal?.aborted) throw new SfError('cancelled');
      if (!retryable(err) || attempt >= retries) throw err;
      attempt++;
      await wait(1000 * attempt);
      if (last && await arrived(name)) break;
      // Go on from what the file server really has.
      offset = await client.uploadedBytes(repoId, dir, name, { signal });
      // Everything is there but the file never appeared: nothing to go on from.
      if (offset >= size) throw err;
      link = null;
      onProgress?.(offset, size);
    }
  }

  await api.storage.remove(key);
  onProgress?.(size, size);
  return { path: at(stored), chunked: true, resumed };
}
