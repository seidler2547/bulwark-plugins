// The connection state and what the user sees about it, shared by every slot.

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, EmptyState, Loading, Row, Section, SettingRow, Spinner,
} from '@plugin-host/ui';
import {
  adminServer, approveServer, connectWithToken, disconnect, getConnection, pollSignIn, startSignIn,
} from '../lib/connection.js';
import { SfError, errorText, needsSignIn } from '../lib/errors.js';
import { hostOf } from '../lib/format.js';
import { connectedText } from '../lib/account.js';

/**
 * status: loading | disconnected | approving | waiting | connected | expired | error
 */
export function useConnection(api) {
  const [state, setState] = useState({ status: 'loading' });
  const flowRef = useRef(null);
  const mounted = useRef(true);

  const set = (next) => { if (mounted.current) setState(next); };

  const refresh = useCallback(async () => {
    let fixed = null;
    try {
      fixed = await adminServer(api);
      const conn = await getConnection(api, { fixedServer: fixed });
      set(conn ? { status: 'connected', conn, fixed } : { status: 'disconnected', fixed });
      return conn;
    } catch (err) {
      if (err instanceof SfError && err.code === 'wrong_server') set({ status: 'disconnected', fixed, error: err });
      else if (needsSignIn(err)) set({ status: 'expired', fixed, error: err });
      else set({ status: 'error', fixed, error: err });
      return null;
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      flowRef.current?.abort();
    };
  }, [refresh]);

  /**
   * Sign in through the browser. `origin` skips the host's dialog for a
   * server the user already approved there (opening the page again).
   */
  const connect = useCallback(async ({ suggestedServer, origin: approved } = {}) => {
    const fixed = await adminServer(api);
    const controller = new AbortController();
    flowRef.current?.abort();
    flowRef.current = controller;
    let origin = approved ?? null;
    try {
      if (!origin) {
        set({ status: 'approving', fixed });
        origin = await approveServer(api, { fixedServer: fixed, suggestedServer: suggestedServer ?? state.conn?.origin ?? state.origin });
        if (!origin) { await refresh(); return null; }
      }
      const flow = await startSignIn(api, origin);
      if (controller.signal.aborted) throw new SfError('cancelled');
      set({ status: 'waiting', fixed, origin, loginUrl: flow.loginUrl });
      // A blocked pop-up is no reason to stop: the page can be opened again.
      await Promise.resolve().then(() => api.ui.openExternalUrl(flow.loginUrl)).catch(() => {});
      await pollSignIn(api, origin, flow, { signal: controller.signal });
      const conn = await refresh();
      if (conn) api.toast.success(api.i18n.t('connect.done', { host: hostOf(conn.origin) }));
      return conn;
    } catch (err) {
      // Another attempt took over (the page was opened again, or a token is
      // being entered): it shows its own state.
      if (flowRef.current !== controller) return null;
      if (err instanceof SfError && err.code === 'cancelled') { await refresh(); return null; }
      set({ status: 'error', fixed, origin, error: err });
      return null;
    } finally {
      if (flowRef.current === controller) flowRef.current = null;
    }
  }, [api, refresh, state.conn, state.origin]);

  /**
   * Seafile's sign-in link works once, so opening the page again starts
   * over with a new link.
   */
  const reopen = useCallback(() => connect({ origin: state.origin }), [connect, state.origin]);

  /** Connect with a token typed into the host's dialog, for servers without the browser sign-in. */
  const connectToken = useCallback(async () => {
    const fixed = await adminServer(api);
    const controller = new AbortController();
    flowRef.current?.abort();
    flowRef.current = controller;
    const suggestedServer = state.origin ?? state.conn?.origin;
    set({ status: 'approving', fixed, origin: state.origin });
    try {
      const conn = await connectWithToken(api, { fixedServer: fixed, suggestedServer });
      if (flowRef.current !== controller) return null;
      if (!conn) { await refresh(); return null; }
      set({ status: 'connected', conn, fixed });
      api.toast.success(api.i18n.t('connect.done', { host: hostOf(conn.origin) }));
      return conn;
    } catch (err) {
      if (flowRef.current === controller) set({ status: 'error', fixed, origin: state.origin, error: err });
      return null;
    } finally {
      if (flowRef.current === controller) flowRef.current = null;
    }
  }, [api, refresh, state.conn, state.origin]);

  const cancel = useCallback(() => { flowRef.current?.abort(); }, []);

  const signOut = useCallback(async () => {
    try {
      await disconnect(api);
    } catch (err) {
      api.toast.error(errorText(api.i18n.t, err));
    }
    await refresh();
  }, [api, refresh]);

  /** Disconnect this account and sign in again, so another Seafile account can be chosen. */
  const switchAccount = useCallback(async () => {
    const origin = state.conn?.origin;
    try {
      await disconnect(api);
    } catch (err) {
      api.toast.error(errorText(api.i18n.t, err));
      return null;
    }
    return connect({ suggestedServer: origin });
  }, [api, connect, state.conn]);

  /** Call with any error from a Seafile request: switches to "expired" when the token stopped working. */
  const report = useCallback((err) => {
    if (needsSignIn(err)) set({ status: 'expired', fixed: state.fixed, error: err });
  }, [state.fixed]);

  return { ...state, refresh, connect, reopen, connectToken, cancel, signOut, switchAccount, report };
}

