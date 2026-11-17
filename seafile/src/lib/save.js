// Saving mail to Seafile: one attachment, or the whole message as .eml.

import { uploadFile } from './upload.js';
import { joinPath, sanitizeFileName, splitPath, uniqueName } from './paths.js';
import { SfError } from './errors.js';

export const SAVE_FOLDER_KEY = 'saveFolder';

/** Where an upload goes: the folder (made if missing) and a free name in it. */
export async function planUpload(client, folder, name) {
  if (!splitPath(folder).repoId) throw new SfError('no_library');
  const dir = await client.mkdirp(folder);
  const taken = await client.names(dir);
  return joinPath(dir, uniqueName(sanitizeFileName(name), taken));
}

/** A file name for a message: its subject, or "message", plus .eml. */
export function emlName(subject) {
  const base = sanitizeFileName(String(subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 120), 'message');
  return `${base}.eml`;
}

/** Save one attachment of a message. Resolves to the path in Seafile. */
export async function saveAttachment(api, client, { emailId, blobId, name }, folder, { onProgress, signal } = {}) {
  const data = await api.email.getAttachment(emailId, blobId);
  const blob = new Blob([data.data], { type: data.type || 'application/octet-stream' });
  const path = await planUpload(client, folder, name || data.name || 'attachment');
  return (await uploadFile(api, client, Object.assign(blob, { name: data.name }), path, { onProgress, signal })).path;
}

/** Save the message's source as an .eml file. Resolves to the path in Seafile. */
export async function saveMessage(api, client, { emailId, name }, folder, { onProgress, signal } = {}) {
  const raw = await api.email.getRaw(emailId);
  const blob = new Blob([raw], { type: 'message/rfc822' });
  const path = await planUpload(client, folder, name || 'message.eml');
  return (await uploadFile(api, client, blob, path, { onProgress, signal })).path;
}
