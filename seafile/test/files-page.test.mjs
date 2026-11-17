// @vitest-environment jsdom
// The Seafile page: an empty state with Connect before connecting, then
// the Files app layout (toolbar with the path and actions; libraries at the
// top, files and folders inside them).
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeSeafile, seafileApi, ORIGIN } from './fake-seafile.mjs';
import { setApi } from '../src/lib/host.js';
import { FilesPage } from '../src/ui/files-page.js';
import manifest from '../manifest.json' with { type: 'json' };

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

function setup({ account = 'browser', handlers = {} } = {}) {
  const sf = fakeSeafile();
  const docs = sf.addLibrary('Documents');
  sf.addFolder(docs, '/Invoices');
  sf.addFile(docs, '/notes.txt', 'x'.repeat(2048));
  const team = sf.addLibrary('Team', { type: 'shared', permission: 'r', owner: 'Bob Example' });
  sf.addFile(team, '/plan.md', 'plan');
  const api = seafileApi(sf, { account, fixed: ORIGIN, translations: manifest.locales, handlers });
  setApi(api);
  return { sf, api, docs, team };
}

const rows = () => within(screen.getByRole('list', { name: 'Folder path' })).getAllByRole('listitem');
const toolbarButton = (name) => within(screen.getByRole('toolbar')).getByRole('button', { name });

async function open(name) {
  await act(async () => { fireEvent.click(await screen.findByText(name)); });
}

describe('the Seafile page', () => {
  it('offers to connect in an empty state before connecting', async () => {
    setup({ account: null });
    await act(async () => { render(React.createElement(FilesPage)); });
    await screen.findByText("Seafile isn't connected");
    expect(screen.getByText(/Server: files\.example\.com/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Seafile' })).toBeTruthy();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('shows the libraries first; files go into one of them, not next to them', async () => {
    setup();
    await act(async () => { render(React.createElement(FilesPage)); });
    const toolbar = await screen.findByRole('toolbar');
    await screen.findByText('Documents');
    expect(within(toolbar).getByRole('button', { name: 'Libraries' }).getAttribute('aria-current')).toBe('page');
    expect(within(toolbar).getByRole('searchbox', { name: 'Search' })).toBeTruthy();
    for (const name of ['Favorites', 'New library', 'Refresh', 'Alice Example (alice@example.org)']) {
      expect(within(toolbar).getByRole('button', { name }), name).toBeTruthy();
    }
    expect(toolbarButton('Upload').disabled).toBe(true);
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Documents2 KB/),
      expect.stringMatching(/^TeamShared by Bob Example · Read-only4 B/),
    ]);
  });

  it('shows a library like the Files app, with the selection actions', async () => {
    const { docs } = setup();
    await act(async () => { render(React.createElement(FilesPage)); });
    await open('Documents');
    await screen.findByText('notes.txt');
    const crumbs = within(screen.getByRole('toolbar')).getByRole('navigation', { name: 'Folder path' });
    expect(within(crumbs).getAllByRole('button').map((b) => b.textContent)).toEqual(['Libraries', 'Documents']);
    expect(toolbarButton('Upload').disabled).toBe(false);
    expect(toolbarButton('New folder').disabled).toBe(false);
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('Invoices—'), expect.stringContaining('notes.txt2 KB')]);

    fireEvent.click(rows()[1]);
    const selection = screen.getByRole('toolbar');
    for (const name of ['Clear selection', 'Download', 'Share link', 'Attach to new message', 'Open in Seafile']) {
      expect(within(selection).getByRole('button', { name }), name).toBeTruthy();
    }
    expect(docs).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('says which library a search looks into, and goes back there', async () => {
    setup();
    await act(async () => { render(React.createElement(FilesPage)); });
    await open('Documents');
    await open('Invoices');
    await act(async () => { fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'notes' } }); });
    await screen.findByText('notes.txt');
    const crumbs = () => within(within(screen.getByRole('toolbar')).getByRole('navigation', { name: 'Folder path' })).getAllByRole('button');
    expect(crumbs().map((b) => b.textContent)).toEqual(['Libraries', 'Documents', 'Results for “notes”']);
    await act(async () => { fireEvent.click(crumbs()[1]); });
    await screen.findByText('Invoices');
    expect(crumbs().map((b) => b.textContent)).toEqual(['Libraries', 'Documents']);
    expect(screen.getByRole('searchbox', { name: 'Search' }).value).toBe('');
  });

  it('opens a file in Seafile, downloads it and attaches it to a new message', async () => {
    const { api, docs } = setup({ handlers: { 'jmap.uploadBlob': async (bytes, name, type) => ({ blobId: 'b1', size: bytes.byteLength, type }) } });
    await act(async () => { render(React.createElement(FilesPage)); });
    await open('Documents');
    fireEvent.click(await screen.findByText('notes.txt'));
    fireEvent.click(toolbarButton('Open in Seafile'));
    expect(api.calls('ui.openExternalUrl')[0].args[0]).toBe(`${ORIGIN}/lib/${docs}/file/notes.txt`);
    await act(async () => { fireEvent.click(toolbarButton('Download')); });
    await waitFor(() => expect(api.calls('ui.downloadFile')).toHaveLength(1));
    expect(api.calls('ui.downloadFile')[0].args[0]).toMatchObject({ filename: 'notes.txt', contentType: 'text/plain' });
    expect(api.calls('ui.downloadFile')[0].args[0].content.byteLength).toBe(2048);
    await act(async () => { fireEvent.click(toolbarButton('Attach to new message')); });
    await waitFor(() => expect(api.calls('compose.open')).toHaveLength(1));
    expect(api.calls('compose.open')[0].args[0]).toEqual({ attachments: [{ blobId: 'b1', name: 'notes.txt', type: 'text/plain', size: 2048 }] });
  });

  it('takes no uploads in a library the user can only read', async () => {
    setup();
    await act(async () => { render(React.createElement(FilesPage)); });
    await open('Team');
    await screen.findByText('plan.md');
    expect(toolbarButton('Upload').disabled).toBe(true);
    expect(toolbarButton('New folder').disabled).toBe(true);
  });

  it('makes a library from the list of libraries and a folder inside one', async () => {
    const { sf, api, docs } = setup({ handlers: { 'ui.prompt': async (opts) => ({ name: opts.title === 'New library' ? 'Projects' : 'Drafts' }) } });
    await act(async () => { render(React.createElement(FilesPage)); });
    await screen.findByText('Documents');
    await act(async () => { fireEvent.click(toolbarButton('New library')); });
    expect(api.calls('ui.prompt')[0].args[0]).toMatchObject({ title: 'New library', fields: [{ name: 'name', label: 'Library name' }] });
    // It opens the new library right away.
    await waitFor(() => expect(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Projects' })).toBeTruthy());
    expect([...sf.state.repos.values()].map((r) => r.repo_name)).toContain('Projects');
    await screen.findByText('This folder is empty.');

    await act(async () => { fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: 'Libraries' })); });
    await open('Documents');
    await screen.findByText('notes.txt');
    await act(async () => { fireEvent.click(toolbarButton('New folder')); });
    await waitFor(() => expect(sf.state.repos.get(docs).files.has('/Drafts')).toBe(true));
  });

  it('says there are no libraries yet and offers to make one', async () => {
    const sf = fakeSeafile();
    setApi(seafileApi(sf, { translations: manifest.locales }));
    await act(async () => { render(React.createElement(FilesPage)); });
    await screen.findByText('You have no libraries yet.');
    expect(within(screen.getByRole('list', { name: 'Folder path' })).getByRole('button', { name: 'New library' })).toBeTruthy();
  });

  it('offers to sign in again when the token stopped working while browsing', async () => {
    const { sf } = setup();
    await act(async () => { render(React.createElement(FilesPage)); });
    await screen.findByText('Documents');
    sf.state.token = false;
    await open('Documents');
    await screen.findByText('Sign in to Seafile again');
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
  });
});

