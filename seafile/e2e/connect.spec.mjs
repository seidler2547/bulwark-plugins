import { test, expect } from '@playwright/test';
import { installPlugin, uninstallPlugin, setPluginConfig, preparePage, signIn, waitForPlugin, shoot } from '../../e2e/helpers.mjs';
import { ACCOUNT, PLUGIN, SF, SF_HOST, SF_URL, admin, connectThroughSignIn, forgetAccount, openSettings, pluginFrame, sfFetch } from './sf-helpers.mjs';

// Connect through Seafile's own sign-in page against the Seafile container,
// switch to another sign-in, then disconnect.
test.describe.serial('connect', () => {
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

  /** The clients Seafile lists for alice under "Linked devices". */
  async function linkedDevices() {
    return (await (await sfFetch('/api2/devices/')).json()).map((d) => d.device_name);
  }

  for (const theme of ['light', 'dark']) {
    test(`connect and disconnect Seafile from Settings (${theme})`, async ({ page }) => {
      await preparePage(page, { theme });
      await signIn(page);
      await waitForPlugin(page, PLUGIN);
      await forgetAccount(page);

      const frame = await openSettings(page, theme);
      await expect(frame.getByRole('button', { name: 'Connect Seafile' })).toBeVisible();
      await expect(frame.getByText(`Server: ${SF_HOST}`)).toBeVisible();
      // The other way in, for servers without the sign-in through the browser.
      await expect(frame.getByRole('button', { name: 'Connect with an API token' })).toBeVisible();
      await shoot(page, PLUGIN, 'settings-disconnected', theme);

      await connectThroughSignIn(page, frame);
      // The name and address come from Seafile's account API, called with
      // the captured token. It is named as the Seafile account, so it can't
      // be taken for the mail account.
      const connected = frame.getByText(`Connected to Seafile at ${SF_HOST} as ${ACCOUNT}.`);
      await expect(connected).toBeVisible({ timeout: 30_000 });
      await expect(frame.getByText(/not necessarily your mail account/)).toBeVisible();
      await shoot(page, PLUGIN, 'settings-connected', theme);
      // Seafile gave the webmail a token of its own and lists it.
      expect(await linkedDevices()).toContain('Bulwark Mail');
      // The plugin never got the token: the browser only knows that an account is connected.
      const accounts = await page.evaluate(async () => (await (await fetch('/api/plugin-secrets?plugin=seafile')).json()).credentials);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ origin: SF_URL, username: SF.userId, connected: true });
      expect(JSON.stringify(accounts)).not.toMatch(/[0-9a-f]{40}/);

      // "Use another Seafile account" disconnects and signs in again.
      await connectThroughSignIn(page, frame, 'Use another Seafile account');
      await expect(connected).toBeVisible({ timeout: 30_000 });

      await frame.getByRole('button', { name: 'Disconnect' }).click();
      await expect(frame.getByRole('button', { name: 'Connect Seafile' })).toBeVisible();
      expect(await page.evaluate(async () => (await (await fetch('/api/plugin-secrets?plugin=seafile')).json()).credentials)).toEqual([]);
      // Disconnecting unlinked the webmail in Seafile, which ends its token.
      expect(await linkedDevices()).not.toContain('Bulwark Mail');

      // Without an account the Seafile page says so in the middle and offers to connect.
      await page.getByRole('button', { name: 'Back to Mail' }).click();
      await page.getByRole('link', { name: 'Seafile' }).click();
      await expect(page).toHaveURL(/\/apps\/seafile\/files/);
      // The settings frame says the same thing in a row; the page's empty state is the only h3 with it.
      const pageFrame = await pluginFrame(page, "h3:has-text(\"Seafile isn't connected\")");
      await expect(pageFrame.getByRole('button', { name: 'Connect Seafile' })).toBeVisible();
      await shoot(page, PLUGIN, 'files-page-disconnected', theme);
    });
  }

  test('opening the sign-in page again takes a new link, and Cancel stops waiting', async ({ page }) => {
    await preparePage(page, { theme: 'light' });
    await signIn(page);
    await waitForPlugin(page, PLUGIN);
    await forgetAccount(page);
    const frame = await openSettings(page, 'light');

    const first = page.context().waitForEvent('page', { timeout: 30_000 });
    await frame.getByRole('button', { name: 'Connect Seafile' }).click();
    await page.getByRole('dialog').filter({ hasText: 'Seafile' }).getByRole('button', { name: /continue/i }).click();
    const popup1 = await first;
    await expect(frame.getByText('Waiting for Seafile…')).toBeVisible();

    // Seafile's link works once, so the plugin asks for another one.
    const second = page.context().waitForEvent('page', { timeout: 30_000 });
    await frame.getByRole('button', { name: 'Open the sign-in page again' }).click();
    const popup2 = await second;
    expect(new URL(popup2.url()).pathname).not.toBe(new URL(popup1.url()).pathname);
    await popup1.close();
    await popup2.close();

    await frame.getByRole('button', { name: 'Cancel' }).click();
    await expect(frame.getByRole('button', { name: 'Connect Seafile' })).toBeVisible();
  });
});
