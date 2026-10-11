import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Implicit flow: the sign-in link returns tokens in the URL, so it works on any device.
// Token validation is still performed by Supabase.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
});

let routing = false;

function show(view) {
  for (const v of ['signin', 'denied', 'dashboard']) $(`view-${v}`).hidden = v !== view;
  $('btn-signout').hidden = view !== 'dashboard';
}

function msg(el, text, kind = '') {
  el.textContent = text;
  el.className = `adm-msg ${kind}`.trim();
}

// Read an error returned by a sign-in link (expired, reused or invalid).
function linkErrorFromUrl() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const search = new URLSearchParams(window.location.search);
  const code = hash.get('error_code') || search.get('error_code');
  const desc = hash.get('error_description') || search.get('error_description') || '';
  if (!code && !hash.get('error') && !search.get('error')) return '';
  history.replaceState(null, '', window.location.pathname);
  return code === 'otp_expired'
    ? 'This sign-in link has expired or was already used. Request a new link below.'
    : `Sign-in did not complete${desc ? `: ${desc.replace(/\+/g, ' ')}` : '.'} Request a new link below.`;
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

// Request a sign-in link. The same message is shown whether or not the address is
// authorised, so the form does not reveal which addresses have accounts.
$('form-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('inp-email').value.trim().toLowerCase();
  const out = $('signin-msg');
  if (!EMAIL_RE.test(email)) {
    msg(out, 'Enter a valid email address.', 'err');
    return;
  }
  const button = $('btn-send');
  button.disabled = true;
  button.textContent = 'Please wait…';
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/admin/` },
  });
  button.textContent = 'Send sign-in link';
  if (error && /rate limit|too many/i.test(error.message)) {
    msg(out, 'Too many requests. Wait a few minutes before requesting another link.', 'err');
    button.disabled = false;
    return;
  }
  if (error && !/signups? not allowed|user not found/i.test(error.message)) {
    msg(out, 'Something went wrong sending the link. Please try again.', 'err');
    button.disabled = false;
    return;
  }
  msg(out, 'If this address is authorised, a sign-in link has been sent. Open it in your inbox on any device.', 'ok');
  // Short cooldown to prevent repeated sends.
  setTimeout(() => { button.disabled = false; }, 30000);
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

const linkError = linkErrorFromUrl();
if (linkError) msg($('signin-msg'), linkError, 'err');
route();
