// Overview numbers, website health checks and activity history.
// Every value shown comes from a database query or a request made from this browser.
import { $, el, fmtBytes, fmtDate, setMsg } from './util.js';

let sb = null;
export function init(client) { sb = client; }

const CONTENT_TABLES = [
  ['Hero', 'hero'],
  ['Career roles', 'career_roles'],
  ['Achievements', 'achievements'],
  ['Sections', 'sections'],
  ['Contact and SEO settings', 'site_settings'],
];

// ---------- Content and media numbers ----------

export async function loadOverview() {
  const counts = [];
  let total = 0;
  let latest = null;
  let failed = false;
  for (const [label, table] of CONTENT_TABLES) {
    const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true });
    const n = error ? null : (count ?? 0);
    counts.push([label, n === null ? 'Unavailable' : String(n)]);
    if (n === null) failed = true;
    else total += n;
    const { data, error: latestError } = await sb.from(table).select('updated_at').order('updated_at', { ascending: false }).limit(1);
    if (latestError) failed = true;
    else if (data && data[0] && (!latest || data[0].updated_at > latest)) latest = data[0].updated_at;
  }
  // A failed query is never shown as zero or "none yet".
  const lastText = failed ? 'Unavailable' : (latest ? fmtDate(latest) : 'None yet');
  counts.push(['Last change saved to drafts', lastText]);
  $('ov-counts').replaceChildren(...counts.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
  $('k-content-total').textContent = failed ? 'Unavailable' : String(total);
  $('k-last-change').textContent = lastText;

  await loadMediaNumbers();
  loadActivityPreview();
  runChecks();
}

async function loadMediaNumbers() {
  const { data, error } = await sb.from('media_assets')
    .select('kind, status, size_bytes, created_at, original_name')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) {
    ['k-media-total', 'k-media-images', 'k-media-resumes', 'k-media-size', 'k-media-last'].forEach((id) => { $(id).textContent = 'Unavailable'; });
    $('k-draft-note').textContent = 'Could not load';
    $('gauge-text').textContent = 'Unavailable: the library could not be read.';
    $('rs-draft').textContent = 'Unavailable';
    $('rs-archived').textContent = 'Unavailable';
    return;
  }
  const images = data.filter((r) => r.kind === 'photo');
  const resumes = data.filter((r) => r.kind === 'resume');
  const draft = resumes.find((r) => r.status === 'draft');
  const bytes = data.reduce((sum, r) => sum + Number(r.size_bytes || 0), 0);
  $('k-media-total').textContent = String(data.length);
  $('k-media-images').textContent = String(images.length);
  $('k-media-resumes').textContent = String(resumes.length);
  $('k-media-size').textContent = fmtBytes(bytes);
  $('k-media-last').textContent = data[0] ? fmtDate(data[0].created_at) : 'None yet';
  $('k-draft-note').textContent = draft ? `Draft: ${draft.original_name}` : 'No draft résumé';

  // Storage gauge: recorded uploads against the plan's file-storage allowance.
  // The allowance is the Supabase Free plan figure (1 GB). Uploads outside this library are not counted.
  const pct = Math.min(100, (bytes / PLAN_STORAGE_BYTES) * 100);
  $('gauge-fill').style.width = `${pct.toFixed(2)}%`;
  $('gauge').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('gauge-text').textContent = data.length
    ? `${fmtBytes(bytes)} of ${fmtBytes(PLAN_STORAGE_BYTES)} plan storage (${pct < 0.1 ? '<0.1' : pct.toFixed(1)}%). Covers uploads recorded in this library.`
    : `No uploads recorded yet. Plan allowance: ${fmtBytes(PLAN_STORAGE_BYTES)}.`;

  // Résumé status from the database. "On the website" comes from the live file check.
  const archived = resumes.filter((r) => r.status === 'archived').length;
  $('rs-draft').textContent = draft ? `${draft.original_name} · ${fmtDate(draft.created_at)}` : 'None uploaded';
  $('rs-archived').textContent = String(archived);
}

