// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { fakeSeafile, seafileApi, ORIGIN } from './fake-seafile.mjs';
import { createClient } from '../src/lib/client.js';
import { emlName, saveAttachment, saveMessage, planUpload, SAVE_FOLDER_KEY } from '../src/lib/save.js';
import { onAction, registerActions, hooks, activate } from '../src/index.js';
import { SaveDialog } from '../src/ui/save-dialog.js';
import manifest from '../manifest.json' with { type: 'json' };

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const mail = {
  'email.getAttachment': async () => ({ name: 'invoice.pdf', type: 'application/pdf', size: 4, data: new Uint8Array([1, 2, 3, 4]).buffer }),
  'email.getRaw': async () => new TextEncoder().encode('Subject: Hi\r\n\r\nBody').buffer,
};

function setup(handlers = {}) {
  const sf = fakeSeafile();
  const docs = sf.addLibrary('Documents');
  sf.addFile(docs, '/Mail/invoice.pdf', 'old');
  const team = sf.addLibrary('Team', { type: 'shared', permission: 'r', owner: 'Bob Example' });
  const api = seafileApi(sf, { translations: manifest.locales, handlers: { ...mail, ...handlers } });
  return { sf, api, docs, team, client: createClient(api, { origin: ORIGIN }) };
}

describe('saving mail to Seafile', () => {
  it('names a message after its subject', () => {
    expect(emlName('Re: Invoice 10/2026')).toBe('Re_ Invoice 10_2026.eml');
    expect(emlName('')).toBe('message.eml');
    expect(emlName(undefined)).toBe('message.eml');
    expect(emlName('x'.repeat(300))).toHaveLength(124);
  });

  it('uploads the attachment bytes under a free name', async () => {
    const { sf, api, docs, client } = setup();
    const path = await saveAttachment(api, client, { emailId: 'e1', blobId: 'b1', name: 'invoice.pdf' }, `/${docs}/Mail`);
    expect(path).toBe(`/${docs}/Mail/invoice (2).pdf`);
    expect(api.calls('email.getAttachment')[0].args).toEqual(['e1', 'b1']);
    expect([...sf.bytes(docs, '/Mail/invoice (2).pdf')]).toEqual([1, 2, 3, 4]);
    expect(new TextDecoder().decode(sf.bytes(docs, '/Mail/invoice.pdf'))).toBe('old');
  });

  it('uploads the message source as .eml, making the folder first', async () => {
    const { sf, api, docs, client } = setup();
    const path = await saveMessage(api, client, { emailId: 'e1', name: 'Hi.eml' }, `/${docs}/Archive/2026`);
    expect(path).toBe(`/${docs}/Archive/2026/Hi.eml`);
    expect(new TextDecoder().decode(sf.bytes(docs, '/Archive/2026/Hi.eml'))).toBe('Subject: Hi\r\n\r\nBody');
  });

  it('saves nothing next to the libraries', async () => {
    const { api, client } = setup();
    await expect(planUpload(client, '/', 'a.txt')).rejects.toMatchObject({ code: 'no_library' });
    await expect(saveMessage(api, client, { emailId: 'e1', name: 'Hi.eml' }, '/')).rejects.toMatchObject({ code: 'no_library' });
  });
});