/** Whether the server said it has no sign-in through the browser: only a token connects then. */
export function tokenOnly(c) {
  return c.status === 'error' && c.error?.code === 'no_browser_signin';
}

/** Title and text for a connection that isn't usable (yet). */
export function connectionMessage(t, c) {
  const fixedHost = c.fixed ? hostOf(c.fixed) : '';
  if (c.status === 'loading') return { icon: 'cloud', title: t('connect.checking') };
  if (c.status === 'approving') return { icon: 'cloud', title: t('connect.approving') };
  if (c.status === 'waiting') return { icon: 'external-link', title: t('composer.waiting'), text: t('connect.waiting', { host: hostOf(c.origin) }) };
  if (c.status === 'expired') return { icon: 'lock', title: t('connect.expiredTitle'), text: t('connect.expired') };
  if (tokenOnly(c)) return { icon: 'key', title: t('connect.title'), text: `${errorText(t, c.error)} ${t('connect.tokenInstead')} ${t('connect.tokenHint')}` };
  if (c.status === 'error') return { icon: 'alert-triangle', title: t('error.unknown'), text: errorText(t, c.error) };
  const intro = c.error?.code === 'wrong_server' ? t('error.wrong_server_host', { host: fixedHost }) : t('connect.intro');
  return { icon: 'cloud', title: t('connect.title'), text: fixedHost ? `${intro} ${t('connect.server', { host: fixedHost })}` : intro };
}

/** The main button for a connection that isn't usable, or null. */
export function connectLabel(t, c) {
  if (tokenOnly(c)) return t('connect.token');
  if (c.status === 'disconnected' || c.status === 'error') return t('connect.button');
  if (c.status === 'expired') return t('connect.again');
  return null;
}

/** What the main button does. */
export function runConnect(c) {
  return tokenOnly(c) ? c.connectToken() : c.connect();
}

/**
 * The not-connected states as the Files app's empty state, for the page
 * and dialog bodies. With `actions: false` the buttons go elsewhere (a
 * dialog's footer).
 */
export function ConnectionEmpty({ api, connection, actions = true, compact = false }) {
  const t = api.i18n.t;
  const c = connection;
  if (c.status === 'loading') return h(Loading, { label: t('connect.checking') });
  const m = connectionMessage(t, c);
  let buttons = null;
  if (actions && c.status === 'waiting') {
    buttons = [
      h(Button, { key: 'reopen', variant: 'secondary', icon: 'external-link', onClick: () => void c.reopen() }, t('connect.reopen')),
      h(Button, { key: 'cancel', variant: 'ghost', onClick: c.cancel }, t('common.cancel')),
    ];
  } else if (actions && connectLabel(t, c)) {
    buttons = h(Button, { icon: tokenOnly(c) ? 'key' : 'cloud', onClick: () => void runConnect(c) }, connectLabel(t, c));
  }
  return h(EmptyState, { icon: m.icon, title: m.title, description: m.text, actions: buttons, compact });
}

/** The account as Settings shows it: Section and SettingRows, like the app's settings. */
export function ConnectionSettings({ api, connection }) {
  const t = api.i18n.t;
  const c = connection;
  let row;
  let token = null;
  if (c.status === 'connected') {
    row = h(SettingRow, { label: connectedText(t, c.conn), description: t('connect.accountHint') },
      h(Row, { gap: 2 },
        h(Button, { variant: 'secondary', onClick: () => void c.switchAccount() }, t('connect.switch')),
        h(Button, { variant: 'secondary', onClick: () => void c.signOut() }, t('connect.disconnect'))));
  } else if (c.status === 'loading' || c.status === 'approving') {
    row = h(SettingRow, { label: connectionMessage(t, c).title }, h(Spinner, {}));
  } else if (c.status === 'waiting') {
    const m = connectionMessage(t, c);
    row = h(SettingRow, { label: m.title, description: m.text },
      h(Row, { gap: 2 },
        h(Button, { variant: 'secondary', onClick: () => void c.reopen() }, t('connect.reopen')),
        h(Button, { variant: 'ghost', onClick: c.cancel }, t('common.cancel'))));
  } else {
    const m = connectionMessage(t, c);
    row = h(SettingRow, { label: m.title, description: m.text },
      h(Button, { onClick: () => void runConnect(c) }, connectLabel(t, c)));
    // Sign-in through the browser is the way in; the token is for servers without it.
    if (!tokenOnly(c)) {
      token = h(SettingRow, { label: t('connect.token'), description: t('connect.tokenHint') },
        h(Button, { variant: 'secondary', onClick: () => void c.connectToken() }, t('connect.token')));
    }
  }
  return h(Section, { title: t('settings.title'), description: t('settings.privacy') }, row, token);
}
