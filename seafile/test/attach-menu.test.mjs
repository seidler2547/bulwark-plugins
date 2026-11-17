// @vitest-environment jsdom
// "From Seafile" in the composer's Attach menu: the click's composerId goes
// to the picker dialog, and the picker attaches to that composer.
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { fakeSeafile, seafileApi, ORIGIN } from './fake-seafile.mjs';
import { createClient } from '../src/lib/client.js';
import { onAction, registerActions, slots } from '../src/index.js';
import { PickerDialog } from '../src/ui/picker-dialog.js';
import manifest from '../manifest.json' with { type: 'json' };

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const h = React.createElement;

/** A Seafile with a few files, and an api whose openDialog renders the picker like the host does. */
function setup({ attach = async () => true } = {}) {
  const sf = fakeSeafile();
  const docs = sf.addLibrary('Documents');
  sf.addFolder(docs, '/Invoices');
  sf.addFile(docs, '/a.pdf', 'pdf');
  sf.addFile(docs, '/b.png', 'px');
  sf.addLibrary('Team', { type: 'shared', permission: 'r', owner: 'Bob Example' });
  sf.addLibrary('Vault', { encrypted: true });
  let api;
  let client;
  api = seafileApi(sf, {
    translations: manifest.locales,
    handlers: {
      'jmap.uploadBlob': async (bytes, name, type) => ({ blobId: `blob-${name}`, size: bytes.byteLength, type }),
      'composer.attach': attach,
      'ui.openDialog': (opts) => new Promise((resolve) => {
        act(() => { render(h(PickerDialog, { ...opts.extraProps, api, client, onResult: resolve })); });
      }),
    },
  });
  client = createClient(api, { origin: ORIGIN });
  return { sf, api, docs };
}

function row(name) {
  return screen.getByText(name).closest('[role="listitem"]');
}

async function openLibrary(name = 'Documents') {
  fireEvent.click(await screen.findByText(name));
  await screen.findByText('a.pdf');
}

