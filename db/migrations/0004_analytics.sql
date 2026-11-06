-- 0004_analytics.sql
-- First-party website analytics. Additive only. Nothing here changes published content.
-- Privacy: no IP address, no user-agent string, no cookies. visitor_hash is a keyed hash that
-- changes every day, so it cannot follow a visitor across days.
-- Writes come only from the collect Edge Function (service role). Browsers cannot write.

create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  event_type text not null check (event_type in ('pageview', 'click')),
  path text not null default '/' check (char_length(path) between 1 and 200 and path like '/%'),
  click_target text check (click_target in ('resume_download', 'resume_view', 'whatsapp', 'linkedin', 'email', 'phone', 'cta')),
  referrer_host text check (referrer_host is null or char_length(referrer_host) between 1 and 200),
  utm_source text check (utm_source is null or char_length(utm_source) <= 100),
  utm_medium text check (utm_medium is null or char_length(utm_medium) <= 100),
  utm_campaign text check (utm_campaign is null or char_length(utm_campaign) <= 100),
  device text not null default 'unknown' check (device in ('desktop', 'mobile', 'tablet', 'unknown')),
  browser text not null default 'Other' check (char_length(browser) <= 40),
  os text not null default 'Other' check (char_length(os) <= 40),
  visitor_hash text not null check (char_length(visitor_hash) = 64),
  constraint analytics_click_target_matches check ((event_type = 'click') = (click_target is not null))
);

create index if not exists analytics_events_occurred_idx on public.analytics_events (occurred_at);

alter table public.analytics_events enable row level security;

revoke all on public.analytics_events from anon, authenticated;
grant select on public.analytics_events to authenticated;
grant select, insert on public.analytics_events to service_role;

drop policy if exists analytics_events_admin_read on public.analytics_events;
create policy analytics_events_admin_read on public.analytics_events
  for select to authenticated
  using ((select public.is_admin()));

-- Aggregated report for one date range plus the same-length period before it.
-- Returns counts only. Raw rows are never sent to the browser.
create or replace function public.analytics_summary(p_from date, p_to date)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  span int;
  prev_from date;
  prev_to date;
  result jsonb;
begin
  if not (select public.is_admin()) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or (p_to - p_from) > 732 then
    raise exception 'invalid date range' using errcode = '22023';
  end if;
  span := p_to - p_from + 1;
  prev_to := p_from - 1;
  prev_from := prev_to - span + 1;

  with ev as (
    select e.*, (e.occurred_at at time zone 'UTC')::date as d
    from public.analytics_events e
    where (e.occurred_at at time zone 'UTC')::date between prev_from and p_to
  ),
  cur as (select * from ev where d between p_from and p_to),
  prev as (select * from ev where d between prev_from and prev_to)
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'previous_from', prev_from, 'previous_to', prev_to),
    'first_event', (select min(occurred_at) from public.analytics_events),
    'totals', (select jsonb_build_object(
        'page_views', count(*) filter (where event_type = 'pageview'),
        'visitors', count(distinct (d, visitor_hash)) filter (where event_type = 'pageview'),
        'clicks', count(*) filter (where event_type = 'click')) from cur),
    'previous_totals', (select jsonb_build_object(
        'page_views', count(*) filter (where event_type = 'pageview'),
        'visitors', count(distinct (d, visitor_hash)) filter (where event_type = 'pageview'),
        'clicks', count(*) filter (where event_type = 'click')) from prev),
    'daily', (select coalesce(jsonb_agg(x order by x.d), '[]'::jsonb) from (
        select d,
          count(*) filter (where event_type = 'pageview') as views,
          count(distinct visitor_hash) filter (where event_type = 'pageview') as visitors,
          count(*) filter (where event_type = 'click') as clicks
        from cur group by d) x),
    'weekday', (select coalesce(jsonb_agg(x order by x.dow), '[]'::jsonb) from (
        select extract(isodow from d)::int as dow, count(*) as views
        from cur where event_type = 'pageview' group by 1) x),
    'hour', (select coalesce(jsonb_agg(x order by x.h), '[]'::jsonb) from (
        select extract(hour from occurred_at at time zone 'UTC')::int as h, count(*) as views
        from cur where event_type = 'pageview' group by 1) x),
    'pages', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select path, count(*) as views from cur where event_type = 'pageview'
        group by path order by count(*) desc limit 10) x),
    'channels', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case
            when referrer_host is null then 'Direct'
            when referrer_host ~ '(google|bing|duckduckgo|yahoo|yandex|baidu|ecosia)' then 'Search'
            when referrer_host ~ '(linkedin|twitter|t\.co|x\.com|facebook|instagram|youtube|whatsapp|reddit)' then 'Social'
            else 'Referral' end as channel,
          count(*) as views
        from cur where event_type = 'pageview' group by 1 order by count(*) desc) x),
    'referrers', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select referrer_host as host, count(*) as views from cur
        where event_type = 'pageview' and referrer_host is not null
        group by referrer_host order by count(*) desc limit 10) x),
    'campaigns', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select utm_source, utm_medium, utm_campaign, count(*) as views from cur
        where event_type = 'pageview' and utm_campaign is not null
        group by 1, 2, 3 order by count(*) desc limit 10) x),
    'clicks', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select click_target as target, count(*) as clicks from cur
        where event_type = 'click' group by 1 order by count(*) desc) x),
    'devices', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select device, count(*) as views from cur where event_type = 'pageview' group by 1 order by count(*) desc) x),
    'browsers', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select browser, count(*) as views from cur where event_type = 'pageview' group by 1 order by count(*) desc) x),
    'operating_systems', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select os, count(*) as views from cur where event_type = 'pageview' group by 1 order by count(*) desc) x)
  ) into result;
  return result;
end;
$$;

revoke all on function public.analytics_summary(date, date) from public, anon;
grant execute on function public.analytics_summary(date, date) to authenticated;
