-- 0003_media_library.sql
-- Media library and résumé drafts. Additive only.
-- public.media_assets already existed (empty, admin-only RLS). This migration extends it.
-- Stored assets are DRAFTS. Nothing here changes the public website, the live résumé
-- file, or any published content.

-- Private bucket stays private. Limits only: 10 MB, images and PDF.
update storage.buckets
   set file_size_limit = 10485760,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf']
 where id = 'content-media';

alter table public.media_assets add column if not exists status text not null default 'active';
alter table public.media_assets add column if not exists original_name text not null default 'untitled';
alter table public.media_assets add column if not exists width integer;
alter table public.media_assets add column if not exists height integer;
alter table public.media_assets add column if not exists uploaded_by uuid default auth.uid();

alter table public.media_assets drop constraint if exists media_assets_status_check;
alter table public.media_assets add constraint media_assets_status_check
  check (status in ('active', 'draft', 'archived'));

alter table public.media_assets drop constraint if exists media_assets_original_name_check;
alter table public.media_assets add constraint media_assets_original_name_check
  check (char_length(original_name) between 1 and 200);

alter table public.media_assets drop constraint if exists media_assets_dimensions_check;
alter table public.media_assets add constraint media_assets_dimensions_check
  check ((width is null or width > 0) and (height is null or height > 0));

alter table public.media_assets drop constraint if exists media_assets_size_limit_check;
alter table public.media_assets add constraint media_assets_size_limit_check
  check (size_bytes > 0 and size_bytes <= 10485760);

alter table public.media_assets drop constraint if exists media_assets_mime_check;
alter table public.media_assets add constraint media_assets_mime_check
  check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf'));

alter table public.media_assets drop constraint if exists media_assets_storage_path_format_check;
alter table public.media_assets add constraint media_assets_storage_path_format_check
  check (storage_path ~ '^(images|resumes)/[a-f0-9-]{36}\.(jpg|png|webp|avif|pdf)$');

alter table public.media_assets drop constraint if exists media_assets_kind_matches_check;
alter table public.media_assets add constraint media_assets_kind_matches_check
  check (
    (kind = 'photo' and status = 'active' and mime_type <> 'application/pdf' and storage_path like 'images/%')
    or (kind = 'resume' and status in ('draft', 'archived') and mime_type = 'application/pdf' and storage_path like 'resumes/%')
  );

-- At most one résumé draft at a time.
create unique index if not exists media_one_resume_draft
  on public.media_assets (kind) where kind = 'resume' and status = 'draft';

-- Existing admin-only policy (media_assets_admin, authenticated, is_admin()) and grants are kept.

drop trigger if exists media_assets_audit on public.media_assets;
create trigger media_assets_audit
  after insert or update or delete on public.media_assets
  for each row execute function public.write_audit();

-- Archives the current draft résumé and registers the new one in a single transaction.
-- The caller uploads the file to the private bucket first.
create or replace function public.replace_resume_draft(p_path text, p_name text, p_size bigint)
returns public.media_assets
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r public.media_assets;
begin
  if not (select public.is_admin()) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  update public.media_assets set status = 'archived'
   where kind = 'resume' and status = 'draft';
  insert into public.media_assets (kind, status, storage_path, original_name, mime_type, size_bytes)
  values ('resume', 'draft', p_path, p_name, 'application/pdf', p_size)
  returning * into r;
  return r;
end;
$$;

revoke all on function public.replace_resume_draft(text, text, bigint) from public, anon;
grant execute on function public.replace_resume_draft(text, text, bigint) to authenticated;
