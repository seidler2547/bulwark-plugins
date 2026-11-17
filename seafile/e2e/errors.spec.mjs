import { test, expect } from '@playwright/test';
import { installPlugin, uninstallPlugin, setPluginConfig, preparePage, signIn, waitForPlugin, shoot } from '../../e2e/helpers.mjs';
import { PLUGIN, SF, SF_URL, admin, confirmInSeafile, ensureConnected, openComposer, openPicker, pluginFrame } from './sf-helpers.mjs';

// A token that stopped working (unlinked in Seafile, deleted by an admin):
// Seafile answers 401, and the plugin says so in plain words and offers to
// sign in again.
test.describe.serial('errors', () => {
  let api;
  test.beforeAll(async () => {
    test.setTimeout(30 * 60_000);
    api = await admin();
    await installPlugin(api, PLUGIN);
    await setPluginConfig(api, PLUGIN, 'serverUrl', SF_URL);
  });
  test.afterAll(async () => {
    if (api) await uninstallPlugin(api, PLUGIN);
  });

  test('a token that stopped working leads to "Sign in again"', async ({ page }) => {
    test.setTimeout(6 * 60_000);
    await preparePage(page, { theme: 'light' });
    await signIn(page);
    await waitForPlugin(page, PLUGIN);
    await ensureConnected(page, 'light');

    // Replace the stored token with one Seafile doesn't know, as if the webmail was unlinked there.
    const status = await page.evaluate(async ({ origin, username }) => (await fetch('/api/plugin-secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pluginId: 'seafile', credentialId: 'seafile', label: 'Seafile', origin, username,
        inject: { type: 'header', name: 'Authorization', prefix: 'Token ' }, secret: '0000000000000000000000000000000000000000',
      }),
    })).status, { origin: SF_URL, username: SF.userId });
    expect(status).toBeLessThan(300);

    await openComposer(page);
    const { dialog } = await openPicker(page);
    const frame = await pluginFrame(page, 'text=Your Seafile sign-in has expired or was revoked. Sign in again.');
    await expect(dialog.getByRole('button', { name: 'Sign in again' })).toBeVisible();
    await shoot(page, PLUGIN, 'expired', 'light');

    // Signing in again from right there fixes it: the picker shows the libraries.
    const popupPromise = page.context().waitForEvent('page');
    await dialog.getByRole('button', { name: 'Sign in again' }).click();
    const host = page.getByRole('dialog').filter({ hasText: 'Connect Seafile' });
    await host.getByRole('button', { name: /continue/i }).click();
    const popup = await popupPromise;
    await confirmInSeafile(popup);
    await expect(frame.getByText('Choose one or more files.')).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByRole('listitem').filter({ hasText: 'Documents' })).toBeVisible();
  });
});
