import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 12;

// Implicit flow: sign-in and reset links return tokens in the URL, so they work on any device.
// Token validation is still performed by Supabase.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
});

let routing = false;
let recoveryMode = false;

function show(view) {
  for (const v of ['signin', 'recovery', 'denied', 'dashboard']) $(`view-${v}`).hidden = v !== view;
  $('btn-signout').hidden = view !== 'dashboard';
}

function msg(el, text, kind = '') {
  el.textContent = text;
  el.className = `adm-msg ${kind}`.trim();
}

function busy(button, on, label) {
  button.disabled = on;
  button.textContent = on ? 'Please wait…' : label;
}

// Read an error returned by a sign-in or reset link (expired, reused or invalid).
function linkErrorFromUrl() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const search = new URLSearchParams(window.location.search);
  const code = hash.get('error_code') || search.get('error_code');
  const desc = hash.get('error_description') || search.get('error_description') || '';
  if (!code && !hash.get('error') && !search.get('error')) return '';
  history.replaceState(null, '', window.location.pathname);
  return code === 'otp_expired'
    ? 'This link has expired or was already used. Request a new one below.'
    : `Sign-in did not complete${desc ? `: ${desc.replace(/\+/g, ' ')}` : '.'} Request a new link below.`;
}

function passwordProblem(pw, confirm) {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (confirm !== undefined && pw !== confirm) return 'The two passwords do not match.';
  return '';
}

async function loadDatabaseStatus() {
  const { error, count } = await sb.from('site_settings').select('id', { count: 'exact', head: true });
  const status = $('db-status');
  if (error) {
    msg(status, 'Could not reach the database.', 'err');
    status.className = 'adm-status err';
    $('conn-indicator').textContent = 'Database: error';
  } else {
    status.textContent = `Connected. Settings rows visible to you: ${count ?? 0}.`;
    status.className = 'adm-status ok';
    $('conn-indicator').textContent = 'Database: connected';
  }
}

// Signed in is not enough: the database must confirm administrator status.
async function route() {
  if (routing) return;
  routing = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      recoveryMode = false;
      show('signin');
      return;
    }
    if (recoveryMode) {
      show('recovery');
      return;
    }
    const { data: isAdmin, error } = await sb.rpc('is_admin');
    if (error || isAdmin !== true) {
      await sb.auth.signOut();
      msg($('denied-msg'), error
        ? 'Could not verify administrator access. Please try again later.'
        : 'This account is not authorised for administration.');
      show('denied');
      return;
    }
    $('acct-email').textContent = session.user.email ?? '–';
    show('dashboard');
    setPanel('overview');
    loadDatabaseStatus();
  } finally {
    routing = false;
  }
}

// Password sign-in. Errors are generic so they do not reveal which addresses have accounts.
$('form-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('inp-email').value.trim().toLowerCase();
  const password = $('inp-password').value;
  const out = $('signin-msg');
  if (!EMAIL_RE.test(email) || !password) {
    msg(out, 'Enter your email address and password.', 'err');
    return;
  }
  const button = $('btn-signin');
  busy(button, true, 'Sign in');
  const { error } = await sb.auth.signInWithPassword({ email, password });
  busy(button, false, 'Sign in');
  $('inp-password').value = '';
  setPwVisible('inp-password', false);
  if (error) {
    msg(out, /rate limit|too many/i.test(error.message)
      ? 'Too many attempts. Wait a few minutes before trying again.'
      : 'Email or password is not correct.', 'err');
  }
  // On success, the onAuthStateChange handler routes to the dashboard.
});

