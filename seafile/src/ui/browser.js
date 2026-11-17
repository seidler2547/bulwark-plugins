// The Seafile file browser shared by the file picker, the folder picker
// and the Files page: the listing state (libraries, a folder, favorites,
// search) and the parts that show it, drawn with the app's UI kit like the
// Files app.

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import {
  Breadcrumbs, Button, EmptyState, List, ListRow, Loading, SearchInput, ToolbarButton,
} from '@plugin-host/ui';
import { breadcrumb, displayPath, libraryPath, parentPath, splitPath } from '../lib/paths.js';
import { errorText } from '../lib/errors.js';
import { formatDate, formatSize } from '../lib/format.js';

const SEARCH_DELAY_MS = 350;

/**
 * The listing of one place: the libraries or the folder at `path`, the
 * favorites, or search results for what the user typed (searched once
 * they stop typing). `writable` says whether files can be put there.
 */
export function useBrowser({ api, client, path, reloadKey = 0, onError }) {
  const locale = api.i18n.getLocale();
  const [view, setView] = useState('files');
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [state, setState] = useState({ loading: true, entries: [], writable: false, error: null });
  const [retry, setRetry] = useState(0);
  const seq = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setView((v) => (v === 'search' ? 'files' : v));
      return undefined;
    }
    const timer = setTimeout(() => { setSearched(q); setView('search'); }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    const load = view === 'favorites'
      ? client.favorites().then((entries) => ({ entries, writable: false }))
      : view === 'search'
        ? client.search(searched, { path, limit: 100, locale }).then((entries) => ({ entries, writable: false }))
        : client.listing(path, locale);
    load.then(
      ({ entries, writable }) => { if (seq.current === mine) setState({ loading: false, entries, writable: !!writable, error: null }); },
      (error) => {
        if (seq.current !== mine) return;
        setState({ loading: false, entries: [], writable: false, error });
        onErrorRef.current?.(error);
      },
    );
  }, [client, view, path, searched, reloadKey, retry]);

  const showView = useCallback((next) => {
    setView(next);
    if (next !== 'search') setQuery('');
  }, []);

  return {
    view, query, searched, path, ...state,
    setQuery,
    showView,
    reload: () => setRetry((n) => n + 1),
  };
}

/** The breadcrumb items for where the browser is. Ids starting with "#" are views. */
export function crumbItems(t, browser, path, nameOf) {
  if (browser.view === 'favorites') return [{ id: '#files', label: t('browser.libraries') }, { id: '#favorites', label: t('browser.favorites') }];
  const crumbs = (p) => breadcrumb(p, nameOf).map((c) => ({ id: c.path, label: c.name || t('browser.libraries') }));
  if (browser.view === 'search') {
    // Search looks into the library the user is in, so that is where the results are from.
    const { repoId } = splitPath(path);
    return [...crumbs(repoId ? libraryPath(repoId) : '/'), { id: '#search', label: t('browser.results', { query: browser.searched }) }];
  }
  return crumbs(path);
}

/** Breadcrumbs, search box and the Favorites toggle, for a Toolbar or a dialog's top row. */
export function browserBar({ api, client, browser, path, onNavigate, compact = false, search = true }) {
  const t = api.i18n.t;
  const select = (id) => {
    if (id === '#files') { browser.showView('files'); onNavigate('/'); return; }
    if (id.startsWith('#')) return;
    browser.showView('files');
    onNavigate(id);
  };
  return [
    h(Breadcrumbs, { key: 'crumbs', items: crumbItems(t, browser, path, client.nameOf), onSelect: select, label: t('browser.location') }),
    search ? h(SearchInput, {
      key: 'search', value: browser.query, onChange: browser.setQuery,
      placeholder: t('browser.searchPlaceholder'), label: t('browser.search'),
    }) : null,
    h(ToolbarButton, {
      key: 'favorites', icon: 'star', label: t('browser.favorites'), compact, active: browser.view === 'favorites',
      onClick: () => browser.showView(browser.view === 'favorites' ? 'files' : 'favorites'),
    }),
  ];
}

/** What a library's row says under its name: who shares it, and what can't be done with it. */
export function libraryNote(t, entry) {
  const notes = [];
  if (entry.owner) notes.push(t('browser.sharedBy', { name: entry.owner }));
  if (entry.encrypted) notes.push(t('browser.encrypted'));
  else if (!entry.writable) notes.push(t('browser.readOnly'));
  return notes.join(' · ') || undefined;
}

