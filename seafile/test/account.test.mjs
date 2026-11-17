// @vitest-environment jsdom
// The connected account is named as a Seafile account (name and address),
// so it can't be taken for the mail account, and can be switched. Signing in
// goes through Seafile's own page; a token is the way in where that is off.
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { fakeSeafile, seafileApi, ORIGIN, USER } from './fake-seafile.mjs';
import { accountName, connectedText } from '../src/lib/account.js';
import { deviceId } from '../src/lib/connection.js';
import { setApi } from '../src/lib/host.js';
import { SettingsSection } from '../src/ui/settings-section.js';
import manifest from '../manifest.json' with { type: 'json' };

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const CONNECTED = 'Connected to Seafile at files.example.com as Alice Example (alice@example.org).';

function setup({ account = 'browser', seafile = {}, fixed = ORIGIN, handlers = {} } = {}) {
  const sf = fakeSeafile(seafile);
  const api = seafileApi(sf, { account, fixed, translations: manifest.locales, handlers });
  setApi(api);
  return { sf, api };
}

describe('naming the Seafile account', () => {
  it('shows the name with the address, never Seafile\'s internal user id', () => {
    expect(accountName({ displayName: 'Alice Example', email: 'alice@example.org', userId: USER.email })).toBe('Alice Example (alice@example.org)');
    expect(accountName({ displayName: 'Alice Example', email: '', userId: USER.email })).toBe('Alice Example');
    expect(accountName({ displayName: '', email: '', userId: USER.email })).toBe('');
  });

  it('shows one of them when they are the same or one is missing', () => {
    expect(accountName({ displayName: 'alice@example.org', email: 'alice@example.org' })).toBe('alice@example.org');
    expect(accountName({ displayName: '', email: 'alice@example.org' })).toBe('alice@example.org');
    // An old-style account whose id is its address.
    expect(accountName({ displayName: 'Bob', email: '', userId: 'bob@example.org' })).toBe('Bob (bob@example.org)');
  });

  it('says it is the Seafile account and where', () => {
    const t = fakeApi({ translations: manifest.locales }).i18n.t;
    expect(connectedText(t, { origin: ORIGIN, displayName: 'Alice Example', email: 'alice@example.org' })).toBe(CONNECTED);
  });
});