describe('the Attach menu entry', () => {
  it('reports when the composer is gone instead of losing the links', async () => {
    const api = fakeApi({ translations: manifest.locales, handlers: {
      'ui.openDialog': async () => ({ action: 'links', links: [{ id: 'x', name: 'n', url: 'https://c/f/1/' }] }),
      'composer.replaceSelection': async () => { throw new Error('composer.replaceSelection: that composer is not open any more'); },
    } });
    await onAction(api, { surface: 'composer-attach-menu', actionId: 'from-seafile', context: { composerId: 'c1' } });
    expect(api.calls('toast.error')).toHaveLength(1);
    expect(api.calls('toast.success')).toHaveLength(0);
  });

  it('is registered in the Attach menu', async () => {
    const api = fakeApi({ translations: manifest.locales });
    await registerActions(api);
    const call = api.calls('ui.setActions').find((c) => c.args[0] === 'composer-attach-menu');
    expect(call.args[1]).toEqual([{ id: 'from-seafile', label: 'From Seafile', icon: 'cloud' }]);
    expect(slots['composer-attachment-source']).toBeUndefined();
    expect(manifest.permissions).toContain('ui:composer-toolbar');
    expect(manifest.permissions).toContain('email:blob-write');
  });

  it('opens on the libraries and says what can\'t be done with each', async () => {
    const { api } = setup();
    void onAction(api, { surface: 'composer-attach-menu', actionId: 'from-seafile', context: { composerId: 'c1' } });
    await screen.findByText('Documents');
    expect(row('Team').textContent).toContain('Shared by Bob Example · Read-only');
    expect(row('Vault').textContent).toContain('Encrypted');
    // An encrypted library can't be opened from the webmail.
    expect(row('Vault').getAttribute('aria-disabled')).toBe('true');
    expect(within(screen.getByRole('navigation', { name: 'Folder path' })).getByRole('button', { name: 'Libraries' })).toBeTruthy();
    expect(screen.getByText('Choose one or more files.')).toBeTruthy();
  });

  it('attaches the picked files to the composer that was clicked', async () => {
    const { api, docs } = setup();
    const done = onAction(api, { surface: 'composer-attach-menu', actionId: 'from-seafile', context: { composerId: 'composer-7' } });
    expect(api.calls('ui.openDialog')[0].args[0]).toMatchObject({ slot: 'plugin-dialog', extraProps: { view: 'picker', composerId: 'composer-7' } });
    await openLibrary();
    // The breadcrumb names the library, not its id.
    expect(within(screen.getByRole('navigation', { name: 'Folder path' })).getByRole('button', { name: 'Documents' })).toBeTruthy();
    fireEvent.click(row('a.pdf'));
    fireEvent.click(row('b.png'));
    expect(screen.getByText('Selected: 2 (5 B)')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Attach copies' })); });
    await done;
    expect(api.calls('composer.attach').map((c) => c.args)).toEqual([
      ['composer-7', { blobId: 'blob-a.pdf', name: 'a.pdf', type: 'application/pdf', size: 3 }],
      ['composer-7', { blobId: 'blob-b.png', name: 'b.png', type: 'image/png', size: 2 }],
    ]);
    expect(api.calls('toast.success')[0].args[0]).toBe('Attached from Seafile: 2');
    // The folder is remembered for the next time.
    expect(api.storageSnapshot().pickerPath).toBe(`/${docs}`);
  });

  it('says which file the composer refused and keeps it selected', async () => {
    const { api } = setup({ attach: async (id, blob) => blob.name !== 'b.png' });
    void onAction(api, { surface: 'composer-attach-menu', actionId: 'from-seafile', context: { composerId: 'c1' } });
    await openLibrary();
    fireEvent.click(row('a.pdf'));
    fireEvent.click(row('b.png'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Attach copies' })); });
    await screen.findByText("The composer didn't accept b.png. The message may be too large.");
    // a.pdf is in the message now; only b.png stays ticked for another try.
    expect(within(row('a.pdf')).getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
    expect(within(row('b.png')).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
    expect(api.calls('toast.success')[0].args[0]).toBe('Attached from Seafile: 1');
  });

  it('puts "Share as link" links into the message at the caret', async () => {
    const { sf, api } = setup();
    const done = onAction(api, { surface: 'composer-attach-menu', actionId: 'from-seafile', context: { composerId: 'c1' } });
    await openLibrary();
    fireEvent.click(row('a.pdf'));
    fireEvent.click(screen.getByRole('button', { name: 'Share as link…' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add links' })); });
    await done;
    const [call] = api.calls('composer.replaceSelection');
    expect(call.args[0]).toBe('c1');
    expect(Object.keys(call.args[1])).toEqual(['html']);
    expect(call.args[1].html).toContain(`<a href="${ORIGIN}/f/share1/">a.pdf</a>`);
    expect(call.args[1].html).toContain('Files shared with Seafile');
    expect(sf.state.shares[0]).toMatchObject({ path: '/a.pdf', permissions: { can_edit: false, can_download: true, can_upload: false } });
    expect(api.calls('toast.success')[0].args[0]).toBe('Links added to the message: 1');
    expect(api.calls('composer.attach')).toHaveLength(0);
  });

  it('shows favorites and asks for the size of the one that is picked', async () => {
    const { sf, api, docs } = setup();
    sf.state.starred = [{ repo_id: docs, repo_name: 'Documents', repo_encrypted: false, is_dir: false, path: '/a.pdf', obj_name: 'a.pdf', mtime: '2026-11-12T18:47:35+01:00', deleted: false }];
    void onAction(api, { surface: 'composer-attach-menu', actionId: 'from-seafile', context: { composerId: 'c1' } });
    await screen.findByText('Documents');
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
    await screen.findByText('a.pdf');
    // Where the favorite lives, as people read it.
    expect(row('a.pdf').textContent).toContain('Documents');
    fireEvent.click(row('a.pdf'));
    await screen.findByText('Selected: 1 (3 B)');
  });

  it('opens on the libraries when the folder used last time is gone', async () => {
    const { api } = setup();
    await api.storage.set('pickerPath', '/00000000-0000-4000-8000-00000000dead/Old');
    void onAction(api, { surface: 'composer-attach-menu', actionId: 'from-seafile', context: { composerId: 'c1' } });
    await screen.findByText('Documents');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
  });

  it('does nothing without a composer id or when the dialog is closed', async () => {
    const api = fakeApi({ translations: manifest.locales, handlers: { 'ui.openDialog': async () => null } });
    await onAction(api, { surface: 'composer-attach-menu', actionId: 'from-seafile', context: {} });
    expect(api.calls('ui.openDialog')).toHaveLength(0);
    await onAction(api, { surface: 'composer-attach-menu', actionId: 'from-seafile', context: { composerId: 'c1' } });
    expect(api.calls('ui.openDialog')).toHaveLength(1);
    expect(api.calls('toast.success')).toHaveLength(0);
    expect(api.calls('composer.replaceSelection')).toHaveLength(0);
  });
});
