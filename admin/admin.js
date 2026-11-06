import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';
import * as ops from './ops.js';
import * as media from './media.js';
import * as resume from './resume.js';
import { $ } from './util.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 12;

// Implicit flow: sign-in and reset links return tokens in the URL, so they work on any device.
// Token validation is still performed by Supabase.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
});

ops.init(sb);
media.init(sb);
resume.init(sb);

let routing = false;
let recoveryMode = false;
let currentPanel = 'overview';

const PANELS = ['overview', 'content', 'hero', 'media', 'resume', 'health', 'activity', 'analytics', 'publishing', 'settings', 'account'];

function show(view) {
  for (const v of ['signin', 'recovery', 'denied', 'dashboard']) $(`view-${v}`).hidden = v !== view;
  const inside = view === 'dashboard';
  for (const id of ['btn-signout', 'btn-menu', 'cmd-search', 'btn-avatar']) $(id).hidden = !inside;
  if (!inside) closeNav();
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
    const email = session.user.email ?? '–';
    $('acct-email').textContent = email;
    $('acct-email-full').textContent = email;
    $('btn-avatar').textContent = email === '–' ? 'A' : email.charAt(0).toUpperCase();
    show('dashboard');
    greet();
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

// Set or change the password from the account panel (requires an active administrator session).
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

const signOut = async () => { await sb.auth.signOut(); };
$('btn-signout').addEventListener('click', signOut);
$('btn-settings-signout').addEventListener('click', signOut);

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

// ---------- Dashboard shell: navigation, drawer, search, theme, greeting ----------

function greet() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('dash-title').textContent = `${part}, Mohamed`;
  $('today').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function setPanel(name) {
  if (!PANELS.includes(name)) name = 'overview';
  if (name !== currentPanel && currentPanel === 'hero' && heroIsDirty()
      && !window.confirm('Leave without saving your hero edits? They are not saved as a draft yet.')) {
    return;
  }
  currentPanel = name;
  for (const p of PANELS) {
    const node = $(`panel-${p}`);
    if (node) node.hidden = p !== name;
  }
  document.querySelectorAll('.adm-side .adm-navbtn').forEach((b) => {
    const on = b.dataset.panel === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  closeNav();
  if (name === 'overview') ops.loadOverview();
  if (name === 'hero') loadHero();
  if (name === 'media') media.load();
  if (name === 'resume') resume.load();
  if (name === 'health') ops.runChecks();
  if (name === 'activity') ops.loadActivity();
}

// Any element with data-panel navigates (sidebar, overview shortcuts, content list).
document.querySelectorAll('[data-panel]').forEach((b) => {
  b.addEventListener('click', () => setPanel(b.dataset.panel));
});

// Mobile drawer
const side = $('side-nav');
const scrim = $('scrim');
function openNav() {
  side.classList.add('open');
  scrim.hidden = false;
  $('btn-menu').setAttribute('aria-expanded', 'true');
}
function closeNav() {
  side.classList.remove('open');
  scrim.hidden = true;
  $('btn-menu').setAttribute('aria-expanded', 'false');
}
$('btn-menu').addEventListener('click', () => (side.classList.contains('open') ? closeNav() : openNav()));
scrim.addEventListener('click', closeNav);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });

// Page search: Enter opens the first matching page.
$('cmd-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim().toLowerCase();
  if (!q) return;
  const match = [...document.querySelectorAll('.adm-side .adm-navbtn')]
    .find((b) => b.textContent.trim().toLowerCase().includes(q));
  if (match) {
    e.target.value = '';
    setPanel(match.dataset.panel);
  }
});

$('btn-avatar').addEventListener('click', () => setPanel('account'));

// Theme: system by default, or a choice remembered on this device only.
const THEME_KEY = 'adm-theme';
function applyTheme(value) {
  const root = document.documentElement;
  if (value === 'light' || value === 'dark') root.setAttribute('data-theme', value);
  else root.removeAttribute('data-theme');
  $('theme-select').value = value;
}
function storedTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}
$('theme-select').addEventListener('change', (e) => {
  try { localStorage.setItem(THEME_KEY, e.target.value); } catch { /* storage unavailable: choice applies for this visit */ }
  applyTheme(e.target.value);
});
$('theme-select').hidden = false;
applyTheme(storedTheme());

// ---------- Hero editor (drafts only) ----------

const HERO_MAX = { name: 80, eyebrow: 120, role_line: 200, positioning: 400, proof_line: 400, credibility_line: 160, quote: 300 };
const KIND_TEXT = { anchor: 'Section link', resume: 'Resume viewer', external: 'External link' };
let heroSaved = null;

function heroEl(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of children) n.append(c);
  return n;
}

function textField(id, label, value, max, multiline = false) {
  const input = heroEl(multiline ? 'textarea' : 'input', { id, value: multiline ? '' : value, maxLength: max, className: `adm-input${multiline ? ' adm-textarea' : ''}` });
  if (multiline) input.value = value;
  if (!multiline) input.type = 'text';
  return heroEl('div', { className: 'adm-field' }, [heroEl('label', { className: 'adm-label', htmlFor: id, textContent: label }), input]);
}

function renderHeroRows(p) {
  const cta = $('h-cta');
  cta.replaceChildren(...p.cta_buttons.map((b, i) => heroEl('div', { className: 'adm-row-card' }, [
    heroEl('p', { className: 'adm-note', textContent: `Button ${i + 1} · ${KIND_TEXT[b.kind] || b.kind}` }),
    heroEl('div', { className: 'adm-row' }, [
      textField(`h-cta-${i}-label`, 'Label', b.label, 60),
      b.kind === 'resume'
        ? heroEl('div', { className: 'adm-field' }, [heroEl('span', { className: 'adm-label', textContent: 'Destination (fixed)' }), heroEl('p', { className: 'adm-readonly', textContent: 'Opens the Resume viewer' })])
        : textField(`h-cta-${i}-href`, b.kind === 'anchor' ? 'Section (starts with #)' : 'Destination (https://)', b.href, 200),
    ]),
  ])));

  $('h-metrics').replaceChildren(...p.metrics_strip.map((m, i) => heroEl('div', { className: 'adm-row' }, [
    textField(`h-m-${i}-value`, `Metric ${i + 1} value`, m.value, 40),
    textField(`h-m-${i}-label`, `Metric ${i + 1} label`, m.label, 40),
  ])));

  $('h-stats').replaceChildren(...p.stats.map((s, i) => heroEl('div', { className: 'adm-row' }, [
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
