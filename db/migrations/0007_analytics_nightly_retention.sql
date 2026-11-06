-- 0007_analytics_nightly_retention.sql
-- Nightly retention for analytics events: rows older than 400 days are deleted every night.
-- Runs inside the database with pg_cron. It has no public endpoint and does not depend on
-- a browser session or on the administrator being signed in.
-- Idempotent: re-running this migration replaces the existing job with the same name.

create extension if not exists pg_cron with schema extensions;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'analytics-retention-400d') then
    perform cron.unschedule('analytics-retention-400d');
  end if;
end;
$$;

select cron.schedule(
  'analytics-retention-400d',
  '17 3 * * *',
  $job$delete from public.analytics_events where occurred_at < now() - interval '400 days'$job$
);
