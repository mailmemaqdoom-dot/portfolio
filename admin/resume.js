// Résumé manager. The live résumé is shown read-only. Uploads become a private draft and never
// replace the file the website links to. Publishing a draft is a separate, approved step (not built).
import { $, el, fmtBytes, fmtDate, setMsg, cleanName } from './util.js';
import { uploadObject, checkFile, saveErrorText, BUCKET, PDF_MIME, SIGNED_SECONDS } from './storage.js';

const LIVE_PATH = '/Resume/Resume_Mohamed_Magdoom.pdf';

let sb = null;
let rows = [];
let pending = null;
let busy = false;

// True while a file is uploading. The inactivity timer does not sign out during an upload.
export function isBusy() {
  return busy;
}

export function init(client) {
  sb = client;
  wire();
}

function wire() {
  $('resume-pick').addEventListener('click', () => $('resume-file').click());
  $('resume-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) stage(file);
  });
  $('resume-confirm-yes').addEventListener('click', () => {
    $('resume-confirm').hidden = true;
    commit();
  });
  $('resume-confirm-no').addEventListener('click', () => {
    pending = null;
    $('resume-confirm').hidden = true;
    setMsg($('resume-msg'), 'Kept the current draft. Nothing was uploaded.');
  });
  $('draft-download').addEventListener('click', () => {
    const draft = rows.find((r) => r.status === 'draft');
    if (draft) download(draft);
  });
}

export async function load() {
  loadLive();
  await loadRows();
}

// Read-only check of the public file. The preview is loaded once per page visit.
async function loadLive() {
  const frame = $('live-frame');
  if (!frame.getAttribute('src')) frame.setAttribute('src', LIVE_PATH);
  try {
    const res = await fetch(LIVE_PATH, { method: 'HEAD', cache: 'no-store' });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const size = Number(res.headers.get('content-length')) || 0;
    if (res.ok && type.startsWith(PDF_MIME)) {
      $('live-status').textContent = 'Available (PDF)';
      $('live-size').textContent = size ? fmtBytes(size) : 'Not reported';
    } else {
      $('live-status').textContent = `Unavailable (HTTP ${res.status})`;
      $('live-size').textContent = '–';
    }
  } catch {
    $('live-status').textContent = 'Could not check';
    $('live-size').textContent = '–';
  }
}

async function loadRows() {
  const { data, error } = await sb.from('media_assets')
    .select('id, storage_path, original_name, size_bytes, status, created_at')
    .eq('kind', 'resume')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    setMsg($('resume-msg'), 'Could not load résumé drafts. Check your connection and try again.', 'err');
    return;
  }
  rows = data;
  renderDraft();
  renderHistory();
  renderDraftPreview();
}

function renderDraft() {
  const draft = rows.find((r) => r.status === 'draft');
  $('draft-empty').hidden = !!draft;
  $('draft-facts').hidden = !draft;
  $('draft-download').hidden = !draft;
  if (!draft) return;
  $('draft-name').textContent = draft.original_name;
  $('draft-size').textContent = fmtBytes(Number(draft.size_bytes));
  $('draft-date').textContent = fmtDate(draft.created_at);
}

// The preview uses a short-lived signed link, so it is refreshed each time the panel loads.
async function renderDraftPreview() {
  const frame = $('draft-frame');
  const draft = rows.find((r) => r.status === 'draft');
  if (!draft) {
    frame.hidden = true;
    frame.removeAttribute('src');
    return;
  }
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(draft.storage_path, SIGNED_SECONDS);
  if (error || !data) {
    frame.hidden = true;
    setMsg($('resume-msg'), 'The draft preview could not be loaded. Download it instead.', 'err');
    return;
  }
  frame.src = data.signedUrl;
  frame.hidden = false;
}

function renderHistory() {
  const list = $('resume-history');
  if (!rows.length) {
    list.replaceChildren(el('li', {}, [el('span', { className: 'adm-item-main', textContent: 'No résumé drafts uploaded yet.' })]));
    return;
  }
  list.replaceChildren(...rows.map((r) => el('li', {}, [
    el('span', { className: 'adm-item-main' }, [
      el('strong', { textContent: r.original_name }),
      el('br'),
      el('span', { className: 'adm-note', style: 'margin:0', textContent: `${fmtDate(r.created_at)} · ${fmtBytes(Number(r.size_bytes))}` }),
    ]),
    el('span', { style: 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;justify-content:flex-end' }, [
      el('span', { className: `adm-badge ${r.status === 'draft' ? 'draft' : ''}`, textContent: r.status === 'draft' ? 'Draft' : 'Archived' }),
      el('button', {
        type: 'button', className: 'adm-btn ghost', style: 'width:auto;margin:0;min-height:36px',
        textContent: 'Download', onclick: () => download(r),
      }),
    ]),
  ])));
}

async function download(row) {
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(row.storage_path, SIGNED_SECONDS, { download: cleanName(row.original_name) });
  if (error || !data) {
    setMsg($('resume-msg'), 'Could not create a download link. Try again.', 'err');
    return;
  }
  const a = document.createElement('a');
  a.href = data.signedUrl;
  a.download = cleanName(row.original_name);
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

async function stage(file) {
  if (busy) return;
  const problem = await checkFile(file, [PDF_MIME]);
  if (problem) {
    setMsg($('resume-msg'), problem, 'err');
    return;
  }
  pending = file;
  const hasDraft = rows.some((r) => r.status === 'draft');
  if (hasDraft) {
    setMsg($('resume-msg'), `Ready: ${cleanName(file.name)} (${fmtBytes(file.size)}). Confirm to replace the draft.`);
    $('resume-confirm').hidden = false;
  } else {
    await commit();
  }
}

async function commit() {
  const file = pending;
  pending = null;
  if (!file || busy) return;
  busy = true;
  $('resume-pick').disabled = true;
  $('resume-progress').hidden = false;
  $('resume-progress-bar').style.width = '0';
  setMsg($('resume-msg'), 'Uploading the draft. The live résumé is not changed.');

  const id = crypto.randomUUID();
  const path = `resumes/${id}.pdf`;
  try {
    await uploadObject(sb, path, file, PDF_MIME, (p) => {
      $('resume-progress-bar').style.width = `${Math.round(p * 100)}%`;
    });
  } catch (err) {
    finish();
    setMsg($('resume-msg'), `${err.message} Try again.`, 'err');
    return;
  }

  // One database call archives the old draft and registers the new one together.
  const { error } = await sb.rpc('replace_resume_draft', {
    p_path: path,
    p_name: cleanName(file.name),
    p_size: file.size,
  });
  if (error) {
    await sb.storage.from(BUCKET).remove([path]);
    finish();
    setMsg($('resume-msg'), `${saveErrorText(error)} The previous draft is unchanged. Try again.`, 'err');
    return;
  }
  finish();
  setMsg($('resume-msg'), 'Draft uploaded. The previous draft is kept as an archived version. The live résumé has not changed.', 'ok');
  await loadRows();
}

function finish() {
  busy = false;
  $('resume-pick').disabled = false;
  $('resume-progress').hidden = true;
}
