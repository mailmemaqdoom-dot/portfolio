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

const linkError = linkErrorFromUrl();
if (linkError) msg($('signin-msg'), linkError, 'err');
route();
