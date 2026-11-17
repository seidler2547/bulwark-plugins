import { describe, it, expect } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { linkBlock, escapeHtml } from '../src/lib/links.js';
import { shareEntries, attachEntries } from '../src/lib/attach.js';
import { applyPickerResult } from '../src/lib/picker-result.js';
import { canDownload } from '../src/lib/files.js';
import manifest from '../manifest.json' with { type: 'json' };

const t = fakeApi({ translations: manifest.locales }).i18n.t;

describe('the link block in the message', () => {
  it('lists the links with size, password and expiry', () => {
    const block = linkBlock(t, [
      { name: 'a.pdf', url: 'https://files.example.com/f/abc/', size: 2048, password: 'pw', includePassword: true, expireDate: '2027-01-31' },
      { name: 'b.png', url: 'https://files.example.com/f/def/', size: 0, password: 'secret', includePassword: false, expireDate: '' },
    ], 'en');
    expect(block.html).toBe('<div class="seafile-links"><p><strong>Files shared with Seafile</strong></p><ul>'
      + '<li><a href="https://files.example.com/f/abc/">a.pdf</a> (2 KB, password: pw, available until 2027-01-31)</li>'
      + '<li><a href="https://files.example.com/f/def/">b.png</a></li></ul></div>');
    expect(block.text).toBe('\n\nFiles shared with Seafile\n- a.pdf: https://files.example.com/f/abc/ (2 KB, password: pw, available until 2027-01-31)\n- b.png: https://files.example.com/f/def/\n');
    // A password the user didn't tick stays out of the message.
    expect(block.html).not.toContain('secret');
  });

  it('escapes names and drops anything that is no web link', () => {
    const block = linkBlock(t, [
      { name: '<img src=x onerror=alert(1)>.txt', url: 'https://files.example.com/f/1/' },
      { name: 'bad', url: 'javascript:alert(1)' },
    ], 'en');
    expect(block.html).toContain('&lt;img src=x onerror=alert(1)&gt;.txt');
    expect(block.html).not.toContain('javascript:');
    expect(linkBlock(t, [{ name: 'bad', url: 'javascript:alert(1)' }], 'en')).toEqual({ html: '', text: '' });
    expect(escapeHtml(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;');
  });
});

describe('sharing and attaching picked files', () => {
  it('shares each file with the same options', async () => {
    const calls = [];
    const client = { share: async (path, opts) => { calls.push([path, opts]); return { url: `https://f.example/f${path}` }; } };
    const links = await shareEntries(client, [{ path: '/l/a.pdf', name: 'a.pdf', size: 3 }, { path: '/l/Dir', name: 'Dir', isFolder: true, size: 9 }],
      { password: 'pw', expireDate: '2027-01-31', includePassword: true });
    expect(calls).toEqual([['/l/a.pdf', { password: 'pw', expireDate: '2027-01-31' }], ['/l/Dir', { password: 'pw', expireDate: '2027-01-31' }]]);
    expect(links.map((l) => [l.name, l.size, l.url, l.includePassword])).toEqual([['a.pdf', 3, 'https://f.example/f/l/a.pdf', true], ['Dir', 0, 'https://f.example/f/l/Dir', true]]);
  });

  it('stops attaching at the first file the composer refuses', async () => {
    const api = fakeApi({ handlers: { 'jmap.uploadBlob': async (bytes, name) => ({ blobId: `b-${name}` }) } });
    const client = { download: async (e) => new Uint8Array(e.size) };
    const entries = [{ path: '/l/a', name: 'a', size: 1, type: 'text/plain' }, { path: '/l/b', name: 'b', size: 2 }, { path: '/l/c', name: 'c', size: 3 }];
    const seen = [];
    await expect(attachEntries(api, client, entries, { onAttach: async (blob) => { seen.push(blob); return blob.name !== 'b'; } }))
      .rejects.toMatchObject({ code: 'attach_refused', detail: 'b' });
    expect(seen.map((b) => [b.name, b.type, b.size])).toEqual([['a', 'text/plain', 1], ['b', 'application/octet-stream', 2]]);
  });

  it('says when the mail server did not take the file', async () => {
    const api = fakeApi({ handlers: { 'jmap.uploadBlob': async () => { throw new Error('429 Too Many Requests'); } } });
    const client = { download: async () => new Uint8Array(1) };
    await expect(attachEntries(api, client, [{ path: '/l/a', name: 'a', size: 1 }], { onAttach: async () => true })).rejects.toMatchObject({ code: 'mail_rate_limited' });
  });

  it('ignores a picker result it does not know', async () => {
    const api = fakeApi({ translations: manifest.locales });
    expect(await applyPickerResult(api, null, 'c1')).toEqual({ attached: 0, links: 0 });
    expect(await applyPickerResult(api, { action: 'links', links: [] }, 'c1')).toEqual({ attached: 0, links: 0 });
    expect(await applyPickerResult(api, { action: 'attach', attached: 0 }, 'c1')).toEqual({ attached: 0, links: 0 });
    expect(api.calls('toast.success')).toHaveLength(0);
  });
});

describe('downloads the webmail hands out', () => {
  it('leaves out what the host refuses from a plugin', () => {
    expect(canDownload({ name: 'a.pdf', type: 'application/pdf' })).toBe(true);
    expect(canDownload({ name: 'page.html', type: 'text/html' })).toBe(false);
    expect(canDownload({ name: 'logo.svg', type: 'image/svg+xml' })).toBe(false);
    expect(canDownload({ name: 'setup.exe', type: 'application/octet-stream' })).toBe(false);
  });
});
