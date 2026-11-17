import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import { installPlugin, uninstallPlugin, setPluginConfig, preparePage, signIn, waitForPlugin, shoot } from '../../e2e/helpers.mjs';
import {
  ACCOUNT, PLUGIN, SCRATCH, SF_HOST, SF_URL, admin, deleteShares, ensureConnected, listFolder, nameNew, pluginFrame,
  removeLibrary, shareLinks,
} from './sf-helpers.mjs';

// The Seafile page: a new library, upload (paused and resumed), share,
// download (a streamed 30 MB file) and attach to a new message.
const MB = 1024 * 1024;

test.describe.serial('Seafile page', () => {
  let api;
  const library = `E2E page ${Date.now()}`;
  const name = 'page-upload.bin';
  const file = path.join(SCRATCH, name);
  test.beforeAll(async () => {
    test.setTimeout(30 * 60_000);
    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(30 * MB));
    api = await admin();
    await installPlugin(api, PLUGIN);
    await setPluginConfig(api, PLUGIN, 'serverUrl', SF_URL);
  });
  test.afterAll(async () => {
    fs.rmSync(file, { force: true });
    await deleteShares(library, `/${name}`).catch(() => {});
    await removeLibrary(library).catch(() => {});
    if (api) await uninstallPlugin(api, PLUGIN);
  });

  async function openPage(page, theme) {
    await preparePage(page, { theme });
    await signIn(page);
    await waitForPlugin(page, PLUGIN);
    await ensureConnected(page, theme);
    await page.getByRole('link', { name: 'Seafile' }).click();
    await expect(page).toHaveURL(/\/apps\/seafile\/files/);
    return pluginFrame(page, 'button:has-text("Upload")');
  }

  test('new library, upload, share, download and attach (light)', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const frame = await openPage(page, 'light');
    // The page opens on the libraries: nothing is uploaded next to them.
    await expect(frame.getByRole('listitem').filter({ hasText: 'Documents' })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Upload' })).toBeDisabled();
    await frame.getByRole('button', { name: 'New library' }).click();
    await nameNew(page, library, 'Library name');
    await expect(frame.getByRole('button', { name: library, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(frame.getByRole('button', { name: 'Upload' }).first()).toBeEnabled();

    await frame.locator('[data-testid="sf-upload-input"]').setInputFiles(file);
    const upload = frame.getByRole('listitem').filter({ hasText: name });
    await upload.getByRole('button', { name: 'Cancel' }).click();
    await expect(upload.getByText('Paused', { exact: true })).toBeVisible();
    await upload.getByRole('button', { name: 'Resume' }).click();
    await expect(upload.getByText('Uploaded', { exact: true })).toBeVisible({ timeout: 5 * 60_000 });
    expect(await listFolder(library)).toEqual([{ name, type: 'file', size: 30 * MB }]);
    // Done uploads can be dismissed; the file stays in the list.
    await upload.filter({ hasText: 'Uploaded' }).getByRole('button', { name: 'Remove' }).click();
    await expect(frame.getByText('Uploaded', { exact: true })).toBeHidden();

    await frame.getByRole('listitem').filter({ hasText: name }).click();
    await frame.getByRole('button', { name: 'Share link' }).click();
    const shareDialog = page.getByRole('dialog').filter({ hasText: `Share ${name}` });
    await expect(shareDialog).toBeVisible();
    await shareDialog.getByRole('button', { name: 'Create link' }).click();
    const shareFrame = await pluginFrame(page, 'text=The link is ready. Copy it from here:');
    const link = shareFrame.getByRole('textbox', { name: 'Share link' });
    await expect(link).toHaveValue(/\/f\/[0-9a-f]+\/$/);
    expect((await shareLinks(library, `/${name}`)).map((s) => s.link)).toContain(await link.inputValue());
    await shoot(page, PLUGIN, 'share-link', 'light');
    await shareDialog.locator('[data-plugin-dialog-buttons]').getByRole('button', { name: 'Close' }).click();
    await expect(shareDialog).toBeHidden();
    await shoot(page, PLUGIN, 'files-page', 'light');

    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await frame.getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(name);
    const saved = path.join(SCRATCH, `downloaded-${name}`);
    await download.saveAs(saved);
    expect(fs.statSync(saved).size).toBe(30 * MB);
    expect(crypto.createHash('sha256').update(fs.readFileSync(saved)).digest('hex'))
      .toBe(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    fs.rmSync(saved, { force: true });

    await frame.getByRole('button', { name: 'Attach to new message' }).click();
    await expect(page.getByRole('heading', { name: 'New Message' })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Discard' }).click();
  });

  test('the page in dark mode and on a phone', async ({ page }) => {
    const frame = await openPage(page, 'dark');
    // A library alice may only read takes no uploads.
    await frame.getByRole('listitem').filter({ hasText: 'Team' }).click();
    await expect(frame.getByRole('listitem').filter({ hasText: 'handbook.txt' })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Upload' })).toBeDisabled();
    await frame.getByRole('button', { name: 'Libraries' }).click();

    await frame.getByRole('listitem').filter({ hasText: 'Documents' }).click();
    await frame.getByRole('listitem').filter({ hasText: 'Report 2026.pdf' }).click();
    await expect(frame.getByRole('button', { name: 'Attach to new message' })).toBeVisible();
    await shoot(page, PLUGIN, 'files-page', 'dark');

    // The account button names the Seafile account, with a way to use another one.
    await frame.getByRole('button', { name: 'Clear selection' }).click();
    await frame.getByRole('button', { name: ACCOUNT }).click();
    const account = page.getByRole('dialog').filter({ hasText: 'Seafile account' });
    await expect(account.getByRole('button', { name: 'Use another Seafile account' })).toBeVisible();
    const accountFrame = await pluginFrame(page, `text=Connected to Seafile at ${SF_HOST} as ${ACCOUNT}.`);
    await expect(accountFrame.getByText(/not necessarily your mail account/)).toBeVisible();
    await shoot(page, PLUGIN, 'account', 'dark');
    await account.locator('[data-plugin-dialog-buttons]').getByRole('button', { name: 'Close' }).click();
    await expect(account).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(frame.getByRole('button', { name: 'Upload' })).toBeVisible();
    await shoot(page, PLUGIN, 'files-page-phone', 'dark');
  });
});
