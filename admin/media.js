// Media library: private image uploads, browsing, details and deletion.
// Files live in the private content-media bucket. Previews use short-lived signed links.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';
import { $, el, fmtBytes, fmtDate, setMsg, cleanName, MIME_LABEL } from './util.js';
import { uploadObject, checkFile, readImageSize, saveErrorText, mimeFor, EXT_OUT, BUCKET, SIGNED_SECONDS, IMAGE_MIMES } from './storage.js';

let sb = null;
export function init(client) {
  sb = client;
  wire();
}

let assets = [];
let thumbs = new Map();
let filterMime = '';
let selected = null;
let staged = null;
let busy = false;

// True while a file is uploading. The inactivity timer does not sign out during an upload.
export function isBusy() {
  return busy;
}

function wire() {
  const drop = $('media-drop');
  const input = $('media-file');
  $('media-pick').addEventListener('click', () => input.click());
  input.addEventListener('change', () => stage(input.files[0]));
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length) stage(files[0], files.length > 1);
  });
  $('media-upload').addEventListener('click', upload);
  $('media-cancel').addEventListener('click', clearStaged);
  $('media-search').addEventListener('input', renderGrid);
  document.querySelectorAll('#media-chips .adm-chip').forEach((chip) => chip.addEventListener('click', () => {
    filterMime = chip.dataset.mime;
    document.querySelectorAll('#media-chips .adm-chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    renderGrid();
  }));
  $('media-alt-save').addEventListener('click', saveAlt);
  $('media-copy').addEventListener('click', copyPath);
  $('media-delete').addEventListener('click', () => { $('media-confirm').hidden = false; });
  $('media-confirm-no').addEventListener('click', () => { $('media-confirm').hidden = true; });
  $('media-confirm-yes').addEventListener('click', removeSelected);
}

// ---------- Loading ----------

export async function load() {
  setMsg($('media-list-msg'), 'Loading library…');
  const { data, error } = await sb.from('media_assets')
    .select('id, storage_path, original_name, mime_type, size_bytes, width, height, alt_text, created_at')
    .eq('kind', 'photo')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) {
    setMsg($('media-list-msg'), 'Could not load the library. Check your connection and try again.', 'err');
    return;
  }
  assets = data;
  await signThumbs();
  if (selected) selected = assets.find((a) => a.id === selected.id) || null;
  renderGrid();
  if (selected) showDetail(selected);
  else $('media-detail').hidden = true;
}

async function signThumbs() {
  thumbs = new Map();
  if (!assets.length) return;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(assets.map((a) => a.storage_path), SIGNED_SECONDS);
  if (error || !data) return;
  for (const item of data) if (item.signedUrl) thumbs.set(item.path, item.signedUrl);
}

function renderGrid() {
  const q = $('media-search').value.trim().toLowerCase();
  const rows = assets.filter((a) => (!filterMime || a.mime_type === filterMime)
    && (!q || a.original_name.toLowerCase().includes(q)));
  if (!rows.length) {
    $('media-grid').replaceChildren();
    setMsg($('media-list-msg'), assets.length ? 'No assets match these filters.' : 'No images yet. Upload one above.');
    return;
  }
  setMsg($('media-list-msg'), `${rows.length} of ${assets.length} asset${assets.length === 1 ? '' : 's'}`);
  $('media-grid').replaceChildren(...rows.map((a) => {
    const url = thumbs.get(a.storage_path);
    const thumb = el('div', { className: 'adm-thumb' }, url
      ? [el('img', { src: url, alt: a.alt_text || a.original_name, loading: 'lazy', decoding: 'async' })]
      : [el('span', { textContent: MIME_LABEL[a.mime_type] || 'Image' })]);
    const tile = el('button', { type: 'button', className: 'adm-tile' }, [
      thumb,
      el('span', { className: 'adm-tile-name', textContent: a.original_name }),
      el('span', { className: 'adm-tile-meta', textContent: `${MIME_LABEL[a.mime_type] || ''} · ${fmtBytes(Number(a.size_bytes))}` }),
    ]);
    tile.setAttribute('aria-pressed', String(selected?.id === a.id));
    tile.addEventListener('click', () => select(a));
    return tile;
  }));
}

// ---------- Detail ----------

function select(asset) {
  selected = asset;
  $('media-confirm').hidden = true;
  setMsg($('media-detail-msg'), '');
  renderGrid();
  showDetail(asset);
  $('media-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showDetail(a) {
  $('media-detail').hidden = false;
  $('media-detail-name').textContent = a.original_name;
  const preview = $('media-detail-preview');
  const url = thumbs.get(a.storage_path);
  preview.replaceChildren(url
    ? el('img', { src: url, alt: a.alt_text || a.original_name })
    : el('span', { className: 'adm-note', textContent: 'Preview unavailable. Reload the library.' }));
  $('media-detail-facts').replaceChildren(
    ...[
      ['Format', MIME_LABEL[a.mime_type] || a.mime_type],
      ['Dimensions', a.width && a.height ? `${a.width} × ${a.height} px` : 'Not recorded'],
      ['Size', fmtBytes(Number(a.size_bytes))],
      ['Uploaded', fmtDate(a.created_at)],
      ['Storage', 'Private bucket. Not publicly accessible'],
    ].flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]),
  );
  $('media-alt').value = a.alt_text || '';
}