/**
 * The entries as Files app rows. mode: "files" (tick several files),
 * "folder" (only folders can be opened), "manage" (Files page: one file
 * selected at a time). `selected` is a Map path -> entry. `columns` adds the
 * Files app's column header and the modified date.
 */
export function BrowserList({ api, client, browser, mode, selected, onNavigate, onToggle, columns = false, before = null, empty = null }) {
  const t = api.i18n.t;
  const locale = api.i18n.getLocale();
  const flat = browser.view !== 'files';
  const shown = mode === 'folder' && flat ? browser.entries.filter((e) => e.isFolder) : browser.entries;

  let body;
  if (browser.loading) {
    body = h(Loading, { label: t('browser.loading') });
  } else if (browser.error) {
    body = h(EmptyState, {
      icon: 'alert-triangle', compact: !columns, title: errorText(t, browser.error),
      actions: h(Button, { variant: 'secondary', size: 'sm', onClick: browser.reload }, t('browser.retry')),
    });
  } else if (shown.length === 0) {
    body = browser.view === 'search'
      ? h(EmptyState, { icon: 'search', compact: !columns, title: t('browser.noResults') })
      : browser.view === 'favorites'
        ? h(EmptyState, { icon: 'star', compact: !columns, title: t('browser.noFavorites') })
        : (empty ?? h(EmptyState, { icon: 'folder-open', compact: !columns, title: splitPath(browser.path ?? '').repoId ? t('browser.empty') : t('browser.noLibraries') }));
  } else {
    body = shown.map((entry) => {
      const isSelected = selected?.has(entry.path) ?? false;
      const pickable = !entry.encrypted && (entry.isFolder || mode !== 'folder');
      const size = entry.isFolder && !entry.isLibrary ? '—' : entry.sizeKnown === false ? '—' : formatSize(entry.size, locale);
      const meta = columns ? [size, formatDate(entry.modified, locale)] : entry.isFolder && !entry.isLibrary ? undefined : [size];
      const nameOf = (id) => client.nameOf(id) || entry.repoName || '';
      const where = flat
        ? (entry.isLibrary ? t('browser.libraries') : displayPath(parentPath(entry.path), nameOf))
        : entry.isLibrary ? libraryNote(t, entry) : undefined;
      const tickable = mode === 'files' && !entry.isFolder;
      return h(ListRow, {
        key: entry.path,
        title: entry.name,
        subtitle: where,
        icon: entry.isFolder ? 'folder' : entry.name,
        folder: entry.isFolder,
        meta,
        selected: isSelected,
        disabled: !pickable,
        checked: tickable ? isSelected : undefined,
        onCheck: tickable ? () => onToggle?.(entry) : undefined,
        onClick: () => {
          if (entry.isFolder) { browser.showView('files'); onNavigate(entry.path); return; }
          if (mode !== 'folder') onToggle?.(entry);
        },
      });
    });
  }

  const hasRows = !browser.loading && !browser.error && shown.length > 0;
  const cols = columns && (hasRows || before) ? [
    { label: t('files.name') },
    { label: t('files.size'), align: 'end' },
    { label: t('files.modified'), align: 'end', hideNarrow: true },
  ] : undefined;
  return h(List, { label: t('browser.location'), columns: cols }, before, body);
}

const GONE = ['not_found', 'encrypted', 'forbidden', 'no_library'];

/**
 * The folder a dialog opens in: the one remembered under `key`, or the
 * list of libraries. `missing(err)` is for useBrowser's onError: a
 * remembered folder that can't be opened any more gives way to the list of
 * libraries instead of an error.
 */
export function useStartPath(api, key) {
  const [path, setPath] = useState('/');
  const restored = useRef(null);
  useEffect(() => {
    api.storage.get(key).then((p) => {
      if (typeof p === 'string' && p && p !== '/') { restored.current = p; setPath(p); }
    }).catch(() => {});
  }, []);
  const navigate = useCallback((p) => { restored.current = null; setPath(p); }, []);
  const missing = useCallback((err) => {
    if (!restored.current || !GONE.includes(err?.code)) return false;
    restored.current = null;
    setPath('/');
    return true;
  }, []);
  return { path, navigate, missing };
}
