import { test, expect } from '@playwright/test';
import { installPlugin, uninstallPlugin, setPluginConfig, preparePage, signIn, waitForPlugin, shoot } from '../../e2e/helpers.mjs';
import { PLUGIN, SF_URL, admin, ensureConnected, listFolder, nameNew, pluginFrame, removePath } from './sf-helpers.mjs';

// "Save to Seafile" on a seeded attachment and on the whole message.
test.describe.serial('save to Seafile', () => {
  let api;
  const folder = `E2E save ${Date.now()}`;
  test.beforeAll(async () => {
    test.setTimeout(30 * 60_000);
    api = await admin();
    await installPlugin(api, PLUGIN);
    await setPluginConfig(api, PLUGIN, 'serverUrl', SF_URL);
  });
  test.afterAll(async () => {
    await removePath('Documents', `/${folder}`, { folder: true }).catch(() => {});
    if (api) await uninstallPlugin(api, PLUGIN);
  });

  const saved = async () => (await listFolder('Documents', `/${folder}`) ?? []).map((e) => e.name);

  for (const theme of ['light', 'dark']) {
    test(`save an attachment and the message (${theme})`, async ({ page }) => {
      await preparePage(page, { theme });
      await signIn(page);
      await waitForPlugin(page, PLUGIN);
      await ensureConnected(page, theme);

      // Other tests fill the inbox; search for the seeded invoice from Bob.
      await page.getByRole('combobox', { name: /Search mail/ }).fill('Invoice 2026-10 attached');
      await page.getByRole('combobox', { name: /Search mail/ }).press('Enter');
      await page.getByText('Invoice 2026-10 attached').first().click({ position: { x: 5, y: 5 } });
      // The attachment chip's size label overlaps its menu button in the current host build, so the click is dispatched.
      await page.locator('[data-attachment-plugin-menu]').first().dispatchEvent('click');
      await page.getByRole('menuitem', { name: 'Save to Seafile' }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: /Save .* to Seafile/ });
      await expect(dialog).toBeVisible();
      const frame = await pluginFrame(page, 'text=/Choose a folder for invoice/');
      if (theme === 'light') {
        // Nothing is saved next to the libraries: a library has to be open first.
        await frame.getByRole('button', { name: 'Libraries' }).click();
        await expect(dialog.getByRole('button', { name: 'Save here' })).toBeDisabled();
        await expect(frame.getByText('Open a library first.')).toBeVisible();
        await frame.getByRole('listitem').filter({ hasText: 'Documents' }).click();
        await frame.getByRole('button', { name: 'New folder' }).click();
        await nameNew(page, folder);
      } else {
        await frame.getByRole('button', { name: 'Libraries' }).click();
        await frame.getByRole('listitem').filter({ hasText: 'Documents' }).click();
        await frame.getByRole('listitem').filter({ hasText: folder }).click();
      }
      await expect(frame.getByRole('button', { name: folder, exact: true })).toHaveAttribute('aria-current', 'page');
      await shoot(page, PLUGIN, 'save-folder', theme);
      await dialog.getByRole('button', { name: 'Save here' }).click();
      await expect(dialog).toBeHidden({ timeout: 60_000 });
      // The toast names the library, not its id.
      await expect(page.getByText(`Saved to Seafile: Documents/${folder}/invoice-2026-10`)).toBeVisible();
      expect((await saved()).some((n) => /^invoice-2026-10.*\.pdf$/.test(n))).toBe(true);

      // The whole message as .eml, from the reader toolbar (or its More menu).
      const direct = page.getByRole('button', { name: 'Save message to Seafile' });
      if (await direct.count()) await direct.first().click();
      else {
        await page.getByRole('button', { name: /more/i }).first().click();
        await page.getByRole('menuitem', { name: 'Save message to Seafile' }).click();
      }
      const frame2 = await pluginFrame(page, 'text=/Choose a folder for .*\\.eml/');
      await expect(frame2.getByText(/Choose a folder for .*\.eml/)).toBeVisible();
      // The last folder is remembered.
      await expect(frame2.getByRole('button', { name: folder, exact: true })).toHaveAttribute('aria-current', 'page');
      await page.getByRole('dialog').filter({ hasText: 'Save the message to Seafile' }).getByRole('button', { name: 'Save here' }).click();
      await expect(page.getByText(/Saved to Seafile: .*\.eml/)).toBeVisible({ timeout: 60_000 });
      expect((await saved()).some((n) => /^Invoice 2026-10 attached.*\.eml$/.test(n))).toBe(true);
    });
  }

  test('a library that is shared read-only takes no file', async ({ page }) => {
    await preparePage(page, { theme: 'light' });
    await signIn(page);
    await waitForPlugin(page, PLUGIN);
    await ensureConnected(page, 'light');
    await page.getByRole('combobox', { name: /Search mail/ }).fill('Invoice 2026-10 attached');
    await page.getByRole('combobox', { name: /Search mail/ }).press('Enter');
    await page.getByText('Invoice 2026-10 attached').first().click({ position: { x: 5, y: 5 } });
    await page.locator('[data-attachment-plugin-menu]').first().dispatchEvent('click');
    await page.getByRole('menuitem', { name: 'Save to Seafile' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: /Save .* to Seafile/ });
    const frame = await pluginFrame(page, 'text=/Choose a folder for invoice/');
    await frame.getByRole('button', { name: 'Libraries' }).click();
    await frame.getByRole('listitem').filter({ hasText: 'Team' }).click();
    await expect(frame.getByRole('listitem').filter({ hasText: 'handbook.txt' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save here' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });
});