const PLAN_STORAGE_BYTES = 1024 * 1024 * 1024;

// ---------- Website health (run from this browser) ----------

const HTTP_CHECKS = [
  { key: 'home', label: 'Public homepage', path: '/', method: 'GET', type: 'text/html' },
  { key: 'resume', label: 'Résumé PDF (live)', path: '/Resume/Resume_Mohamed_Magdoom.pdf', method: 'HEAD', type: 'application/pdf' },
  { key: 'og', label: 'Social-sharing image', path: '/og-image.png', method: 'HEAD', type: 'image/png' },
  { key: 'admin', label: 'Admin route', path: '/admin/', method: 'GET', type: 'text/html' },
];

async function httpCheck(check) {
  const started = performance.now();
  try {
    const res = await fetch(check.path, { method: check.method, cache: 'no-store', credentials: 'omit' });
    const ms = Math.round(performance.now() - started);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const size = Number(res.headers.get('content-length')) || null;
    if (!res.ok) return { state: 'err', detail: `HTTP ${res.status}`, ms };
    if (!ct.startsWith(check.type)) return { state: 'warn', detail: `Unexpected type ${ct || 'none'}`, ms, size };
    return { state: 'ok', detail: `HTTP ${res.status} · ${check.type}`, ms, size };
  } catch {
    return { state: 'err', detail: 'No response', ms: null };
  }
}

async function backendChecks() {
  const started = performance.now();
  const db = await sb.from('site_settings').select('id', { count: 'exact', head: true });
  const dbMs = Math.round(performance.now() - started);
  const storageStart = performance.now();
  const storage = await sb.storage.from('content-media').list('', { limit: 1 });
  const storageMs = Math.round(performance.now() - storageStart);
  return {
    db: db.error ? { state: 'err', detail: 'Query failed', ms: null } : { state: 'ok', detail: 'Query succeeded', ms: dbMs },
    storage: storage.error ? { state: 'err', detail: 'List failed', ms: null } : { state: 'ok', detail: 'Private bucket reachable', ms: storageMs },
  };
}

const STATE_TEXT = { ok: 'Healthy', warn: 'Warning', err: 'Unavailable', idle: 'Not checked' };
let lastResults = null;
let lastRun = null;

// Exported so the résumé manager can show the live file's details without a second request.
export function liveResume() {
  return lastResults ? lastResults.resume : null;
}

export async function runChecks() {
  setPill('warn', 'Checking website…');
  setBackend('idle', 'Checking…');
  const [http, backend] = await Promise.all([
    Promise.all(HTTP_CHECKS.map((c) => httpCheck(c))),
    backendChecks().catch(() => ({ db: { state: 'err' }, storage: { state: 'err' } })),
  ]);
  const results = Object.fromEntries(HTTP_CHECKS.map((c, i) => [c.key, { ...http[i], label: c.label }]));
  results.db = { ...backend.db, label: 'Database' };
  results.storage = { ...backend.storage, label: 'Private storage' };
  lastResults = results;
  lastRun = new Date();
  render();
  return results;
}

function setPill(state, text) {
  const pill = $('sys-status');
  pill.className = `adm-pill ${state === 'ok' ? 'ok' : state === 'err' ? 'err' : state === 'warn' ? 'warn' : ''}`.trim();
  pill.textContent = text;
}

function setBackend(state, text) {
  const node = $('k-backend');
  node.className = `adm-check-state ${state}`;
  node.textContent = text;
}

function stateClass(state) {
  return state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : state === 'err' ? 'err' : 'idle';
}

