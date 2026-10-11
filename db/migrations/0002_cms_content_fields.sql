-- 0002_cms_content_fields.sql
-- Adds the fields the CMS needs to hold the current public website content.
--
-- Safety properties (checked before applying):
--   * Additive only: no table, column, row or policy is dropped or rewritten.
--   * Constraints are dropped only when they are re-created below, so the
--     migration can be re-run safely.
--   * No grant or RLS change. New columns inherit the table-level grants that
--     already restrict access to the administrator.
--   * achievements.role_id is relaxed so that items which belong to the whole
--     portfolio (performance indicators, selected impact) can exist without a
--     role. The single-current-role rule on career_roles is unchanged.

-- Hero
alter table public.hero
  add column if not exists eyebrow text,
  add column if not exists proof_line text,
  add column if not exists quote text,
  add column if not exists metrics_strip jsonb not null default '[]'::jsonb,
  add column if not exists stats jsonb not null default '[]'::jsonb,
  add column if not exists cta_buttons jsonb not null default '[]'::jsonb;

alter table public.hero drop constraint if exists hero_json_arrays;
alter table public.hero add constraint hero_json_arrays check (
  jsonb_typeof(metrics_strip) = 'array'
  and jsonb_typeof(stats) = 'array'
  and jsonb_typeof(cta_buttons) = 'array'
);

-- Career roles: display text, bullets, visibility and a stable key for seeding
alter table public.career_roles
  add column if not exists period_label text,
  add column if not exists period_detail text,
  add column if not exists timeline_company text,
  add column if not exists timeline_summary text,
  add column if not exists context text,
  add column if not exists tag text,
  add column if not exists bullets jsonb not null default '[]'::jsonb,
  add column if not exists is_visible boolean not null default true,
  add column if not exists panel_key text;

alter table public.career_roles drop constraint if exists career_roles_panel_key_key;
alter table public.career_roles add constraint career_roles_panel_key_key unique (panel_key);
alter table public.career_roles drop constraint if exists career_roles_bullets_array;
alter table public.career_roles add constraint career_roles_bullets_array check (jsonb_typeof(bullets) = 'array');

-- Achievements: metrics, categories and portfolio-wide items
alter table public.achievements alter column role_id drop not null;
alter table public.achievements
  add column if not exists category text,
  add column if not exists metric_value text,
  add column if not exists metric_label text,
  add column if not exists detail_segments jsonb not null default '[]'::jsonb,
  add column if not exists is_visible boolean not null default true;

alter table public.achievements drop constraint if exists achievements_category_check;
alter table public.achievements add constraint achievements_category_check
  check (category is null or category in ('performance', 'impact', 'role'));
alter table public.achievements drop constraint if exists achievements_segments_array;
alter table public.achievements add constraint achievements_segments_array
  check (jsonb_typeof(detail_segments) = 'array');

-- Contact, footer and SEO / social sharing (single settings row)
alter table public.site_settings
  add column if not exists kenya_whatsapp_url text,
  add column if not exists footer_position text,
  add column if not exists footer_location text,
  add column if not exists footer_copyright text,
  add column if not exists seo_title text,
  add column if not exists seo_description text,
  add column if not exists og_title text,
  add column if not exists og_description text,
  add column if not exists og_url text,
  add column if not exists og_image_path text,
  add column if not exists og_image_alt text,
  add column if not exists twitter_card text,
  add column if not exists twitter_image_alt text,
  add column if not exists canonical_url text;

alter table public.site_settings drop constraint if exists site_settings_twitter_card_check;
alter table public.site_settings add constraint site_settings_twitter_card_check
  check (twitter_card is null or twitter_card in ('summary', 'summary_large_image'));
