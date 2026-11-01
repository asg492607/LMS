-- MIT ADT LMS persistent document store.
-- The Express API is the only application data gateway. Direct Data API access
-- for anon/authenticated users is intentionally denied; the API authenticates
-- Supabase access tokens and applies the existing scoped-role checks.

create table if not exists public.lms_documents (
  collection_name text not null check (length(collection_name) between 1 and 180),
  document_id text not null check (length(document_id) between 1 and 180),
  parent_document_id text,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection_name, document_id)
);

create index if not exists lms_documents_collection_updated_idx
  on public.lms_documents (collection_name, updated_at desc);
create index if not exists lms_documents_parent_idx
  on public.lms_documents (parent_document_id, collection_name);
create index if not exists lms_documents_data_gin_idx
  on public.lms_documents using gin (data jsonb_path_ops);
create index if not exists lms_documents_email_idx
  on public.lms_documents (lower(data ->> 'email'))
  where collection_name = 'users';
create unique index if not exists lms_documents_unique_user_email_idx
  on public.lms_documents (lower(data ->> 'email'))
  where collection_name = 'users' and data ? 'email';
create index if not exists lms_documents_university_idx
  on public.lms_documents ((data ->> 'universityId'), collection_name);

alter table public.lms_documents enable row level security;
alter table public.lms_documents force row level security;
revoke all on public.lms_documents from public, anon, authenticated;

do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'lms_backend') then
    create role lms_backend login nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end
$role$;

grant usage on schema public to lms_backend;
grant select, insert, update, delete on public.lms_documents to lms_backend;

drop policy if exists lms_backend_document_access on public.lms_documents;
create policy lms_backend_document_access
  on public.lms_documents
  for all
  to lms_backend
  using (current_user = 'lms_backend')
  with check (current_user = 'lms_backend');

create or replace function public.lms_sync_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  pending_uid text;
  full_name text;
begin
  full_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    split_part(coalesce(new.email, ''), '@', 1)
  );

  select document_id into pending_uid
    from public.lms_documents
   where collection_name = 'users'
     and lower(data ->> 'email') = lower(new.email)
     and document_id <> new.id::text
   order by created_at asc
   limit 1;

  if pending_uid is not null then
    update public.lms_documents as pending_role
       set collection_name = 'users/' || new.id::text || '/roles',
           parent_document_id = new.id::text,
           updated_at = now()
     where pending_role.collection_name = 'users/' || pending_uid || '/roles'
       and not exists (
         select 1
           from public.lms_documents as existing_role_row
          where existing_role_row.collection_name = 'users/' || new.id::text || '/roles'
            and existing_role_row.document_id = pending_role.document_id
       );
    delete from public.lms_documents
     where collection_name = 'users/' || pending_uid || '/roles';
    delete from public.lms_documents
     where collection_name = 'users' and document_id = pending_uid;
  end if;

  insert into public.lms_documents
    (collection_name, document_id, parent_document_id, data, created_at, updated_at)
  values
    ('users', new.id::text, null,
     jsonb_build_object(
       'uid', new.id::text,
       'email', lower(new.email),
       'displayName', full_name,
       'emailVerified', new.email_confirmed_at is not null,
       'universityId', 'mit-adt',
       'pending', false
     ), now(), now())
  on conflict (collection_name, document_id) do update
    set data = public.lms_documents.data || excluded.data,
        updated_at = now();

  if lower(new.email) = 'asg492607@gmail.com' then
    insert into public.lms_documents
      (collection_name, document_id, parent_document_id, data)
    values
      ('users/' || new.id::text || '/roles', 'platform_admin', new.id::text,
       jsonb_build_object(
         'role', 'platform_admin',
         'roleLabel', 'Platform administrator',
         'scopeType', 'university',
         'scopeId', 'mit-adt',
         'scopeName', 'MIT ADT University',
         'universityId', 'mit-adt',
         'createdBy', 'bootstrap',
         'createdAt', now()
       ))
    on conflict (collection_name, document_id) do nothing;
  end if;

  return new;
end
$function$;

drop trigger if exists lms_sync_auth_user_after_insert on auth.users;
create trigger lms_sync_auth_user_after_insert
  after insert on auth.users
  for each row execute function public.lms_sync_auth_user();
drop trigger if exists lms_sync_auth_user_after_update on auth.users;
create trigger lms_sync_auth_user_after_update
  after update of email, email_confirmed_at, raw_user_meta_data on auth.users
  for each row execute function public.lms_sync_auth_user();

insert into public.lms_documents
  (collection_name, document_id, parent_document_id, data)
select
  'users', id::text, null,
  jsonb_build_object(
    'uid', id::text,
    'email', lower(email),
    'displayName', coalesce(nullif(trim(raw_user_meta_data ->> 'display_name'), ''), nullif(trim(raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(email, ''), '@', 1)),
    'emailVerified', email_confirmed_at is not null,
    'universityId', 'mit-adt',
    'pending', false
  )
from auth.users
on conflict (collection_name, document_id) do nothing;

insert into public.lms_documents
  (collection_name, document_id, parent_document_id, data)
select
  'users/' || id::text || '/roles', 'platform_admin', id::text,
  jsonb_build_object(
    'role', 'platform_admin',
    'roleLabel', 'Platform administrator',
    'scopeType', 'university',
    'scopeId', 'mit-adt',
    'scopeName', 'MIT ADT University',
    'universityId', 'mit-adt',
    'createdBy', 'bootstrap',
    'createdAt', now()
  )
from auth.users
where lower(email) = 'asg492607@gmail.com'
on conflict (collection_name, document_id) do nothing;

revoke all on function public.lms_sync_auth_user() from public, anon, authenticated;

comment on table public.lms_documents is
  'Server-only MIT ADT LMS records. Access through the authenticated Express API, not the Supabase Data API.';
