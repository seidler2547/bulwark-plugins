// How the plugin names the connected Seafile account. It is whoever was
// signed in on Seafile's page when the user connected, which can be a
// different person than the mail account, so the text names Seafile, the
// name and the address. Seafile's own user ids ("…@auth.local") say nothing
// to a person and are never shown.

import { hostOf } from './format.js';

/** "Alice Example (alice@example.org)", or just one of them when they are the same or one is missing. */
export function accountName(conn) {
  const name = String(conn?.displayName ?? '').trim();
  const id = String(conn?.userId ?? '').trim();
  const login = String(conn?.email ?? '').trim() || (/@auth\.local$/i.test(id) ? '' : id);
  if (name && login && name.toLowerCase() !== login.toLowerCase()) return `${name} (${login})`;
  return name || login;
}

/** "Connected to Seafile at files.example.com as Alice Example (alice@example.org)". */
export function connectedText(t, conn) {
  return t('connect.account', { host: hostOf(conn?.origin), user: accountName(conn) });
}