describe('the save actions', () => {
  it('adds "Save to Seafile" to attachments and to the open message', async () => {
    const api = fakeApi({ translations: manifest.locales });
    await registerActions(api);
    const calls = api.calls('ui.setActions').map((c) => [c.args[0], c.args[1].map((a) => [a.id, a.label])])
      .filter(([surface]) => surface !== 'composer-attach-menu');
    expect(calls).toEqual([
      ['attachment-menu', [['save-attachment', 'Save to Seafile']]],
      ['reader-actions', [['save-message', 'Save message to Seafile']]],
    ]);
    expect(api.calls('ui.setPages')[0].args[0]).toEqual([{ id: 'files', title: 'Seafile', icon: 'cloud' }]);
  });

  it('opens the folder dialog for an attachment and says where it went, by library name', async () => {
    const api = fakeApi({ translations: manifest.locales, handlers: { 'ui.openDialog': async () => ({ path: '/99389b1a-7f45-4141-96eb-10b6fd03d7c7/Mail/invoice.pdf', label: 'Documents/Mail/invoice.pdf' }) } });
    await onAction(api, { surface: 'attachment-menu', actionId: 'save-attachment', context: { emailId: 'e1', blobId: 'b1', name: 'invoice.pdf', size: 4 } });
    expect(api.calls('ui.openDialog')[0].args[0]).toMatchObject({
      title: 'Save invoice.pdf to Seafile', slot: 'plugin-dialog',
      extraProps: { view: 'save', kind: 'attachment', emailId: 'e1', blobId: 'b1', name: 'invoice.pdf', size: 4 },
    });
    expect(api.calls('toast.success')[0].args[0]).toBe('Saved to Seafile: Documents/Mail/invoice.pdf');
  });

  it('names a saved message after its subject', async () => {
    const api = fakeApi({ translations: manifest.locales, handlers: { 'email.get': async () => ({ subject: 'Meeting' }), 'ui.openDialog': async () => null } });
    await activate(api);
    await hooks.onAction({ surface: 'reader-actions', actionId: 'save-message', context: { emailId: 'e2' } });
    expect(api.calls('ui.openDialog')[0].args[0].extraProps).toMatchObject({ view: 'save', kind: 'message', emailId: 'e2', name: 'Meeting.eml' });
    expect(api.calls('toast.success')).toHaveLength(0);
  });

  it('ignores clicks that are not its own', async () => {
    const api = fakeApi({ translations: manifest.locales });
    await onAction(api, { surface: 'attachment-menu', actionId: 'other', context: { emailId: 'e', blobId: 'b' } });
    await onAction(api, { surface: 'attachment-menu', actionId: 'save-attachment', context: { emailId: 'e' } });
    expect(api.calls('ui.openDialog')).toHaveLength(0);
  });
});

describe('the folder dialog', () => {
  const props = { kind: 'attachment', emailId: 'e1', blobId: 'b1', name: 'invoice.pdf', size: 4 };
  const saveButton = () => screen.getByRole('button', { name: 'Save here' });

  it('wants a library first: nothing is saved next to the libraries', async () => {
    const { api, client } = setup();
    await act(async () => { render(React.createElement(SaveDialog, { ...props, api, client, onResult: () => {} })); });
    await screen.findByText('Documents');
    expect(screen.getByText('Choose a folder for invoice.pdf (4 B).')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('Open a library first.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New library' })).toBeTruthy();
  });

  it('saves into the folder that is open and remembers it', async () => {
    const { sf, api, docs, client } = setup();
    let result;
    await act(async () => { render(React.createElement(SaveDialog, { ...props, api, client, onResult: (r) => { result = r; } })); });
    await act(async () => { fireEvent.click(await screen.findByText('Documents')); });
    await act(async () => { fireEvent.click(await screen.findByText('Mail')); });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    await act(async () => { fireEvent.click(saveButton()); });
    await waitFor(() => expect(result).toBeTruthy());
    expect(result).toEqual({ path: `/${docs}/Mail/invoice (2).pdf`, label: 'Documents/Mail/invoice (2).pdf' });
    expect(sf.bytes(docs, '/Mail/invoice (2).pdf').byteLength).toBe(4);
    expect(api.storageSnapshot()[SAVE_FOLDER_KEY]).toBe(`/${docs}/Mail`);
  });

  it('does not offer to save into a library the user can only read', async () => {
    const { api, client } = setup();
    await act(async () => { render(React.createElement(SaveDialog, { ...props, api, client, onResult: () => {} })); });
    await act(async () => { fireEvent.click(await screen.findByText('Team')); });
    await screen.findByText('This folder is empty.');
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New folder' }).disabled).toBe(true);
  });

  it('opens on the folder used last time', async () => {
    const { api, docs, client } = setup();
    await api.storage.set(SAVE_FOLDER_KEY, `/${docs}/Mail`);
    await act(async () => { render(React.createElement(SaveDialog, { ...props, api, client, onResult: () => {} })); });
    await screen.findByText('invoice.pdf');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });
});
