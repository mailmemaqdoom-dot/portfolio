import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';
import * as ops from './ops.js';
import * as media from './media.js';
import * as resume from './resume.js';
import * as insights from './insights.js';
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
insights.init(sb);

let routing = false;
let recoveryMode = false;
let currentPanel = 'overview';

const PANELS = ['overview', 'content', 'hero', 'media', 'resume', 'health', 'activity', 'analytics', 'publishing', 'settings', 'account'];

function show(view) {
  for (const v of ['signin', 'recovery', 'denied', 'dashboard']) $(`view-${v}`).hidden = v !== view;
  const inside = view === 'dashboard';
  for (const id of ['btn-menu', 'cmd-search', 'acct-wrap']) $(id).hidden = !inside;
  if (!inside) {
    closeNav();
    closeAcctMenu();
  }
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
      stopIdle();
      if (takeExpiredNotice()) {
        msg($('signin-msg'), 'Your session ended after 15 minutes without activity. Sign in again to continue.', 'err');
      }
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
    $('menu-email').textContent = email;
    show('dashboard');
    greet();
    setPanel('overview');
    loadDatabaseStatus();
    startIdle();
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
  if (name === 'analytics') insights.load();
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


// Theme: follows the system until the administrator chooses. Stored on this device only,
// under its own key, so it is independent of the public site's theme.
const THEME_KEY = 'adm-theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
function savedTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }
}
function effectiveTheme() {
  return savedTheme() ?? (systemDark.matches ? 'dark' : 'light');
}
function renderTheme() {
  const saved = savedTheme();
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  else document.documentElement.removeAttribute('data-theme');
  const pill = $('thm');
  const current = effectiveTheme();
  pill.classList.toggle('is-light', current === 'light');
  pill.setAttribute('aria-label', current === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
}
function toggleTheme() {
  const next = effectiveTheme() === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable: applies for this visit */ }
  renderTheme();
}
$('thm').addEventListener('click', toggleTheme);
$('thm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleTheme();
  }
});
systemDark.addEventListener('change', () => { if (!savedTheme()) renderTheme(); });
renderTheme();

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

// ---------- Account menu (avatar): account info, account settings, sign out at the bottom ----------

const avatar = $('btn-avatar');
const acctMenu = $('acct-menu');

function openAcctMenu() {
  acctMenu.hidden = false;
  avatar.setAttribute('aria-expanded', 'true');
  $('menu-account').focus();
}

function closeAcctMenu() {
  acctMenu.hidden = true;
  avatar.setAttribute('aria-expanded', 'false');
  $('signout-confirm').hidden = true;
}

avatar.addEventListener('click', (e) => {
  e.stopPropagation();
  if (acctMenu.hidden) openAcctMenu();
  else closeAcctMenu();
});
document.addEventListener('click', (e) => {
  if (!acctMenu.hidden && !$('acct-wrap').contains(e.target)) closeAcctMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !acctMenu.hidden) {
    closeAcctMenu();
    avatar.focus();
  }
});
$('menu-account').addEventListener('click', () => {
  closeAcctMenu();
  setPanel('account');
});
// Sign out is a two-step action: the menu asks for confirmation before ending the session.
$('btn-signout').addEventListener('click', () => {
  $('signout-confirm').hidden = false;
  $('signout-yes').focus();
});
$('signout-no').addEventListener('click', () => {
  $('signout-confirm').hidden = true;
  $('btn-signout').focus();
});
$('signout-yes').addEventListener('click', () => {
  closeAcctMenu();
  signOut();
});

// ---------- Inactivity: sign out after 15 minutes without genuine activity; warn at 13 minutes ----------

const IDLE_MS = 15 * 60 * 1000;
const WARN_MS = 2 * 60 * 1000;
const ACTIVITY_KEY = 'adm-last-activity';   // shared by every tab of this browser
const EXPIRED_KEY = 'adm-expired';          // one-time notice on the sign-in screen
let lastActivity = Date.now();
let lastWrite = 0;
let idleTimer = null;
let idleOn = false;

function lastKnownActivity() {
  let shared = 0;
  try { shared = Number(localStorage.getItem(ACTIVITY_KEY)) || 0; } catch { /* storage unavailable */ }
  return Math.max(lastActivity, shared);
}

// Only genuine input calls this. Timers and polling never do.
function recordActivity(e) {
  if (!idleOn) return;
  // Input inside the warning is handled by its own buttons and must not dismiss it by accident.
  if (e && $('idle-modal').contains(e.target)) return;
  const now = Date.now();
  lastActivity = now;
  if (now - lastWrite > 5000) {
    lastWrite = now;
    try { localStorage.setItem(ACTIVITY_KEY, String(now)); } catch { /* ignore */ }
  }
  hideWarning();
}