function render() {
  if (!lastResults) return;
  const r = lastResults;
  const setKpi = (id, s) => { const n = $(id); n.className = `adm-check-state ${stateClass(s.state)}`; n.textContent = STATE_TEXT[s.state]; };
  setKpi('k-home', r.home);
  setKpi('k-resume-live', r.resume);
  $('rs-live').textContent = { ok: 'Available (PDF)', warn: 'Reachable, unexpected file type', err: 'Unavailable' }[r.resume.state];
  setKpi('k-og', r.og);
  setKpi('k-admin', r.admin);
  const backendOk = r.db.state === 'ok' && r.storage.state === 'ok';
  setBackend(backendOk ? 'ok' : 'err', backendOk ? 'Healthy' : 'Unavailable');
  $('k-health-time').textContent = `Last check: ${lastRun.toLocaleTimeString()}.`;

  const all = Object.values(r);
  if (all.some((s) => s.state === 'err')) setPill('err', 'Attention needed');
  else if (all.some((s) => s.state === 'warn')) setPill('warn', 'Warnings to review');
  else setPill('ok', 'All checks passing');

  $('health-list').replaceChildren(...Object.values(r).map((s) => el('div', { className: 'adm-check' }, [
    el('div', {}, [
      el('strong', { textContent: s.label, style: 'font-weight:600' }),
      el('div', { className: 'adm-note', style: 'margin:.1rem 0 0', textContent: s.detail + (s.ms != null ? ` · ${s.ms} ms` : '') }),
    ]),
    el('span', { className: `adm-check-state ${stateClass(s.state)}`, textContent: STATE_TEXT[s.state] }),
  ])));
  $('health-time').textContent = `Last run: ${lastRun.toLocaleString()}. Results are not stored; run again to refresh.`;
}

// ---------- Activity history (audit_log) ----------

const TABLE_LABEL = {
  hero: 'Hero draft',
  career_roles: 'Career role',
  achievements: 'Achievement',
  sections: 'Section',
  site_settings: 'Contact and SEO settings',
  media_assets: 'Media asset',
};

// Describes an audit row without showing its stored values.
function describe(row) {
  const d = row.details || {};
  if (row.table_name === 'media_assets') {
    const isResume = d.kind === 'resume';
    if (row.action === 'INSERT') return isResume ? 'Résumé draft uploaded' : 'Image uploaded';
    if (row.action === 'DELETE') return isResume ? 'Résumé file deleted' : 'Image deleted';
    if (d.status === 'archived') return 'Résumé version archived';
    return 'Media details updated';
  }
  const label = TABLE_LABEL[row.table_name] || row.table_name;
  const verb = { INSERT: 'created', UPDATE: 'updated', DELETE: 'deleted' }[row.action] || row.action.toLowerCase();
  return `${label} ${verb}`;
}

export async function loadActivity(limit = 50) {
  const msg = $('activity-msg');
  setMsg(msg, 'Loading activity…');
  const { data, error } = await sb.from('audit_log')
    .select('action, table_name, created_at, details')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    setMsg(msg, 'Could not load activity. Try again.', 'err');
    $('activity-list').replaceChildren();
    return;
  }
  setMsg(msg, data.length ? '' : 'No activity recorded yet.');
  $('activity-list').replaceChildren(...data.map((row) => el('li', {}, [
    el('span', { className: 'adm-item-main', textContent: describe(row) }),
    el('span', { className: 'adm-item-note', textContent: fmtDate(row.created_at) }),
  ])));
}

async function loadActivityPreview() {
  const { data, error } = await sb.from('audit_log')
    .select('action, table_name, created_at, details')
    .order('created_at', { ascending: false })
    .limit(5);
  const list = $('ov-activity');
  if (error) { list.replaceChildren(el('li', {}, [el('span', { className: 'adm-item-main', textContent: 'Could not load activity.' })])); return; }
  if (!data.length) { list.replaceChildren(el('li', {}, [el('span', { className: 'adm-item-main', textContent: 'No activity recorded yet.' })])); return; }
  list.replaceChildren(...data.map((row) => el('li', {}, [
    el('span', { className: 'adm-item-main', textContent: describe(row) }),
    el('span', { className: 'adm-item-note', textContent: fmtDate(row.created_at) }),
  ])));
}