describe('multi-file uploads', () => {
  function deferredUploads() {
    const started = [];
    const env = setup();
    // Hold every upload until the test lets it through.
    env.sf.failNext('/seafhttp/upload-api/', (url, init, pass) => new Promise((resolve) => { started.push({ resolve: () => resolve(pass()) }); }), 20);
    return { ...env, started };
  }

  async function selectFiles(...names) {
    await act(async () => { render(React.createElement(FilesPage)); });
    await open('Documents');
    await screen.findByText('notes.txt');
    const files = names.map((name) => new File([name], name, { type: 'application/octet-stream' }));
    await act(async () => {
      fireEvent.change(screen.getByTestId('sf-upload-input'), { target: { files } });
    });
  }

  it('uploads multiple selected files one at a time, without dropping any', async () => {
    const { sf, started, docs } = deferredUploads();
    await selectFiles('one.json', 'two.asc', 'three.txt');
    for (let i = 1; i <= 3; i++) {
      await waitFor(() => expect(started).toHaveLength(i));
      await act(async () => { started[i - 1].resolve(); });
    }
    await waitFor(() => expect(screen.getAllByText('Uploaded')).toHaveLength(3));
    expect(sf.state.uploads.map((u) => u.name)).toEqual(['one.json', 'two.asc', 'three.txt']);
    expect(new TextDecoder().decode(sf.bytes(docs, '/two.asc'))).toBe('two.asc');
    // The list shows them once the uploads are in.
    await waitFor(() => expect(rows().some((r) => r.textContent.startsWith('three.txt') && !r.textContent.includes('Uploaded'))).toBe(true));
  });

  it('can cancel a queued upload and resume it later', async () => {
    const { started } = deferredUploads();
    await selectFiles('first.json', 'second.asc');
    await waitFor(() => expect(started).toHaveLength(1));
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButtons[1]);
    await screen.findByText('Paused');

    await act(async () => { started[0].resolve(); });
    expect(started).toHaveLength(1); // The cancelled upload is not started.

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(started).toHaveLength(2));
    await act(async () => { started[1].resolve(); });
    await waitFor(() => expect(screen.getAllByText('Uploaded')).toHaveLength(2));
  });
});
