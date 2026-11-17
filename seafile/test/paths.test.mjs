import { describe, it, expect } from 'vitest';
import {
  normalizePath, joinPath, parentPath, baseName, splitPath, libraryPath, breadcrumb, displayPath, encodePath,
  sanitizeFileName, uniqueName, uploadTarget, originOf, isRepoId,
} from '../src/lib/paths.js';
import { dateInDays, endOfDay, formatSize, hostOf } from '../src/lib/format.js';
import { mimeOf } from '../src/lib/mime.js';

const LIB = '99389b1a-7f45-4141-96eb-10b6fd03d7c7';

describe('paths in Seafile', () => {
  it('cleans up paths', () => {
    expect(normalizePath('a//b/./c/../d/')).toBe('/a/b/d');
    expect(normalizePath('')).toBe('/');
    expect(joinPath(`/${LIB}`, 'Docs', 'a.txt')).toBe(`/${LIB}/Docs/a.txt`);
    expect(parentPath(`/${LIB}/Docs`)).toBe(`/${LIB}`);
    expect(parentPath(`/${LIB}`)).toBe('/');
    expect(baseName(`/${LIB}/Docs/a.txt`)).toBe('a.txt');
  });

  it('splits a path into the library and the path inside it', () => {
    expect(splitPath('/')).toEqual({ repoId: null, inner: '/' });
    expect(splitPath(`/${LIB}`)).toEqual({ repoId: LIB, inner: '/' });
    expect(splitPath(`/${LIB}/Docs/a b.txt`)).toEqual({ repoId: LIB, inner: '/Docs/a b.txt' });
    expect(libraryPath(LIB)).toBe(`/${LIB}`);
    expect(libraryPath(LIB, '/Docs/')).toBe(`/${LIB}/Docs`);
    expect(isRepoId(LIB)).toBe(true);
  });

  it('takes nothing but a library id for a library', () => {
    // A name is not an id: two libraries may be called the same.
    expect(splitPath('/Documents/a.txt')).toEqual({ repoId: null, inner: '/' });
    expect(splitPath('/../etc')).toEqual({ repoId: null, inner: '/' });
    expect(isRepoId('Documents')).toBe(false);
  });

  it('names the library in breadcrumbs and paths people read', () => {
    const nameOf = (id) => (id === LIB ? 'Documents' : '');
    expect(breadcrumb('/', nameOf)).toEqual([{ name: '', path: '/' }]);
    expect(breadcrumb(`/${LIB}/Invoices/2026`, nameOf)).toEqual([
      { name: '', path: '/' },
      { name: 'Documents', path: `/${LIB}` },
      { name: 'Invoices', path: `/${LIB}/Invoices` },
      { name: '2026', path: `/${LIB}/Invoices/2026` },
    ]);
    expect(breadcrumb(`/${LIB}`)[1].name).toBe('…');
    expect(displayPath(`/${LIB}/Invoices/a.pdf`, nameOf)).toBe('Documents/Invoices/a.pdf');
    expect(displayPath('/', nameOf)).toBe('');
  });

  it('encodes each segment for an address', () => {
    expect(encodePath('/Größe 100%/a&b.txt')).toBe('/Gr%C3%B6%C3%9Fe%20100%25/a%26b.txt');
  });

  it('makes names Seafile takes and finds a free one', () => {
    expect(sanitizeFileName('a/b\\c:d*?.txt')).toBe('a_b_c_d__.txt');
    expect(sanitizeFileName('  ..hidden  ')).toBe('hidden');
    expect(sanitizeFileName('\u0000', 'file')).toBe('file');
    expect(uniqueName('a.txt', ['A.TXT', 'a (2).txt'])).toBe('a (3).txt');
    expect(uniqueName('notes', [])).toBe('notes');
  });

  it('reads the upload folder as a library and a folder in it', () => {
    const day = new Date(2026, 10, 3);
    expect(uploadTarget('', 'date', day)).toEqual({ library: 'Mail attachments', folder: '/2026-11-03' });
    expect(uploadTarget('Mail attachments', 'flat', day)).toEqual({ library: 'Mail attachments', folder: '/' });
    expect(uploadTarget('/My Library/Mail/Out/', 'flat', day)).toEqual({ library: 'My Library', folder: '/Mail/Out' });
    expect(uploadTarget('My Library/Mail', 'date', day)).toEqual({ library: 'My Library', folder: '/Mail/2026-11-03' });
  });

  it('reduces a typed address to its origin', () => {
    expect(originOf('files.example.com/seafile/')).toBe('https://files.example.com');
    expect(originOf('http://localhost:18090')).toBe('http://localhost:18090');
    expect(originOf('ftp://x')).toBeNull();
    expect(originOf('')).toBeNull();
  });
});

describe('sizes, dates and types', () => {
  it('formats sizes', () => {
    expect(formatSize(0, 'en')).toBe('0 B');
    expect(formatSize(2048, 'en')).toBe('2 KB');
    expect(formatSize(1536 * 1024, 'en')).toBe('1.5 MB');
    expect(hostOf('http://localhost:18090')).toBe('localhost:18090');
  });

  it('gives Seafile the end of the chosen day, with the local offset', () => {
    const out = endOfDay('2027-01-31');
    expect(out).toMatch(/^2027-01-31T23:59:59[+-]\d\d:\d\d$/);
    expect(new Date(out).getTime()).toBe(new Date(2027, 0, 31, 23, 59, 59).getTime());
    expect(endOfDay('')).toBe('');
    expect(endOfDay('2027-02-31')).toBe('');
    expect(endOfDay('31.01.2027')).toBe('');
    expect(dateInDays(14, new Date(2026, 10, 12))).toBe('2026-11-26');
    expect(dateInDays(0)).toBe('');
  });

  it('tells a file\'s type from its name, as Seafile\'s listings carry none', () => {
    expect(mimeOf('Report 2026.PDF')).toBe('application/pdf');
    expect(mimeOf('photo.jpeg')).toBe('image/jpeg');
    expect(mimeOf('page.html')).toBe('text/html');
    expect(mimeOf('README')).toBe('application/octet-stream');
    expect(mimeOf('data.unknownext')).toBe('application/octet-stream');
  });
});
