// Shared steps for the Seafile plugin's end-to-end tests. They run against
// the Seafile container from test-env (user alice), which test-env's seed
// sets up with the browser sign-in for clients turned on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { BASE, REPO, adminApi, waitForPlugin } from '../../e2e/helpers.mjs';

export const PLUGIN = 'seafile';
export const SF_URL = process.env.SEAFILE_URL || 'http://localhost:18090';
export const SF_HOST = new URL(SF_URL).host;
/** How the plugin names the seeded account. */
export const ACCOUNT = 'Alice Example (alice@example.org)';
/** Where specs put the files they make. */
export const SCRATCH = process.env.SEAFILE_E2E_SCRATCH || path.join(os.tmpdir(), 'bulwark-e2e-seafile');

function secretsFile() {
  const candidates = [process.env.SEAFILE_SECRETS, path.join(REPO, 'test-env', '.secrets', 'seafile.json')].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('test-env/.secrets/seafile.json not found; run test-env/up');
  return JSON.parse(fs.readFileSync(found, 'utf8'));
}

export const SF = secretsFile();

/** A request to Seafile's Web API as alice with the seeded token, to check results. */
export async function sfFetch(urlPath, init = {}) {
  return fetch(`${SF_URL}${urlPath}`, {
    ...init,
    headers: { Authorization: `Token ${SF.token}`, Accept: 'application/json', ...(init.headers ?? {}) },
  });
}

/** The id of one of alice's own libraries, or null. */
export async function libraryId(name) {
  const data = await (await sfFetch('/api/v2.1/repos/?type=mine')).json();
  return data.repos.find((r) => r.repo_name === name)?.repo_id ?? null;
}

/** The entries of a folder as { name, type, size }, or null when it isn't there. */
export async function listFolder(library, folder = '/') {
  const id = await libraryId(library);
  if (!id) return null;
  const res = await sfFetch(`/api/v2.1/repos/${id}/dir/?p=${encodeURIComponent(folder)}`);
  if (!res.ok) return null;
  return (await res.json()).dirent_list.map((d) => ({ name: d.name, type: d.type, size: d.size ?? 0 }));
}

/** Delete a file or folder (cleanup). */
export async function removePath(library, target, { folder = false } = {}) {
  const id = await libraryId(library);
  if (!id) return;
  await sfFetch(`/api/v2.1/repos/${id}/${folder ? 'dir' : 'file'}/?p=${encodeURIComponent(target)}`, { method: 'DELETE' });
}

/** Delete a whole library of alice's by name (cleanup). */
export async function removeLibrary(name) {
  const id = await libraryId(name);
  if (id) await sfFetch(`/api2/repos/${id}/`, { method: 'DELETE' });
}

/** Alice's share links for a file. */
export async function shareLinks(library, file) {
  const id = await libraryId(library);
  if (!id) return [];
  const res = await sfFetch(`/api/v2.1/share-links/?repo_id=${id}&path=${encodeURIComponent(file)}`);
  return res.ok ? res.json() : [];
}

/** Delete the share links a spec made for a file, keeping the seeded one. */
export async function deleteShares(library, file) {
  const links = await shareLinks(library, file);
  for (const link of links) {
    if (link.link === SF.shareLink) continue;
    await sfFetch(`/api/v2.1/share-links/${link.token}/`, { method: 'DELETE' });
  }
  return links;
}

/** Open the plugin's page in Settings and return its frame. */
export async function openSettings(page, theme) {
  await waitForPlugin(page, PLUGIN);
  // A client-side navigation keeps the running plugins.
  await page.getByRole('link', { name: 'Settings' }).click();
  if (theme) {
    // The theme syncs through the server, so another run (or another
    // plugin's test as alice) may have changed it: pick it here.
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Seafile', exact: true }).click();
  return pluginFrame(page, 'text=Seafile account');
}

/** Forget the plugin's stored Seafile account for the signed-in user. */
export async function forgetAccount(page) {
  await page.evaluate(async () => {
    await fetch('/api/plugin-secrets?plugin=seafile', { method: 'DELETE' });
  });
}

/** The plugin frame that shows `selector`, waiting for it to appear. */
export async function pluginFrame(page, selector, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const frame of page.frames()) {
      try {
        if (frame !== page.mainFrame() && await frame.locator(selector).count() > 0) return frame;
      } catch { /* detached */ }
    }
    if (Date.now() > deadline) throw new Error(`No plugin frame shows ${selector}`);
    await page.waitForTimeout(250);
  }
}