function showWarning(msLeft, pending) {
  const modal = $('idle-modal');
  const wasHidden = modal.hidden;
  modal.hidden = false;
  $('idle-secs').textContent = String(Math.max(0, Math.ceil(msLeft / 1000)));
  $('idle-pending').hidden = !pending;
  if (wasHidden) $('idle-stay').focus();
}

function hideWarning() {
  $('idle-modal').hidden = true;
}

function checkIdle() {
  if (!idleOn) return;
  // An upload in progress, or edits not yet saved, is never signed out from under the user.
  const pending = heroIsDirty();
  if (media.isBusy() || resume.isBusy()) {
    recordActivity();
    return;
  }
  const idle = Date.now() - lastKnownActivity();
  if (idle >= IDLE_MS) {
    if (pending) {
      showWarning(0, true);   // hold the session until the edits are saved or the user chooses
      return;
    }
    expireSession();
    return;
  }
  if (idle >= IDLE_MS - WARN_MS) showWarning(IDLE_MS - idle, pending);
  else hideWarning();
}

async function expireSession() {
  stopIdle();
  try { sessionStorage.setItem(EXPIRED_KEY, '1'); } catch { /* ignore */ }
  // Clears the local Supabase session. The SIGNED_OUT event then returns to the sign-in screen.
  await sb.auth.signOut();
}

function takeExpiredNotice() {
  try {
    const flagged = sessionStorage.getItem(EXPIRED_KEY) === '1';
    sessionStorage.removeItem(EXPIRED_KEY);
    return flagged;
  } catch { return false; }
}

function startIdle() {
  if (idleOn) return;
  idleOn = true;
  recordActivity();
  idleTimer = setInterval(checkIdle, 1000);   // reads timestamps only; it does not count as activity
}

function stopIdle() {
  idleOn = false;
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  hideWarning();
}

['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((type) => {
  window.addEventListener(type, recordActivity, { capture: true, passive: true });
});
// Activity in another tab extends this tab's session too.
window.addEventListener('storage', (e) => { if (e.key === ACTIVITY_KEY) checkIdle(); });

$('idle-stay').addEventListener('click', () => {
  recordActivity();
  hideWarning();
});
$('idle-out').addEventListener('click', () => {
  stopIdle();
  signOut();
});

// ---------- Sidebar: icons, keyboard focus and optional pin ----------

const ICON_PATHS = {
  overview: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  content: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>',
  hero: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  media: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  resume: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  health: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  activity: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  analytics: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  publishing: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  account: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>',
};

document.querySelectorAll('.adm-navbtn[data-icon]').forEach((b) => {
  const icon = document.createElement('span');
  icon.className = 'adm-navicon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `<svg viewBox="0 0 24 24">${ICON_PATHS[b.dataset.icon] ?? ''}</svg>`;
  b.prepend(icon);
});

// KPI cards carry a meaningful icon. Decorative only; the figures come from the database.
document.querySelectorAll('.adm-kpi[data-icon]').forEach((card) => {
  const icon = document.createElement('span');
  icon.className = 'adm-kpi-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `<svg viewBox="0 0 24 24">${ICON_PATHS[card.dataset.icon] ?? ''}</svg>`;
  card.prepend(icon);
});

const PIN_KEY = 'adm-sidebar-pinned';
let pinned = false;
try { pinned = localStorage.getItem(PIN_KEY) === '1'; } catch { /* storage unavailable */ }

function renderPin(on) {
  const pin = $('side-pin');
  pin.classList.toggle('on', on);
  pin.setAttribute('aria-pressed', String(on));
  pin.title = on ? 'Let the sidebar collapse' : 'Keep the sidebar open';
  pin.querySelector('.adm-navlabel').textContent = on ? 'Sidebar kept open' : 'Keep sidebar open';
  $('side-nav').classList.toggle('pinned', on);
  document.querySelector('.adm-shell').classList.toggle('pinned', on);
}

$('side-pin').addEventListener('click', () => {
  pinned = !pinned;
  try { localStorage.setItem(PIN_KEY, pinned ? '1' : '0'); } catch { /* ignore */ }
  renderPin(pinned);
});
renderPin(pinned);

const linkError = linkErrorFromUrl();
if (linkError) msg($('signin-msg'), linkError, 'err');
route();
