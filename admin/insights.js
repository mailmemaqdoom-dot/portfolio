// Analytics centre. Reads only the aggregated report from analytics_summary (admin-only).
// Every number comes from collected events. Empty ranges show empty states, never sample data.
// All dates are UTC because the collector stores UTC.
import { $, el, fmtDate, setMsg } from './util.js';

let sb = null;
let mode = '30';
let report = null;

const CLICK_LABEL = {
  resume_view: 'Résumé viewer opened',
  resume_download: 'Résumé downloads',
  whatsapp: 'WhatsApp',
  linkedin: 'LinkedIn',
  email: 'Email',
  phone: 'Telephone',
  cta: 'Main buttons',
};
const CONTACT_TARGETS = ['whatsapp', 'linkedin', 'email', 'phone'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function init(client) {
  sb = client;
  wire();
}

function wire() {
  document.querySelectorAll('#an-range .adm-chip').forEach((chip) => chip.addEventListener('click', () => {
    mode = chip.dataset.range;
    document.querySelectorAll('#an-range .adm-chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    $('an-custom').hidden = mode !== 'custom';
    if (mode !== 'custom') load();
  }));
  $('an-apply').addEventListener('click', () => {
    if (!$('an-from').value || !$('an-to').value) {
      setMsg($('an-msg'), 'Choose both a start and an end date.', 'err');
      return;
    }
    load();
  });
  $('an-export').addEventListener('click', exportCsv);
}

const utcDay = (d) => d.toISOString().slice(0, 10);

function todayUtc() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

function currentRange() {
  const end = todayUtc();
  if (mode === 'custom') return { from: $('an-from').value, to: $('an-to').value };
  if (mode === 'ytd') return { from: utcDay(new Date(Date.UTC(end.getUTCFullYear(), 0, 1))), to: utcDay(end) };
  const days = Number(mode);
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return { from: utcDay(start), to: utcDay(end) };
}

export async function load() {
  const { from, to } = currentRange();
  // Drop the previous report first, so an export cannot download an older range while this one loads.
  report = null;
  setMsg($('an-msg'), 'Loading…');
  const { data, error } = await sb.rpc('analytics_summary', { p_from: from, p_to: to });
  if (error) {
    report = null;
    render(null);
    const text = error.code === '42501' ? 'You are not authorised to view analytics.'
      : error.code === '22023' ? 'That date range is not valid. The end date must be on or after the start date, and the range can be at most two years.'
        : 'Analytics could not be loaded. Check your connection and try again.';
    setMsg($('an-msg'), text, 'err');
    return;
  }
  report = data;
  setMsg($('an-msg'), '');
  render(report);
}

// ---------- Rendering helpers ----------

function pct(cur, prev) {
  if (!prev) return cur ? 'No data in the previous period' : 'No data in either period';
  const change = ((cur - prev) / prev) * 100;
  const sign = change > 0 ? '+' : '';
  return `${sign}${change.toFixed(0)}% vs previous period`;
}

function kpi(label, value, note) {
  return el('article', { className: 'adm-card adm-kpi' }, [
    el('span', { className: 'adm-kpi-label', textContent: label }),
    el('span', { className: 'adm-kpi-value', textContent: value }),
    el('span', { className: 'adm-kpi-note', textContent: note }),
  ]);
}

function emptyState(text) {
  return el('p', { className: 'adm-empty', textContent: text });
}

// Vertical bars. Each bar carries its label as a tooltip and as an accessible name.
function columnChart(container, items, peakIndex) {
  const max = Math.max(1, ...items.map((i) => i.value));
  container.replaceChildren(...items.map((item, idx) => {
    const h = Math.round((item.value / max) * 100);
    return el('div', {
      className: `adm-col${idx === peakIndex && item.value > 0 ? ' peak' : ''}`,
      title: `${item.label}: ${item.value}`,
    }, [
      el('span', { className: 'adm-col-bar', style: `height:${h}%` }),
      el('span', { className: 'adm-col-label', textContent: item.axis ?? '' }),
    ]);
  }));
}

function hbars(container, rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  container.replaceChildren(...rows.map((r) => el('div', { className: 'adm-hbar' }, [
    el('span', { className: 'adm-hbar-label', textContent: r.label }),
    el('span', { className: 'adm-track' }, [el('span', { className: 'adm-fill', style: `width:${Math.round((r.value / max) * 100)}%` })]),
    el('span', { className: 'adm-hbar-value', textContent: String(r.value) }),
  ])));
}

function listOrEmpty(container, rows, emptyText) {
  if (!rows.length) container.replaceChildren(emptyState(emptyText));
  else hbars(container, rows);
}

// ---------- Main render ----------

function render(r) {
  const empty = !r || !r.totals || (r.totals.page_views + r.totals.clicks) === 0;
  $('an-empty').hidden = !empty;
  $('an-body').hidden = empty;
  const first = r?.first_event;
  $('an-since').textContent = first
    ? `Collecting since ${fmtDate(first)} (UTC). Nothing before that date is recorded.`
    : 'Collection has not recorded any visits yet.';
  if (!r) return;
  if (empty) {
    $('an-empty').replaceChildren(emptyState(`No visits or clicks recorded between ${r.range.from} and ${r.range.to}.`));
    return;
  }

  const t = r.totals;
  const p = r.previous_totals;
  const contact = (r.clicks || []).filter((c) => CONTACT_TARGETS.includes(c.target)).reduce((s, c) => s + Number(c.clicks), 0);
  const downloads = (r.clicks || []).find((c) => c.target === 'resume_download')?.clicks ?? 0;

  $('an-kpis').replaceChildren(
    kpi('Page views', String(t.page_views), pct(t.page_views, p.page_views)),
    kpi('Daily visitors, summed', String(t.visitors), pct(t.visitors, p.visitors)),
    kpi('Clicks on tracked links', String(t.clicks), pct(t.clicks, p.clicks)),
    kpi('Résumé downloads', String(downloads), 'Download links clicked'),
    kpi('Contact clicks', String(contact), 'WhatsApp, LinkedIn, email and phone'),
  );

  // One bar per day, including zero days, so gaps are visible.
  const dayIndex = new Map((r.daily || []).map((d) => [d.d, d]));
  const total = daysBetween(r.range.from, r.range.to);
  const step = Math.max(1, Math.ceil(total / 6));
  const series = [];
  for (let i = 0; i < total; i++) {
    const key = utcDay(new Date(new Date(r.range.from + 'T00:00:00Z').getTime() + i * 86400000));
    const row = dayIndex.get(key);
    series.push({ label: key, value: row ? Number(row.views) : 0, axis: i % step === 0 ? key.slice(5) : '' });
  }
  const peakDay = series.reduce((best, s, i) => (s.value > (series[best]?.value ?? -1) ? i : best), 0);
  columnChart($('an-daily'), series, peakDay);
  $('an-peak-day').textContent = series[peakDay]?.value > 0
    ? `Peak day: ${series[peakDay].label} with ${series[peakDay].value} page views`
    : 'No peak day yet.';

  const weekdays = WEEKDAYS.map((name, i) => {
    const hit = (r.weekday || []).find((w) => Number(w.dow) === i + 1);
    return { label: name, value: hit ? Number(hit.views) : 0, axis: name };
  });
  const wPeak = weekdays.reduce((best, s, i) => (s.value > weekdays[best].value ? i : best), 0);
  columnChart($('an-weekday'), weekdays, wPeak);

  const hours = Array.from({ length: 24 }, (_, h) => {
    const hit = (r.hour || []).find((x) => Number(x.h) === h);
    return { label: `${String(h).padStart(2, '0')}:00 UTC`, value: hit ? Number(hit.views) : 0, axis: h % 6 === 0 ? String(h).padStart(2, '0') : '' };
  });
  const hPeak = hours.reduce((best, s, i) => (s.value > hours[best].value ? i : best), 0);
  columnChart($('an-hour'), hours, hPeak);

  $('an-busy').textContent = [
    weekdays[wPeak].value ? `Busiest weekday by total page views: ${WEEKDAYS[wPeak]}. Short ranges contain some weekdays more often than others.` : 'No weekday pattern yet.',
    hours[hPeak].value ? `Peak hour: ${hours[hPeak].label}.` : '',
  ].join(' ');

  // Traffic sources
  listOrEmpty($('an-channels'), (r.channels || []).map((c) => ({ label: c.channel, value: Number(c.views) })), 'No page views in this range.');
  listOrEmpty($('an-referrers'), (r.referrers || []).map((x) => ({ label: x.host, value: Number(x.views) })), 'No referring websites in this range.');
  const campaigns = (r.campaigns || []).map((c) => ({
    label: [c.utm_campaign, c.utm_source, c.utm_medium].filter(Boolean).join(' · '),
    value: Number(c.views),
  }));
  listOrEmpty($('an-campaigns'), campaigns, 'No campaign-tagged links were used in this range.');

  // Content engagement
  listOrEmpty($('an-pages'), (r.pages || []).map((x) => ({ label: x.path, value: Number(x.views) })), 'No page views in this range.');
  listOrEmpty($('an-clicks'), (r.clicks || []).map((c) => ({ label: CLICK_LABEL[c.target] || c.target, value: Number(c.clicks) })), 'No tracked clicks in this range.');

  // Devices
  listOrEmpty($('an-devices'), (r.devices || []).map((x) => ({ label: cap(x.device), value: Number(x.views) })), 'No page views in this range.');
  listOrEmpty($('an-browsers'), (r.browsers || []).map((x) => ({ label: x.browser, value: Number(x.views) })), 'No page views in this range.');
  listOrEmpty($('an-os'), (r.operating_systems || []).map((x) => ({ label: x.os, value: Number(x.views) })), 'No page views in this range.');

  $('an-compare').textContent = `Compared with ${r.range.previous_from} to ${r.range.previous_to}.`;
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000) + 1;
}

// ---------- CSV export (aggregated daily counts for the selected range) ----------

function exportCsv() {
  if (!report || !report.totals) {
    setMsg($('an-msg'), 'Load a range with data before exporting.', 'err');
    return;
  }
  // Each row is one UTC day. daily_visitors counts visitors per day, so it is not unique visitors.
  const rows = [['date_utc', 'page_views', 'daily_visitors', 'clicks']];
  // Every day in the selected range appears, including days with no activity (zeros), as in the chart.
  const byDay = new Map((report.daily || []).map((d) => [d.d, d]));
  const total = daysBetween(report.range.from, report.range.to);
  for (let i = 0; i < total; i++) {
    const key = utcDay(new Date(new Date(report.range.from + 'T00:00:00Z').getTime() + i * 86400000));
    const d = byDay.get(key);
    rows.push([key, d ? d.views : 0, d ? d.visitors : 0, d ? d.clicks : 0]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `analytics_${report.range.from}_${report.range.to}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
