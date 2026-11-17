// Sizes and dates for the user's language.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatSize(bytes, locale) {
  let n = Number(bytes) || 0;
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) { n /= 1024; unit++; }
  const digits = unit === 0 || n >= 100 ? 0 : 1;
  let text;
  try {
    text = new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: digits }).format(n);
  } catch {
    text = n.toFixed(digits);
  }
  return `${text} ${UNITS[unit]}`;
}

export function formatDate(ms, locale) {
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat(locale || undefined, { dateStyle: 'medium' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** The date `days` from `now`, as YYYY-MM-DD in local time; '' for 0 or less. */
export function dateInDays(days, now = new Date()) {
  const n = Math.floor(Number(days) || 0);
  if (n <= 0) return '';
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The last second of a YYYY-MM-DD day in local time, as Seafile wants an
 * expiry: "2026-11-26T23:59:59+01:00". '' when the date isn't one.
 */
export function endOfDay(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
  if (Number.isNaN(d.getTime()) || d.getDate() !== Number(m[3])) return '';
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${m[1]}-${m[2]}-${m[3]}T23:59:59${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The host of an origin, for messages. */
export function hostOf(origin) {
  try { return new URL(origin).host; } catch { return String(origin ?? ''); }
}