describe('the settings section', () => {
  it('names the Seafile account, with a hint about single sign-on', async () => {
    setup();
    await act(async () => { render(React.createElement(SettingsSection)); });
    await screen.findByText(CONNECTED);
    expect(screen.getByText(/signed in on Seafile's page when you connected, not necessarily your mail account/)).toBeTruthy();
    expect(screen.getByText(/through your organisation \(single sign-on\), sign out there as well/)).toBeTruthy();
    expect(screen.getByText(/If Seafile lists the webmail under Linked devices, it is also unlinked there/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect with an API token' })).toBeNull();
  });

  it('switches accounts: unlinks this one, then signs in again on the same server', async () => {
    const { sf, api } = setup();
    await act(async () => { render(React.createElement(SettingsSection)); });
    await screen.findByText(CONNECTED);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use another Seafile account' })); });
    expect(sf.state.unlinked).toEqual([{ platform: 'linux', device_id: deviceId(ORIGIN) }]);
    expect(api.calls('proxy.disconnect')).toHaveLength(1);
    expect(api.calls('proxy.connect')[0].args).toEqual(['seafile', { mode: 'signin', server: ORIGIN }]);
    // Seafile's page is open; the settings wait for it.
    await screen.findByText('Waiting for Seafile…');
    expect(api.calls('ui.openExternalUrl')).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    await screen.findByRole('button', { name: 'Connect Seafile' });
  });

  it('disconnects', async () => {
    const { sf, api } = setup();
    await act(async () => { render(React.createElement(SettingsSection)); });
    await screen.findByText(CONNECTED);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
    await screen.findByText("Seafile isn't connected");
    expect(sf.state.unlinked).toHaveLength(1);
    expect(api.calls('proxy.connect')).toHaveLength(0);
  });
});

describe('connecting', () => {
  it('signs in on Seafile\'s page and is connected once the user is done there', async () => {
    let sf;
    // The user signs in (single sign-on or password) and confirms in the tab that opens.
    const { sf: seafile, api } = setup({ account: null, handlers: { 'ui.openExternalUrl': async () => { sf.completeSignIn(); } } });
    sf = seafile;
    await act(async () => { render(React.createElement(SettingsSection)); });
    await screen.findByText("Seafile isn't connected");
    expect(screen.getByText(/Server: files\.example\.com/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect Seafile' })); });
    await screen.findByText(CONNECTED);
    const link = new URL(api.calls('ui.openExternalUrl')[0].args[0]);
    expect(link.origin).toBe(ORIGIN);
    expect(link.pathname).toMatch(/^\/client-sso\/signin\d+\/$/);
    expect(link.searchParams.get('shib_device_name')).toBe('Bulwark Mail');
    expect(api.calls('toast.success')[0].args[0]).toBe('Seafile is connected (files.example.com).');
  });

  it('takes a new link to open the sign-in page again, as a link works once', async () => {
    const { sf, api } = setup({ account: null });
    await act(async () => { render(React.createElement(SettingsSection)); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Connect Seafile' })); });
    await screen.findByText('Waiting for Seafile…');
    expect(screen.getByText(/Approve access in the Seafile tab that just opened \(files\.example\.com\)/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open the sign-in page again' })); });
    await waitFor(() => expect(api.calls('ui.openExternalUrl')).toHaveLength(2));
    const [first, second] = api.calls('ui.openExternalUrl').map((c) => new URL(c.args[0]).pathname);
    expect(second).not.toBe(first);
    expect(sf.state.signIns.size).toBe(2);
    // The server was approved once; the host's dialog doesn't come up again.
    expect(api.calls('proxy.connect')).toHaveLength(1);
    await screen.findByText('Waiting for Seafile…');
  });

  it('offers a token as the other way in, for servers without the browser sign-in', async () => {
    const { api } = setup({ account: null });
    await act(async () => { render(React.createElement(SettingsSection)); });
    await screen.findByText("Seafile isn't connected");
    expect(screen.getByText('Seafile shows the token in your settings under Web API Auth Token, if your administrator turned that on.')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect with an API token' })); });
    // The host's own dialog takes the token; the plugin never sees it.
    expect(api.calls('proxy.connect')[0].args).toEqual(['seafile', { mode: 'password', server: ORIGIN }]);
    await screen.findByText(CONNECTED);
  });

  it('says so when the server has the browser sign-in turned off, and leaves the token', async () => {
    const { api } = setup({ account: null, seafile: { browserSignIn: false } });
    await act(async () => { render(React.createElement(SettingsSection)); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Connect Seafile' })); });
    await screen.findByText(/This Seafile server doesn't offer sign-in through the browser\. Your administrator can turn it on\. You can connect with an API token instead\. Seafile shows the token/);
    expect(api.calls('ui.openExternalUrl')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Connect Seafile' })).toBeNull();
    const buttons = screen.getAllByRole('button', { name: 'Connect with an API token' });
    expect(buttons).toHaveLength(1);
    await act(async () => { fireEvent.click(buttons[0]); });
    expect(api.calls('proxy.connect').map((c) => c.args[1].mode)).toEqual(['signin', 'password']);
    await screen.findByText(CONNECTED);
  });

  it('offers to sign in again when the token stopped working', async () => {
    const { sf } = setup();
    sf.state.token = false;
    await act(async () => { render(React.createElement(SettingsSection)); });
    await screen.findByText('Sign in to Seafile again');
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
  });

  it('does not use an account for another server than the one the admin set', async () => {
    setup({ fixed: 'https://other.example.org' });
    await act(async () => { render(React.createElement(SettingsSection)); });
    await screen.findByText(/Your administrator set Seafile to other\.example\.org\. Connect to that server\./);
  });
});
