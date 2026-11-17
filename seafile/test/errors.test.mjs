import { describe, it, expect } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import {
  SfError, ERROR_CODES, serverMessage, errorFromResponse, errorFromException, mailError, needsSignIn, errorText,
} from '../src/lib/errors.js';
import manifest from '../manifest.json' with { type: 'json' };

const res = (status, body = '', extra = {}) => ({ status, ok: status >= 200 && status < 300, headers: {}, body, ...extra });
const code = (...args) => errorFromResponse(res(...args))?.code;

describe('errors from Seafile', () => {
  it('reads what Seafile says', () => {
    expect(serverMessage('{"error_msg":"Password is too short."}')).toBe('Password is too short.');
    expect(serverMessage('{"detail":"Invalid token"}')).toBe('Invalid token');
    expect(serverMessage({ error: 'x' })).toBe('x');
    // The file server answers with a line of text.
    expect(serverMessage("Parent dir doesn't exist.\n")).toBe("Parent dir doesn't exist.");
    expect(serverMessage('<html><body>502 Bad Gateway</body></html>')).toBe('');
    expect(serverMessage('')).toBe('');
    expect(serverMessage('{broken')).toBe('');
  });

  it('turns answers into codes', () => {
    expect(errorFromResponse(res(200, '{}'))).toBeNull();
    expect(code(400, '{"error_msg":"Password is too short."}')).toBe('rejected');
    expect(code(401, '{"detail":"Invalid token"}')).toBe('auth');
    expect(code(403, '{"error_msg":"Permission denied."}')).toBe('forbidden');
    expect(errorFromResponse(res(403, '{}'), { kind: 'share' }).code).toBe('share_forbidden');
    expect(code(404, '{"error_msg":"File not found"}')).toBe('not_found');
    expect(code(423)).toBe('locked');
    expect(code(429, '{"detail":"Request was throttled."}')).toBe('rate_limited');
    expect(code(502, '<html>')).toBe('maintenance');
    expect(code(500)).toBe('server');
    expect(code(504)).toBe('timeout');
  });

  it('knows Seafile\'s own answers', () => {
    // No token gets 403, not 401.
    expect(code(403, '{"detail":"Authentication credentials were not provided."}')).toBe('auth');
    expect(code(443, 'Out of quota.\n')).toBe('quota');
    expect(code(442, 'File size is too large.\n')).toBe('too_large');
    expect(code(440, '{"error_msg":"Library password is needed."}')).toBe('encrypted');
  });

  it('tells the proxy\'s own refusals apart', () => {
    expect(code(403, 'This credential is only for its own server', { proxyError: 'wrong_origin' })).toBe('blocked');
    expect(code(404, '', { proxyError: 'no_credential' })).toBe('not_connected');
    // The webmail's "no third-party traffic" mode, also when it doesn't say so as a proxy error.
    expect(code(403, '{"error":"The plugin proxy is off","code":"no-third-party-traffic"}')).toBe('blocked');
    expect(code(403, { error: 'The plugin proxy is off', code: 'no-third-party-traffic' })).toBe('blocked');
    expect(code(429, '', { proxyError: 'rate_limited' })).toBe('rate_limited');
    expect(code(502, '', { proxyError: 'unreachable' })).toBe('unreachable');
    expect(errorFromResponse(null).code).toBe('unknown');
  });

  it('turns exceptions into codes', () => {
    expect(errorFromException(new Error('Aborted')).code).toBe('cancelled');
    expect(errorFromException(new Error('x'), { aborted: true }).code).toBe('cancelled');
    expect(errorFromException(new Error('body is larger than 104857600 bytes; upload it in chunks')).code).toBe('too_large');
    expect(errorFromException(new Error('Network error')).code).toBe('unreachable');
    expect(errorFromException(new Error('At most 8 proxy requests at once')).code).toBe('rate_limited');
    expect(mailError(new Error('429 too many requests')).code).toBe('mail_rate_limited');
    expect(mailError(new Error('boom')).code).toBe('mail_upload');
  });

  it('offers to sign in again when the token stopped working', () => {
    expect(needsSignIn(new SfError('auth'))).toBe(true);
    expect(needsSignIn(new SfError('not_connected'))).toBe(true);
    expect(needsSignIn(new SfError('forbidden'))).toBe(false);
    expect(needsSignIn(new Error('x'))).toBe(false);
  });

  it('has a plain sentence for every code, with Seafile\'s words where they help', () => {
    const t = fakeApi({ translations: manifest.locales }).i18n.t;
    for (const c of ERROR_CODES) expect(manifest.locales.en[`error.${c}`], c).toBeTypeOf('string');
    expect(errorText(t, new SfError('rejected', { detail: 'Password is too short.' }))).toBe('Seafile refused this. (Password is too short.)');
    expect(errorText(t, new SfError('auth', { detail: 'Invalid token' }))).toBe('Your Seafile sign-in has expired or was revoked. Sign in again.');
    expect(errorText(t, new SfError('file_server', { detail: 'seafile.internal:8082' }))).toContain('(seafile.internal:8082)');
    // The plugin's own notes are for logs, not in the user's language.
    expect(errorText(t, new SfError('bad_answer', { detail: 'sign-in link' }))).toBe('Seafile sent an answer the plugin doesn\'t understand.');
    expect(new SfError('bad_answer', { detail: 'sign-in link' }).message).toBe('bad_answer: sign-in link');
    expect(errorText(t, new SfError('nonsense'))).toBe('Something went wrong with Seafile.');
    expect(errorText(t, new Error('weird'))).toBe('Something went wrong with Seafile. (weird)');
  });
});