async function saveAlt() {
  if (!selected) return;
  const value = $('media-alt').value.trim();
  const btn = $('media-alt-save');
  btn.disabled = true;
  const { data, error } = await sb.from('media_assets').update({ alt_text: value || null })
    .eq('id', selected.id).select('id, alt_text').single();
  btn.disabled = false;
  if (error) {
    setMsg($('media-detail-msg'), saveErrorText(error), 'err');
    return;
  }
  selected.alt_text = data.alt_text;
  setMsg($('media-detail-msg'), 'Description saved.', 'ok');
}

async function copyPath() {
  if (!selected) return;
  try {
    await navigator.clipboard.writeText(selected.storage_path);
    setMsg($('media-detail-msg'), 'Private path copied. It works only inside this dashboard.', 'ok');
  } catch {
    setMsg($('media-detail-msg'), 'Copy did not work. Select the path from the details instead.', 'err');
  }
}

async function removeSelected() {
  if (!selected || busy) return;
  const row = selected;
  $('media-confirm-yes').disabled = true;
  // Database row first: if the file delete then fails, nothing is linked to an orphaned file.
  const { error } = await sb.from('media_assets').delete().eq('id', row.id);
  $('media-confirm-yes').disabled = false;
  if (error) {
    setMsg($('media-detail-msg'), 'Could not delete this asset. Nothing was removed.', 'err');
    return;
  }
  const { error: storageError } = await sb.storage.from(BUCKET).remove([row.storage_path]);
  selected = null;
  $('media-confirm').hidden = true;
  await load();
  setMsg($('media-list-msg'), storageError
    ? 'Removed from the library, but the stored file could not be deleted. It is private and no longer linked.'
    : 'Asset deleted.', storageError ? 'err' : 'ok');
}

// ---------- Upload ----------

async function stage(file, several = false) {
  if (!file) return;
  clearStaged(true);
  const problem = await checkFile(file, IMAGE_MIMES);
  if (problem) {
    setMsg($('media-msg'), problem, 'err');
    showStaged(false);
    return;
  }
  let size;
  try {
    size = await readImageSize(file);
  } catch {
    setMsg($('media-msg'), 'This image could not be read. It may be damaged, or this browser cannot decode it.', 'err');
    return;
  }
  const mime = mimeFor(file);
  const previewUrl = URL.createObjectURL(file);
  staged = { file, mime, width: size.width, height: size.height, previewUrl };
  $('media-stage-preview').replaceChildren(el('img', { src: previewUrl, alt: `Preview of ${file.name}` }));
  $('media-stage-facts').replaceChildren(
    ...[
      ['File', cleanName(file.name)],
      ['Format', MIME_LABEL[mime]],
      ['Dimensions', `${size.width} × ${size.height} px`],
      ['Size', fmtBytes(file.size)],
    ].flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]),
  );
  setMsg($('media-msg'), several ? 'One file at a time. The first file is staged.' : 'Ready to upload. The file stays a private draft.');
  showStaged(true);
}

function showStaged(on) {
  $('media-staged').hidden = !on;
}

function clearStaged(keepMessage = false) {
  if (staged) URL.revokeObjectURL(staged.previewUrl);
  staged = null;
  $('media-file').value = '';
  $('media-stage-preview').replaceChildren();
  $('media-stage-facts').replaceChildren();
  $('media-progress').hidden = true;
  $('media-progress-bar').style.width = '0';
  if (!keepMessage) setMsg($('media-msg'), '');
  showStaged(false);
}

function setBusy(on) {
  busy = on;
  $('media-upload').disabled = on;
  $('media-cancel').disabled = on;
  $('media-pick').disabled = on;
}

async function upload() {
  if (!staged || busy) return;
  const s = staged;
  const id = crypto.randomUUID();
  const path = `images/${id}.${EXT_OUT[s.mime]}`;
  setBusy(true);
  $('media-progress').hidden = false;
  setMsg($('media-msg'), 'Uploading…');
  try {
    await uploadObject(sb, path, s.file, s.mime, (p) => {
      $('media-progress-bar').style.width = `${Math.round(p * 100)}%`;
    });
  } catch (err) {
    setBusy(false);
    setMsg($('media-msg'), `${err.message} Your file is still staged, so you can try again.`, 'err');
    return;
  }
  const { error } = await sb.from('media_assets').insert({
    id,
    kind: 'photo',
    status: 'active',
    storage_path: path,
    original_name: cleanName(s.file.name),
    mime_type: s.mime,
    size_bytes: s.file.size,
    width: s.width,
    height: s.height,
  });
  if (error) {
    // Keep storage and the library in step: remove the file if its record could not be saved.
    await sb.storage.from(BUCKET).remove([path]);
    setBusy(false);
    setMsg($('media-msg'), `${saveErrorText(error)} Your file is still staged, so you can try again.`, 'err');
    return;
  }
  setBusy(false);
  clearStaged(true);
  setMsg($('media-list-msg'), 'Upload complete. The file is in the library as a private draft.', 'ok');
  setMsg($('media-msg'), '');
  await load();
}
