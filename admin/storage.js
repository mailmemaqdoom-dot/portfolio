// Shared file checks and upload for the media library and the résumé manager.
// The database and the bucket enforce the same limits. These checks give early, clear messages.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

export const BUCKET = 'content-media';
export const MAX_BYTES = 10 * 1024 * 1024;
export const SIGNED_SECONDS = 300;
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
export const PDF_MIME = 'application/pdf';
export const EXT_OUT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'application/pdf': 'pdf' };

const EXT_TO_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', pdf: PDF_MIME };

// Some systems report no MIME type for AVIF or PDF. Fall back to the extension, then check the bytes.
export function mimeFor(file) {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return EXT_TO_MIME[ext] || '';
}

// File signatures. Checking these stops a renamed non-image or non-PDF file from passing.
function signatureMatches(head, mime) {
  const ascii = (from, to) => String.fromCharCode(...head.slice(from, to));
  switch (mime) {
    case 'image/jpeg': return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/png': return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b);
    case 'image/webp': return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image/avif': return ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12));
    case PDF_MIME: return ascii(0, 5) === '%PDF-';
    default: return false;
  }
}

// Returns an empty string when the file is acceptable, otherwise a message for the user.
export async function checkFile(file, allowed) {
  if (!file) return 'Choose a file first.';
  if (file.size === 0) return 'This file is empty.';
  if (file.size > MAX_BYTES) return 'Files must be 10 MB or smaller.';
  const mime = mimeFor(file);
  if (!allowed.includes(mime)) return 'This file type is not allowed here.';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const extOk = mime === PDF_MIME ? ext === 'pdf' : (ext === EXT_OUT[mime] || (mime === 'image/jpeg' && ext === 'jpeg'));
  if (!extOk) return 'The file extension does not match its type.';
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!signatureMatches(head, mime)) return 'The file contents do not match its type.';
  return '';
}

// Decodes the image in the browser to read its size. Fails for damaged or unsupported files.
export async function readImageSize(file) {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

// Uploads through the Storage REST API so progress can be shown. Row-level security applies:
// only the signed-in administrator's session can write.
export async function uploadObject(sb, path, file, mime, onProgress) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Your session has ended. Sign in again.');
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('apikey', SUPABASE_PUBLISHABLE_KEY);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('Content-Type', mime);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve()
      : reject(new Error(xhr.status === 403 ? 'You are not authorised to upload.' : 'The upload did not complete.')));
    xhr.onerror = () => reject(new Error('The upload lost its connection.'));
    xhr.send(file);
  });
  onProgress(1);
}

export function saveErrorText(error) {
  console.error(error);
  if (error?.code === '23514') return 'The file details did not pass validation.';
  if (error?.code === '42501') return 'You are not authorised. Sign in again.';
  return 'The file could not be saved to the library.';
}