/** Approve the host's "Connect Seafile" dialog, then sign in and confirm on Seafile's page in the popup. */
export async function connectThroughSignIn(page, frame, buttonName = 'Connect Seafile') {
  const popupPromise = page.context().waitForEvent('page', { timeout: 30_000 });
  await frame.getByRole('button', { name: buttonName }).click();
  // The host's own dialog: the server is fixed by the admin, so it only asks to continue.
  const dialog = page.getByRole('dialog').filter({ hasText: 'Seafile' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /continue/i }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await confirmInSeafile(popup);
  return popup;
}

/**
 * Seafile's pages for a client's sign-in: the login form (skipped with a
 * Seafile session from an earlier sign-in in this browser), then "Do you
 * want to login to your client?".
 */
export async function confirmInSeafile(popup) {
  const login = popup.locator('input[name="login"]');
  const yes = popup.getByRole('button', { name: 'Yes', exact: true });
  await expect(login.or(yes)).toBeVisible({ timeout: 30_000 });
  if (await login.isVisible()) {
    await login.fill(SF.user);
    await popup.locator('input[name="password"]').fill(SF.password);
    await popup.getByRole('button', { name: 'Log In' }).click();
  }
  await yes.click({ timeout: 30_000 });
  await expect(popup.getByText(/The client has logged in/)).toBeVisible({ timeout: 30_000 });
  await popup.close();
}

export { BASE };

/** An admin API client; e2e/helpers keeps its session between runs and waits out the sign-in limit. */
export const admin = adminApi;

/** Connect Seafile through Settings if it isn't yet, then go back to mail. */
export async function ensureConnected(page, theme) {
  const frame = await openSettings(page, theme);
  const connect = frame.getByRole('button', { name: 'Connect Seafile' });
  const again = frame.getByRole('button', { name: 'Sign in again' });
  const connected = frame.getByText(new RegExp(`Connected to Seafile at ${SF_HOST.replace(/\./g, '\\.')}`));
  await expect(connect.or(again).or(connected)).toBeVisible({ timeout: 30_000 });
  if (!(await connected.isVisible())) {
    await connectThroughSignIn(page, frame, (await again.isVisible()) ? 'Sign in again' : 'Connect Seafile');
    await expect(connected).toBeVisible({ timeout: 30_000 });
  }
  await page.getByRole('button', { name: 'Back to Mail' }).click();
}

const JMAP = process.env.STALWART_URL || 'http://localhost:18025';
const MAIL_AUTH = `Basic ${Buffer.from('alice@example.org:test-pass-123').toString('base64')}`;

/** A message alice has, by exact subject, with its text and HTML body (Stalwart JMAP). */
export async function findMail(subject, { timeout = 30_000 } = {}) {
  const session = await (await fetch(`${JMAP}/.well-known/jmap`, { headers: { Authorization: MAIL_AUTH } })).json();
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  const deadline = Date.now() + timeout;
  for (;;) {
    const res = await fetch(session.apiUrl.replace(/^https?:\/\/[^/]+/, JMAP), {
      method: 'POST',
      headers: { Authorization: MAIL_AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [
          ['Email/query', { accountId, filter: { operator: 'AND', conditions: [{ subject }, { notKeyword: '$draft' }] } }, 'q'],
          ['Email/get', { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'textBody', 'htmlBody', 'bodyValues', 'attachments', 'mailboxIds'], fetchAllBodyValues: true }, 'g'],
        ],
      }),
    });
    const data = await res.json();
    const list = data.methodResponses?.[1]?.[1]?.list ?? [];
    const found = list.find((m) => m.subject === subject);
    if (found) {
      const text = Object.values(found.bodyValues ?? {}).map((v) => v.value).join('\n');
      return { ...found, allText: text, accountId };
    }
    if (Date.now() > deadline) throw new Error(`No message with subject ${subject}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Open a new message. */
export async function openComposer(page) {
  await page.getByRole('button', { name: 'Compose' }).first().click();
  await expect(page.getByTestId('composer-attach-menu')).toBeVisible();
}

/** Attach > From Seafile in the open composer: the host dialog and the picker's frame. */
export async function openPicker(page, { shot } = {}) {
  await page.getByTestId('composer-attach-menu').click();
  const entry = page.getByRole('menuitem', { name: 'From Seafile' });
  await expect(entry).toBeVisible();
  if (shot) await shot();
  await entry.click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Attach from Seafile' });
  await expect(dialog).toBeVisible();
  return { dialog, picker: () => pluginFrame(page, 'text=Choose one or more files.') };
}

/** The host's prompt for a new folder's or library's name. */
export async function nameNew(page, name, label = 'Folder name') {
  const prompt = page.getByRole('dialog').filter({ hasText: label });
  await expect(prompt).toBeVisible();
  await prompt.getByLabel(label).fill(name);
  await prompt.getByRole('button', { name: 'Create' }).click();
  await expect(prompt).toBeHidden();
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