// Reset email. Same message whether or not the address is authorised.
$('btn-forgot').addEventListener('click', async () => {
  const email = $('inp-email').value.trim().toLowerCase();
  const out = $('signin-msg');
  if (!EMAIL_RE.test(email)) {
    msg(out, 'Enter your email address first, then choose "Forgot password?".', 'err');
    return;
  }
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/admin/`,
  });
  if (error && /rate limit|too many/i.test(error.message)) {
    msg(out, 'Too many requests. Wait a few minutes before requesting another email.', 'err');
    return;
  }
  msg(out, 'If this address is authorised, a password reset link has been sent.', 'ok');
});

// Sign-in link option (backup, works on any device).
$('btn-link').addEventListener('click', () => {
  $('form-password').hidden = true;
  $('form-link').hidden = false;
  msg($('signin-msg'), '');
});

$('btn-back-pw').addEventListener('click', () => {
  $('form-link').hidden = true;
  $('form-password').hidden = false;
  msg($('signin-msg'), '');
});

$('form-link').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('inp-email').value.trim().toLowerCase();
  const out = $('signin-msg');
  if (!EMAIL_RE.test(email)) {
    msg(out, 'Enter your email address in the field above first.', 'err');
    return;
  }
  const button = $('btn-send-link');
  busy(button, true, 'Send sign-in link');
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/admin/` },
  });
  busy(button, false, 'Send sign-in link');
  if (error && /rate limit|too many/i.test(error.message)) {
    msg(out, 'Too many requests. Wait a few minutes before requesting another link.', 'err');
    return;
  }
  if (error && !/signups? not allowed|user not found/i.test(error.message)) {
    msg(out, 'Something went wrong sending the link. Please try again.', 'err');
    return;
  }
  msg(out, 'If this address is authorised, a sign-in link has been sent.', 'ok');
  button.disabled = true;
  setTimeout(() => { button.disabled = false; }, 30000);
});

// Choose a new password after following a reset link.
$('form-recovery').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('inp-new-pw').value;
  const pw2 = $('inp-new-pw2').value;
  const out = $('recovery-msg');
  const problem = passwordProblem(pw, pw2);
  if (problem) {
    msg(out, problem, 'err');
    return;
  }
  const button = $('btn-recovery');
  busy(button, true, 'Save password');
  const { error } = await sb.auth.updateUser({ password: pw });
  busy(button, false, 'Save password');
  if (error) {
    msg(out, 'Could not save the password. Try the reset link again.', 'err');
    return;
  }
  $('inp-new-pw').value = '';
  $('inp-new-pw2').value = '';
  setPwVisible('inp-new-pw', false);
  setPwVisible('inp-new-pw2', false);
  recoveryMode = false;
  msg(out, '');
  route();
});

// Set or change the password from the dashboard (requires an active administrator session).
$('form-set-pw').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('inp-set-pw').value;
  const out = $('set-pw-msg');
  const problem = passwordProblem(pw);
  if (problem) {
    msg(out, problem, 'err');
    return;
  }
  const button = $('btn-set-pw');
  busy(button, true, 'Set password');
  const { error } = await sb.auth.updateUser({ password: pw });
  busy(button, false, 'Set password');
  if (error) {
    msg(out, 'Could not save the password. Please sign in again and retry.', 'err');
    return;
  }
  $('inp-set-pw').value = '';
  setPwVisible('inp-set-pw', false);
  msg(out, 'Password saved. You can use it to sign in from now on.', 'ok');
});

// Show or hide a password field, and keep the button label and icon in step.
function setPwVisible(id, visible) {
  const input = $(id);
  input.type = visible ? 'text' : 'password';
  const btn = document.querySelector(`.adm-eye[data-for="${id}"]`);
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(visible));
  btn.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  btn.querySelector('.eye-on').hidden = visible;
  btn.querySelector('.eye-off').hidden = !visible;
}

document.querySelectorAll('.adm-eye').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.for;
    setPwVisible(id, $(id).type === 'password');
    $(id).focus();
  });
});

$('btn-signout').addEventListener('click', async () => {
  await sb.auth.signOut();
});

$('btn-denied-back').addEventListener('click', () => {
  show('signin');
  msg($('signin-msg'), '');
});

sb.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    recoveryMode = true;
    route();
  } else if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
    route();
  }
});

// ---------- Dashboard panels ----------

function setPanel(name) {
  $('panel-overview').hidden = name !== 'overview';
  $('panel-hero').hidden = name !== 'hero';
  document.querySelectorAll('.adm-navbtn').forEach((b) => {
    const on = b.dataset.panel === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  if (name === 'overview') loadOverview();
  if (name === 'hero') loadHero();
}

document.querySelectorAll('.adm-navbtn').forEach((b) => {
  b.addEventListener('click', () => setPanel(b.dataset.panel));
});

// ---------- Overview: real counts and last change, read from the database ----------

async function loadOverview() {
  const dl = $('ov-counts');
  const tables = [['Hero', 'hero'], ['Career roles', 'career_roles'], ['Achievements', 'achievements'],
    ['Sections', 'sections'], ['Contact and SEO settings', 'site_settings']];
  const rows = [];
  let latest = null;
  for (const [label, table] of tables) {
    const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true });
    rows.push([label, error ? 'Unavailable' : String(count ?? 0)]);
    const { data } = await sb.from(table).select('updated_at').order('updated_at', { ascending: false }).limit(1);
    if (data && data[0] && (!latest || data[0].updated_at > latest)) latest = data[0].updated_at;
  }
  rows.push(['Last change saved to drafts', latest ? new Date(latest).toLocaleString() : 'None yet']);
  dl.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

// ---------- Hero editor (drafts only) ----------

const HERO_MAX = { name: 80, eyebrow: 120, role_line: 200, positioning: 400, proof_line: 400, credibility_line: 160, quote: 300 };
const KIND_TEXT = { anchor: 'Section link', resume: 'Resume viewer', external: 'External link' };
let heroSaved = null;

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of children) n.append(c);
  return n;
}

