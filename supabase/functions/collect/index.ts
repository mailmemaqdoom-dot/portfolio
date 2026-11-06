// collect: receives privacy-limited website events and writes them to analytics_events.
// Stores no IP address, no user-agent string and no cookies.
// visitor_hash = HMAC(server key, UTC date | IP | user agent). It changes every day.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const ALLOWED_ORIGIN = 'https://mohamedmagdoom.pages.dev';
const SITE_HOST = 'mohamedmagdoom.pages.dev';
const TARGETS = new Set(['resume_download', 'resume_view', 'whatsapp', 'linkedin', 'email', 'phone', 'cta']);
const PATH_RE = /^\/[A-Za-z0-9._\/-]{0,199}$/;
const HOST_RE = /^[a-z0-9.-]{1,200}$/;
const UTM_RE = /[^A-Za-z0-9 _.+-]/g;
const BOT_RE = /bot|crawl|spider|slurp|headless|preview|lighthouse|monitor|curl|wget|python|go-http|node-fetch|facebookexternalhit/i;
const RATE_LIMIT_PER_HOUR = 200;        // per daily visitor marker
const GLOBAL_LIMIT_PER_HOUR = 5000;     // all visitors together, protects the database
const DUPLICATE_WINDOW_SECONDS = { pageview: 30, click: 10 };
const MAX_BODY_BYTES = 2048;

const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Vary': 'Origin',
};

const enc = new TextEncoder();

async function visitorHash(ip: string, ua: string): Promise<string> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const day = new Date().toISOString().slice(0, 10);
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(`${day}|${ip}|${ua}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function device(ua: string): string {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return /Android/i.test(ua) && !/Mobile/i.test(ua) ? 'tablet' : 'mobile';
  return 'desktop';
}

function browser(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Other';
}

function os(ua: string): string {
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Other';
}

function cleanUtm(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(UTM_RE, '').trim().slice(0, 100);
  return s || null;
}

function referrerHost(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const host = new URL(v).hostname.toLowerCase();
    if (!HOST_RE.test(host)) return null;
    if (host === SITE_HOST) return null;
    return host;
  } catch {
    return null;
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });

  // Browsers send Origin on these beacons, so a request from another website, or one with no
  // Origin, is refused. This stops other sites' scripts. It is not a security control on its
  // own: a non-browser client can set any Origin, so the limits below still apply to it.
  const origin = req.headers.get('origin');
  if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 403, headers: cors });

  const ua = req.headers.get('user-agent') ?? '';
  if (!ua || BOT_RE.test(ua)) return new Response(null, { status: 204, headers: cors });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'payload too large' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'invalid json' });
  }

  const type = body.type;
  if (type !== 'pageview' && type !== 'click') return json(400, { error: 'invalid type' });

  let clickTarget: string | null = null;
  if (type === 'click') {
    if (typeof body.click_target !== 'string' || !TARGETS.has(body.click_target)) {
      return json(400, { error: 'invalid click target' });
    }
    clickTarget = body.click_target;
  }

  // Paths only: query strings and fragments are dropped.
  let path = typeof body.path === 'string' ? body.path.split(/[?#]/)[0] : '/';
  if (!PATH_RE.test(path)) path = '/';

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const hash = await visitorHash(ip, ua);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // Site-wide ceiling.
  const { count: globalCount, error: globalError } = await supabase.from('analytics_events')
    .select('id', { count: 'exact', head: true })
    .gte('occurred_at', hourAgo);
  if (globalError) return json(500, { error: 'unavailable' });
  if ((globalCount ?? 0) >= GLOBAL_LIMIT_PER_HOUR) return json(429, { error: 'too many events' });

  // Per daily visitor marker.
  const { count, error: countError } = await supabase.from('analytics_events')
    .select('id', { count: 'exact', head: true })
    .eq('visitor_hash', hash)
    .gte('occurred_at', hourAgo);
  if (countError) return json(500, { error: 'unavailable' });
  if ((count ?? 0) >= RATE_LIMIT_PER_HOUR) return json(429, { error: 'too many events' });

  // Duplicate prevention: the same visitor sending the same event on the same page within a
  // short window (reloads, double clicks) is accepted but not stored twice.
  const dupSince = new Date(Date.now() - DUPLICATE_WINDOW_SECONDS[type] * 1000).toISOString();
  let dupQuery = supabase.from('analytics_events')
    .select('id', { count: 'exact', head: true })
    .eq('visitor_hash', hash)
    .eq('event_type', type)
    .eq('path', path)
    .gte('occurred_at', dupSince);
  if (clickTarget) dupQuery = dupQuery.eq('click_target', clickTarget);
  const { count: dupCount, error: dupError } = await dupQuery;
  if (dupError) return json(500, { error: 'unavailable' });
  if ((dupCount ?? 0) > 0) return new Response(null, { status: 204, headers: cors });

  const { error } = await supabase.from('analytics_events').insert({
    event_type: type,
    path,
    click_target: clickTarget,
    referrer_host: referrerHost(body.referrer),
    utm_source: cleanUtm(body.utm_source),
    utm_medium: cleanUtm(body.utm_medium),
    utm_campaign: cleanUtm(body.utm_campaign),
    device: device(ua),
    browser: browser(ua),
    os: os(ua),
    visitor_hash: hash,
  });
  if (error) return json(500, { error: 'unavailable' });
  return new Response(null, { status: 204, headers: cors });
});
