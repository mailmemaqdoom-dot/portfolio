// Small shared helpers for the dashboard modules.

export const $ = (id) => document.getElementById(id);

export function setMsg(node, text, kind = '') {
  node.textContent = text;
  node.className = `adm-msg ${kind}`.trim();
}

export function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of children) n.append(c);
  return n;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtDate(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Display name only. Stored names are never used as file paths.
export function cleanName(name) {
  return String(name || 'file')
    .replace(/[\u0000-\u001f\u007f\\/]/g, '')
    .trim()
    .slice(0, 200) || 'file';
}

export const MIME_LABEL = {
  'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP', 'image/avif': 'AVIF', 'application/pdf': 'PDF',
};
