// Seafile's listings carry no content type, so a file's type comes from its
// name. Enough for what the webmail does with it: naming the type of an
// attachment and deciding which downloads the host hands out.

const TYPES = {
  pdf: 'application/pdf',
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  rtf: 'application/rtf', ics: 'text/calendar', vcf: 'text/vcard', eml: 'message/rfc822',
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml', xml: 'application/xml',
  json: 'application/json', js: 'text/javascript', css: 'text/css', yaml: 'application/yaml', yml: 'application/yaml',
  doc: 'application/msword', dot: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', ico: 'image/x-icon',
  heic: 'image/heic', heif: 'image/heif',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav',
  flac: 'audio/flac', aac: 'audio/aac',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  bz2: 'application/x-bzip2', xz: 'application/x-xz', '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  asc: 'application/pgp-keys', sig: 'application/pgp-signature', p7s: 'application/pkcs7-signature',
  sdoc: 'application/json',
};

/** The content type for a file name; application/octet-stream when the name says nothing. */
export function mimeOf(name) {
  const s = String(name ?? '');
  const dot = s.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return TYPES[s.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}
