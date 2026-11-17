import { test, expect } from '@playwright/test';
import { installPlugin, uninstallPlugin, setPluginConfig, preparePage, signIn, waitForPlugin, shoot } from '../../e2e/helpers.mjs';
import {
  PLUGIN, SF, SF_URL, admin, deleteShares, ensureConnected, findMail, openComposer, openPicker, shareLinks,
} from './sf-helpers.mjs';

// Attach > From Seafile against the Seafile container: attach a real copy
// of a file, and send a share link that Seafile really created.
test.describe.serial('attach from Seafile', () => {
  let api;
  test.beforeAll(async () => {
    test.setTimeout(30 * 60_000);
    api = await admin();
    await installPlugin(api, PLUGIN);
    await setPluginConfig(api, PLUGIN, 'serverUrl', SF_URL);
  });
  test.afterAll(async () => {
    await deleteShares('Photos', '/blue.png').catch(() => {});
    if (api) await uninstallPlugin(api, PLUGIN);
  });

  for (const theme of ['light', 'dark']) {
    test(`attach a copy and send a share link (${theme})`, async ({ page }) => {
      await preparePage(page, { theme });
      await signIn(page);
      await waitForPlugin(page, PLUGIN);
      await ensureConnected(page, theme);
      await deleteShares('Photos', '/blue.png');

      // 1. Attach a copy of Documents/Report 2026.pdf. The picker opens on
      // the libraries, or on the folder used last time.
      await openComposer(page);
      let { dialog, picker } = await openPicker(page, { shot: () => shoot(page, PLUGIN, 'attach-menu', theme) });
      let frame = await picker();
      await frame.getByRole('button', { name: 'Libraries' }).click();
      // The library bob shares says who shares it and that it is read-only.
      await expect(frame.getByRole('listitem').filter({ hasText: 'Team' })).toContainText('Shared by Bob Example · Read-only');
      await frame.getByRole('listitem').filter({ hasText: 'Documents' }).click();
      await frame.getByRole('listitem').filter({ hasText: 'Report 2026.pdf' }).click();
      await expect(frame.getByText(/Selected: 1/)).toBeVisible();
      await shoot(page, PLUGIN, 'picker', theme);
      await dialog.getByRole('button', { name: 'Attach copies' }).click();
      await expect(dialog).toBeHidden({ timeout: 60_000 });
      await expect(page.getByText('Report 2026.pdf').first()).toBeVisible();

      // 2. Search from the list of libraries, pick Photos/blue.png and share it as a link with a password.
      ({ dialog, picker } = await openPicker(page));
      frame = await picker();
      await frame.getByRole('button', { name: 'Libraries' }).click();
      await frame.getByRole('searchbox').fill('blue');
      await frame.getByRole('listitem').filter({ hasText: 'blue.png' }).click();
      await dialog.getByRole('button', { name: 'Share as link…' }).click();
      await frame.getByRole('checkbox', { name: 'Protect the link with a password' }).click();
      await expect(frame.getByLabel('Password', { exact: true })).not.toHaveValue('');
      const password = await frame.getByLabel('Password', { exact: true }).inputValue();
      await shoot(page, PLUGIN, 'share-options', theme);
      await dialog.getByRole('button', { name: 'Add links' }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(page.getByText('Links added to the message: 1')).toBeVisible();

      const links = await shareLinks('Photos', '/blue.png');
      expect(links).toHaveLength(1);
      const link = links[0];
      expect(link.password).toBe(password);
      expect(link.permissions).toMatchObject({ can_download: true, can_edit: false, can_upload: false });
      expect(link.expire_date).toBeTruthy();
      // The links are in the body right away, as real links, where the user can see and edit them.
      const editor = page.locator('.ProseMirror').first();
      await expect(editor).toContainText('Files shared with Seafile');
      await expect(editor.locator(`a[href="${link.link}"]`)).toHaveText('blue.png');
      await expect(editor).not.toContainText(password);
      await shoot(page, PLUGIN, 'links-in-message', theme);

      // 3. Send it to alice herself; the sent message has the attachment and the link.
      const subject = `Seafile e2e ${theme} ${Date.now()}`;
      await page.getByRole('combobox', { name: 'Recipient email addresses' }).fill('alice@example.org');
      await page.getByRole('combobox', { name: 'Recipient email addresses' }).press('Enter');
      await page.getByRole('textbox', { name: 'Subject' }).fill(subject);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const mail = await findMail(subject);
      expect(mail.attachments.map((a) => a.name)).toContain('Report 2026.pdf');
      expect(mail.allText).toContain('Files shared with Seafile');
      expect(mail.allText).toContain(link.link);
      // The password stays out of the message unless the user ticks the box.
      expect(mail.allText).not.toContain(password);
      await deleteShares('Photos', '/blue.png');
    });
  }

  test('favorites list what alice starred in Seafile', async ({ page }) => {
    await preparePage(page, { theme: 'light' });
    await signIn(page);
    await waitForPlugin(page, PLUGIN);
    await ensureConnected(page, 'light');
    await openComposer(page);
    const { dialog, picker } = await openPicker(page);
    const frame = await picker();
    await frame.getByRole('button', { name: 'Favorites' }).click();
    await expect(frame.getByRole('listitem').filter({ hasText: 'Welcome.txt' })).toContainText('Documents');
    await expect(frame.getByRole('listitem').filter({ hasText: 'Bulwark' })).toBeVisible();
    // A favorite has no size until it is picked.
    await frame.getByRole('listitem').filter({ hasText: 'Welcome.txt' }).click();
    await expect(frame.getByText(/Selected: 1 \(\d+ B\)/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(SF.sharedFile).toBe('Documents/Report 2026.pdf');
  });
});
