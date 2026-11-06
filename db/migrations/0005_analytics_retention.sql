-- 0005_analytics_retention.sql
-- Administrator-only retention for analytics events. Additive only.
-- Deletes raw events older than the given number of days. Default retention is 400 days.

create or replace function public.analytics_purge_older_than(p_days int default 400)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  if not (select public.is_admin()) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_days is null or p_days < 30 or p_days > 3650 then
    raise exception 'retention must be between 30 and 3650 days' using errcode = '22023';
  end if;
  delete from public.analytics_events
   where occurred_at < now() - make_interval(days => p_days);
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.analytics_purge_older_than(int) from public, anon;
grant execute on function public.analytics_purge_older_than(int) to authenticated;
