// Places in the user's Seafile and what to call them.
//
// A path is "/" for the list of libraries, "/<library id>" for the top
// folder of a library and "/<library id>/Documents/Invoices" below it, never
// with a trailing slash. It carries the library's id, not its name: two
// libraries may share a name ("My Library" of two people).

const REPO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Clean up a path: one leading slash, no empty, "." or ".." segments. */
export function normalizePath(path) {
  const out = [];
  for (const part of String(path ?? '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return '/' + out.join('/');
}

export function joinPath(...parts) {
  return normalizePath(parts.map((p) => String(p ?? '')).join('/'));
}

export function parentPath(path) {
  const p = normalizePath(path);
  if (p === '/') return '/';
  return p.slice(0, p.lastIndexOf('/')) || '/';
}

export function baseName(path) {
  const p = normalizePath(path);
  return p === '/' ? '' : p.slice(p.lastIndexOf('/') + 1);
}

export function isRepoId(value) {
  return typeof value === 'string' && REPO_ID.test(value);
}

/**
 * The library a path is in and the path inside it: "/<id>/a/b" is
 * { repoId: "<id>", inner: "/a/b" }. The list of libraries, and anything
 * that doesn't start with a library id, has repoId null.
 */
export function splitPath(path) {
  const p = normalizePath(path);
  if (p === '/') return { repoId: null, inner: '/' };
  const end = p.indexOf('/', 1);
  const first = end < 0 ? p.slice(1) : p.slice(1, end);
  if (!isRepoId(first)) return { repoId: null, inner: '/' };
  return { repoId: first, inner: end < 0 ? '/' : p.slice(end) };
}

/** The path for a place inside a library. */
export function libraryPath(repoId, inner = '/') {
  const p = normalizePath(inner);
  return `/${repoId}${p === '/' ? '' : p}`;
}

/**
 * The folders from the list of libraries down to `path`, for a breadcrumb.
 * `nameOf(repoId)` gives a library's name; the first crumb has no name.
 */
export function breadcrumb(path, nameOf = () => '') {
  const { repoId, inner } = splitPath(path);
  const crumbs = [{ name: '', path: '/' }];
  if (!repoId) return crumbs;
  let acc = `/${repoId}`;
  // Until a listing told the library's name, "…" stands in for it.
  crumbs.push({ name: nameOf(repoId) || '…', path: acc });
  if (inner === '/') return crumbs;
  for (const part of inner.slice(1).split('/')) {
    acc += '/' + part;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

/** A path as people read it: "Documents/Invoices/a.pdf", '' for the list of libraries. */
export function displayPath(path, nameOf = () => '') {
  return breadcrumb(path, nameOf).slice(1).map((c) => c.name).join('/');
}

/** Percent-encode each segment, keep the slashes. */
export function encodePath(path) {
  return normalizePath(path).split('/').map((s) => encodeURIComponent(s)).join('/');
}

/** A file or folder name Seafile accepts: no slashes, no control characters, not empty. */
export function sanitizeFileName(name, fallback = 'file') {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/[:*?"<>|]/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 200)
    .trim();
  return cleaned || fallback;
}

/** `name`, or "name (2).ext", "name (3).ext", ... if it is already taken. */
export function uniqueName(name, taken) {
  const used = new Set([...(taken ?? [])].map((n) => String(n).toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 10000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/**
 * Where uploads from the webmail go. The setting names a library, or a
 * folder in one ("Mail attachments", "My Library/Mail"); with the "date"
 * layout a folder per day is added. Resolves to the library's name and the
 * folder inside it.
 */
export function uploadTarget(setting, layout, date = new Date()) {
  const parts = normalizePath(setting || 'Mail attachments').slice(1).split('/').filter(Boolean);
  const library = sanitizeFileName(parts[0] ?? '', 'Mail attachments');
  let folder = normalizePath(parts.slice(1).join('/'));
  if (layout === 'date') {
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    folder = joinPath(folder, day);
  }
  return { library, folder };
}

/** The origin of a URL the user or admin typed, adding https:// if missing; null if invalid. */
export function originOf(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}
