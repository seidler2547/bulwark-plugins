// Errors from Seafile and from the webmail's proxy, turned into a few codes
// the user gets a plain sentence for. Never a stack trace.

export class SfError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {{ status?: number, detail?: string }} [info]
   */
  constructor(code, info = {}) {
    super(info.detail ? `${code}: ${info.detail}` : code);
    this.name = 'SfError';
    this.code = code;
    this.status = info.status ?? 0;
    this.detail = info.detail ?? '';
  }
}

export const ERROR_CODES = [
  'not_connected', 'auth', 'forbidden', 'share_forbidden', 'not_found', 'exists', 'quota', 'too_large',
  'locked', 'rate_limited', 'timeout', 'unreachable', 'blocked', 'maintenance', 'server', 'cancelled',
  'wrong_server', 'login_expired', 'bad_answer', 'rejected', 'attach_refused', 'mail_rate_limited', 'mail_upload',
  'no_browser_signin', 'not_seafile', 'token_rejected', 'file_server', 'encrypted', 'no_library', 'unknown',
];

// The proxy marks its own refusals with x-bulwark-proxy-error.
const PROXY_CODES = {
  no_credential: 'not_connected',
  rate_limited: 'rate_limited',
  timeout: 'timeout',
  unreachable: 'unreachable',
  blocked_address: 'blocked',
  wrong_origin: 'blocked',
  redirect_off_origin: 'blocked',
  'no-third-party-traffic': 'blocked',
  too_large: 'too_large',
};

/**
 * What Seafile says went wrong, if anything: the web API answers
 * {"error_msg": …} or {"detail": …}, the file server a line of text.
 */
export function serverMessage(body) {
  let data = body;
  if (typeof data === 'string') {
    const text = data.trim();
    if (!text) return '';
    if (text[0] !== '{') return text.length <= 200 && !/[<>]/.test(text) ? text : '';
    try { data = JSON.parse(text); } catch { return ''; }
  }
  if (!data || typeof data !== 'object') return '';
  for (const key of ['error_msg', 'detail', 'error']) {
    if (typeof data[key] === 'string' && data[key].trim()) return data[key].trim().slice(0, 300);
  }
  return '';
}

function bodyText(body) {
  if (typeof body === 'string') return body;
  try { return body && typeof body === 'object' ? JSON.stringify(body) : ''; } catch { return ''; }
}

/**
 * The error for a proxy.fetch result, or null when it went through.
 * `kind` "share" turns a 403 into share_forbidden.
 */
export function errorFromResponse(res, { kind } = {}) {
  if (!res || typeof res !== 'object') return new SfError('unknown');
  // The webmail's "no third-party traffic" mode answers 403 with this code in the body.
  if (Number(res.status) === 403 && /no-third-party-traffic/.test(bodyText(res.body))) return new SfError('blocked', { status: 403 });
  if (res.proxyError) {
    return new SfError(PROXY_CODES[res.proxyError] ?? 'unknown', { status: res.status, detail: typeof res.body === 'string' ? res.body : '' });
  }
  if (res.ok) return null;
  const status = Number(res.status) || 0;
  const detail = serverMessage(res.body);
  const info = { status, detail };
  if (status === 400 && detail) return new SfError('rejected', info);
  if (status === 401) return new SfError('auth', info);
  // Seafile answers a request without a token with 403, not 401.
  if (status === 403 && /credentials were not provided/i.test(detail)) return new SfError('auth', info);
  if (status === 403) return new SfError(kind === 'share' ? 'share_forbidden' : 'forbidden', info);
  if (status === 404) return new SfError('not_found', info);
  if (status === 409) return new SfError('exists', info);
  if (status === 413 || status === 442) return new SfError('too_large', info);
  if (status === 423) return new SfError('locked', info);
  if (status === 429) return new SfError('rate_limited', info);
  // Seafile's own codes: 440 a library password is needed, 443 out of quota.
  if (status === 440 || status === 441) return new SfError('encrypted', info);
  if (status === 443) return new SfError('quota', info);
  if (status === 502 || status === 503) return new SfError('maintenance', info);
  if (status === 504 || status === 408) return new SfError('timeout', info);
  if (status >= 500) return new SfError('server', info);
  if (detail) return new SfError('rejected', info);
  return new SfError('unknown', info);
}

/** An exception thrown by api.proxy.fetch itself (the host refused or the request broke). */
export function errorFromException(err, signal) {
  if (err instanceof SfError) return err;
  if (signal?.aborted) return new SfError('cancelled');
  const message = String(err?.message ?? err ?? '');
  if (/cancel|abort/i.test(message)) return new SfError('cancelled');
  if (/timed out/i.test(message)) return new SfError('timeout');
  if (/larger than/i.test(message)) return new SfError('too_large');
  if (/at most \d+ proxy requests|rate.?limit|too many requests/i.test(message)) return new SfError('rate_limited');
  if (/network/i.test(message)) return new SfError('unreachable');
  return new SfError('unknown', { detail: message.slice(0, 200) });
}

/**
 * An exception from the mail server side (api.jmap.uploadBlob): these are
 * not Seafile's fault, so they get their own messages.
 */
export function mailError(err, signal) {
  if (signal?.aborted) return new SfError('cancelled');
  const message = String(err?.message ?? err ?? '');
  if (/rate.?limit|too many requests|429/i.test(message)) return new SfError('mail_rate_limited');
  if (/larger than|too large|413/i.test(message)) return new SfError('too_large');
  return new SfError('mail_upload', { detail: message.slice(0, 200) });
}

/** Whether the user should be offered to sign in again. */
export function needsSignIn(err) {
  return err instanceof SfError && (err.code === 'auth' || err.code === 'not_connected' || err.code === 'wrong_server');
}

// Seafile's or the host's words, or the server's address. What the plugin itself
// notes on bad_answer is for logs (err.message), not for the user.
const WITH_DETAIL = ['forbidden', 'share_forbidden', 'rejected', 'unknown', 'mail_upload', 'file_server'];

/**
 * One sentence for the user. `t` is api.i18n.t. Seafile's own message is
 * added for errors where it says something useful (password rules, sharing
 * turned off by the admin).
 */
export function errorText(t, err) {
  const e = err instanceof SfError ? err : errorFromException(err);
  const text = t(`error.${ERROR_CODES.includes(e.code) ? e.code : 'unknown'}`);
  return WITH_DETAIL.includes(e.code) && e.detail ? `${text} (${e.detail})` : text;
}