function textField(id, label, value, max, multiline = false) {
  const input = el(multiline ? 'textarea' : 'input', { id, value: multiline ? '' : value, maxLength: max, className: `adm-input${multiline ? ' adm-textarea' : ''}` });
  if (multiline) input.value = value;
  if (!multiline) input.type = 'text';
  return el('div', { className: 'adm-field' }, [el('label', { className: 'adm-label', htmlFor: id, textContent: label }), input]);
}

function renderHeroRows(p) {
  const cta = $('h-cta');
  cta.replaceChildren(...p.cta_buttons.map((b, i) => el('div', { className: 'adm-row-card' }, [
    el('p', { className: 'adm-note', textContent: `Button ${i + 1} · ${KIND_TEXT[b.kind] || b.kind}` }),
    el('div', { className: 'adm-row' }, [
      textField(`h-cta-${i}-label`, 'Label', b.label, 60),
      b.kind === 'resume'
        ? el('div', { className: 'adm-field' }, [el('span', { className: 'adm-label', textContent: 'Destination (fixed)' }), el('p', { className: 'adm-readonly', textContent: 'Opens the Resume viewer' })])
        : textField(`h-cta-${i}-href`, b.kind === 'anchor' ? 'Section (starts with #)' : 'Destination (https://)', b.href, 200),
    ]),
  ])));

  $('h-metrics').replaceChildren(...p.metrics_strip.map((m, i) => el('div', { className: 'adm-row' }, [
    textField(`h-m-${i}-value`, `Metric ${i + 1} value`, m.value, 40),
    textField(`h-m-${i}-label`, `Metric ${i + 1} label`, m.label, 40),
  ])));

  $('h-stats').replaceChildren(...p.stats.map((s, i) => el('div', { className: 'adm-row' }, [
    textField(`h-s-${i}-value`, `Counter ${i + 1} number`, s.value, 6),
    textField(`h-s-${i}-suffix`, 'Suffix', s.suffix, 12),
    textField(`h-s-${i}-label`, 'Label', s.label, 60),
  ])));
}

function heroToPayload(row) {
  return {
    name: row.name, eyebrow: row.eyebrow ?? '', role_line: row.role_line, positioning: row.positioning,
    proof_line: row.proof_line ?? '', credibility_line: row.credibility_line, quote: row.quote ?? '',
    cta_buttons: row.cta_buttons || [], metrics_strip: row.metrics_strip || [], stats: row.stats || [],
  };
}

function fillHero(p) {
  $('h-name').value = p.name;
  $('h-eyebrow').value = p.eyebrow;
  $('h-role').value = p.role_line;
  $('h-positioning').value = p.positioning;
  $('h-proof').value = p.proof_line;
  $('h-cred').value = p.credibility_line;
  $('h-quote').value = p.quote;
  renderHeroRows(p);
}

// Build the draft from the form. Resume buttons keep their stored destination.
function collectHero() {
  const base = heroSaved;
  return {
    name: $('h-name').value.trim(),
    eyebrow: $('h-eyebrow').value.trim(),
    role_line: $('h-role').value.trim(),
    positioning: $('h-positioning').value.trim(),
    proof_line: $('h-proof').value.trim(),
    credibility_line: $('h-cred').value.trim(),
    quote: $('h-quote').value.trim(),
    cta_buttons: base.cta_buttons.map((b, i) => ({
      kind: b.kind,
      label: ($(`h-cta-${i}-label`)?.value ?? b.label).trim(),
      href: b.kind === 'resume' ? b.href : ($(`h-cta-${i}-href`)?.value ?? b.href).trim(),
    })),
    metrics_strip: base.metrics_strip.map((_, i) => ({
      value: $(`h-m-${i}-value`).value.trim(), label: $(`h-m-${i}-label`).value.trim(),
    })),
    stats: base.stats.map((_, i) => ({
      value: $(`h-s-${i}-value`).value.trim(), suffix: $(`h-s-${i}-suffix`).value.trim(), label: $(`h-s-${i}-label`).value.trim(),
    })),
  };
}

