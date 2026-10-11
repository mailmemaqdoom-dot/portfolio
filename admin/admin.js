import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Implicit flow: the magic link returns tokens in the URL, so it works on any device.
// Token validation is still performed by Supabase.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
});

let pendingEmail = '';
let routing = false;

function show(view) {
  for (const v of ['signin', 'denied', 'dashboard']) $(`view-${v}`).hidden = v !== view;
  $('btn-signout').hidden = view !== 'dashboard';
}

function msg(el, text, kind = '') {
  el.textContent = text;
  el.className = `adm-msg ${kind}`.trim();
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = busy ? 'Please wait…' : label;
}

// Read an error from a magic-link redirect (expired, reused or invalid link).
function linkErrorFromUrl() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const search = new URLSearchParams(window.location.search);
  const code = hash.get('error_code') || search.get('error_code');
  const desc = hash.get('error_description') || search.get('error_description') || '';
  if (!code && !hash.get('error') && !search.get('error')) return '';
  history.replaceState(null, '', window.location.pathname);
  return code === 'otp_expired'
    ? 'This sign-in link has expired or was already used. Request a new code below.'
    : `Sign-in did not complete${desc ? `: ${desc.replace(/\+/g, ' ')}` : '.'} Request a new code below.`;
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

// Decide what to show. Signed-in is not enough: the database must confirm administrator status.
async function route() {
  if (routing) return;
  routing = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      show('signin');
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

// Step 1: request a code. Identical wording whether or not the address is authorised,
// so the form does not reveal which addresses have accounts.
$('form-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('inp-email').value.trim().toLowerCase();
  const out = $('signin-msg');
  if (!EMAIL_RE.test(email)) {
    msg(out, 'Enter a valid email address.', 'err');
    return;
  }
  const button = $('btn-send');
  setBusy(button, true, 'Send sign-in code');
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/admin/` },
  });
  setBusy(button, false, 'Send sign-in code');
  if (error && !/signups? not allowed|user not found|rate limit|too many/i.test(error.message)) {
    msg(out, 'Something went wrong sending the code. Please try again.', 'err');
    return;
  }
  if (error && /rate limit|too many/i.test(error.message)) {
    msg(out, 'Too many requests. Wait a few minutes before requesting another code.', 'err');
    return;
  }
  pendingEmail = email;
  $('form-email').hidden = true;
  $('form-code').hidden = false;
  $('signin-lead').textContent = 'If this address is authorised, a code has been sent. Enter it below.';
  msg(out, 'Check your inbox. Codes expire after a short time.', 'ok');
  $('inp-code').focus();
});

// Step 2: verify the code. Successful verification only creates a session;
// route() then confirms administrator status with the database.
$('form-code').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('inp-code').value.replace(/\s+/g, '');
  const out = $('signin-msg');
  if (!/^\d{6,10}$/.test(token)) {
    msg(out, 'Enter the code exactly as it appears in the email.', 'err');
    return;
  }
  const button = $('btn-verify');
  setBusy(button, true, 'Verify and sign in');
  const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });
  setBusy(button, false, 'Verify and sign in');
  if (error) {
    // Supabase reports invalid and expired codes with the same wording, so use one message for both.
    msg(out, 'That code is invalid or has expired. Check it and try again, or request a new code.', 'err');
    $('inp-code').select();
    return;
  }
  msg(out, '');
});

$('btn-back').addEventListener('click', () => {
  $('form-code').hidden = true;
  $('form-email').hidden = false;
  $('inp-code').value = '';
  $('signin-lead').textContent = 'Enter your email address and we will send you a one-time sign-in code.';
  msg($('signin-msg'), '');
});

$('btn-signout').addEventListener('click', async () => {
  await sb.auth.signOut();
});

$('btn-denied-back').addEventListener('click', () => {
  show('signin');
  msg($('signin-msg'), '');
});

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') route();
});

// Initial load: show any link error first, then route on the stored session.
const linkError = linkErrorFromUrl();
if (linkError) msg($('signin-msg'), linkError, 'err');
route();