// Mirrors the database limits. The database still enforces them on save.
function validateHero(p) {
  const req = [['name', 'Name'], ['eyebrow', 'Eyebrow line'], ['role_line', 'Role line'],
    ['positioning', 'Positioning statement'], ['credibility_line', 'Credibility line']];
  for (const [k, label] of req) {
    if (!p[k]) return `${label} is required.`;
  }
  for (const [k, max] of Object.entries(HERO_MAX)) {
    if (p[k] && p[k].length > max) return `${k.replace(/_/g, ' ')} must be ${max} characters or fewer.`;
  }
  for (const b of p.cta_buttons) {
    if (!b.label) return 'Each button needs a label.';
    if (b.label.length > 60) return 'Button labels must be 60 characters or fewer.';
    if (b.kind === 'anchor' && !/^#[a-z][a-z0-9-]*$/i.test(b.href)) return 'Section links must look like #career.';
    if (b.kind === 'external' && !/^https:\/\/\S+$/.test(b.href)) return 'External links must start with https://.';
  }
  for (const m of p.metrics_strip) {
    if (!m.value || !m.label) return 'Each metric needs a value and a label.';
    if (m.value.length > 40 || m.label.length > 40) return 'Metric values and labels must be 40 characters or fewer.';
  }
  for (const s of p.stats) {
    if (!/^\d{1,6}$/.test(s.value)) return 'Counter numbers must be whole numbers.';
    if (s.suffix.length > 12) return 'Counter suffixes must be 12 characters or fewer.';
    if (!s.label || s.label.length > 60) return 'Each counter needs a label of 60 characters or fewer.';
  }
  return '';
}

function heroIsDirty() {
  return heroSaved !== null && JSON.stringify(collectHero()) !== JSON.stringify(heroSaved);
}

function updateHeroStatus() {
  if (!heroSaved) return;
  msg($('h-status'), heroIsDirty() ? 'You have unsaved changes. They are not saved as a draft yet.' : 'Draft loaded. Matches the saved draft.', heroIsDirty() ? '' : 'ok');
}

async function loadHero() {
  msg($('h-status'), 'Loading hero draft…');
  const { data, error } = await sb.from('hero').select('*').eq('id', 1).maybeSingle();
  if (error) {
    console.error(error);
    msg($('h-status'), 'Could not load the hero draft. Check your connection and try again.', 'err');
    return;
  }
  if (!data) {
    msg($('h-status'), 'No hero draft exists yet. The initial content seed has not been run.', 'err');
    return;
  }
  heroSaved = heroToPayload(data);
  fillHero(heroSaved);
  updateHeroStatus();
}

function saveErrorText(error) {
  console.error(error);
  if (error.code === '23514') return 'One value is outside the allowed limits. Check the fields and try again.';
  if (error.code === '42501') return 'You are not authorised to save. Sign in again.';
  return 'Could not save the draft. Your edits are still on screen. Try again.';
}

$('form-hero').addEventListener('input', updateHeroStatus);

$('form-hero').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = collectHero();
  const problem = validateHero(payload);
  if (problem) {
    msg($('h-msg'), problem, 'err');
    return;
  }
  const button = $('h-save');
  busy(button, true, 'Save draft');
  const { data, error } = await sb.from('hero').update(payload).eq('id', 1).select().single();
  busy(button, false, 'Save draft');
  if (error) {
    msg($('h-msg'), saveErrorText(error), 'err');
    return;
  }
  heroSaved = heroToPayload(data);
  fillHero(heroSaved);
  msg($('h-msg'), 'Draft saved. The live website has not changed.', 'ok');
  updateHeroStatus();
});

$('h-discard').addEventListener('click', async () => {
  msg($('h-msg'), '');
  await loadHero();
});

// Warn before leaving the page with unsaved hero edits.
window.addEventListener('beforeunload', (e) => {
  if (heroIsDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

const linkError = linkErrorFromUrl();
if (linkError) msg($('signin-msg'), linkError, 'err');
route();
