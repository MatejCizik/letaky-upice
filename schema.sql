-- Username/password authentication for Letáky Úpice.
-- Public tables are not directly accessible from the browser; access goes through RPC functions.

create schema if not exists private;

-- Remove legacy Supabase Auth profile trigger used by the previous email-login version.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists private.handle_new_user() cascade;

-- Rebuild application data. The project is new and contains no production street assignments.
drop table if exists public.street_status cascade;
drop table if exists public.profiles cascade;
drop table if exists private.app_sessions cascade;
drop table if exists private.user_passwords cascade;

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  display_name text not null,
  role text not null default 'user' check (role in ('user','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint username_normalized check (username = lower(username)),
  constraint username_format check (username ~ '^[a-z0-9._-]{3,32}$'),
  constraint display_name_not_blank check (length(btrim(display_name)) between 1 and 80)
);

create table private.user_passwords (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

create table private.app_sessions (
  token_hash bytea primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index app_sessions_user_idx on private.app_sessions(user_id);
create index app_sessions_expiry_idx on private.app_sessions(expires_at);

create table public.street_status (
  street_name text primary key,
  status text not null default 'in_progress' check (status in ('in_progress','done')),
  claimed_by uuid not null references public.profiles(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index street_status_claimed_by_idx on public.street_status(claimed_by);
create index street_status_status_idx on public.street_status(status);

alter table public.profiles enable row level security;
alter table public.street_status enable row level security;

-- Browser clients must not access application tables directly.
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.street_status from anon, authenticated;
revoke all on table private.user_passwords from public, anon, authenticated;
revoke all on table private.app_sessions from public, anon, authenticated;
revoke usage on schema private from public, anon, authenticated;

-- Internal helper: resolve an opaque session token to an active user.
create or replace function private.session_user(p_token text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.user_id
  from private.app_sessions s
  join public.profiles p on p.id = s.user_id
  where p_token is not null
    and length(p_token) >= 32
    and s.token_hash = extensions.digest(pg_catalog.convert_to(p_token, 'UTF8'), 'sha256')
    and s.expires_at > pg_catalog.now()
    and p.active = true
  limit 1
$$;

revoke all on function private.session_user(text) from public, anon, authenticated;

-- Login is intentionally callable before authentication. It only returns an opaque session token.
create or replace function public.app_login(p_username text, p_password text)
returns table(session_token text, user_id uuid, username text, display_name text, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_username text;
  v_display_name text;
  v_role text;
  v_hash text;
  v_token text;
begin
  select p.id, p.username, p.display_name, p.role, c.password_hash
    into v_user_id, v_username, v_display_name, v_role, v_hash
  from public.profiles p
  join private.user_passwords c on c.user_id = p.id
  where p.username = lower(btrim(p_username))
    and p.active = true
  limit 1;

  if v_user_id is null or v_hash is null or extensions.crypt(p_password, v_hash) <> v_hash then
    raise exception 'INVALID_LOGIN';
  end if;

  delete from private.app_sessions where expires_at <= pg_catalog.now();

  v_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.app_sessions(token_hash, user_id, expires_at)
  values (
    extensions.digest(pg_catalog.convert_to(v_token, 'UTF8'), 'sha256'),
    v_user_id,
    pg_catalog.now() + interval '30 days'
  );

  return query select v_token, v_user_id, v_username, v_display_name, v_role;
end;
$$;

create or replace function public.app_me(p_session text)
returns table(user_id uuid, username text, display_name text, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid;
begin
  v_user_id := private.session_user(p_session);
  if v_user_id is null then raise exception 'SESSION_EXPIRED'; end if;

  update private.app_sessions
     set last_seen_at = pg_catalog.now()
   where token_hash = extensions.digest(pg_catalog.convert_to(p_session, 'UTF8'), 'sha256');

  return query
  select p.id, p.username, p.display_name, p.role
  from public.profiles p where p.id = v_user_id;
end;
$$;

create or replace function public.app_logout(p_session text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.app_sessions
  where token_hash = extensions.digest(pg_catalog.convert_to(coalesce(p_session,''), 'UTF8'), 'sha256');
end;
$$;

create or replace function public.app_list_profiles(p_session text)
returns table(id uuid, username text, display_name text, role text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.session_user(p_session) is null then raise exception 'SESSION_EXPIRED'; end if;
  return query
    select p.id, p.username, p.display_name, p.role
    from public.profiles p
    where p.active = true
    order by p.display_name, p.username;
end;
$$;

create or replace function public.app_list_street_status(p_session text)
returns table(street_name text, status text, claimed_by uuid, claimed_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.session_user(p_session) is null then raise exception 'SESSION_EXPIRED'; end if;
  return query
    select s.street_name, s.status, s.claimed_by, s.claimed_at, s.updated_at
    from public.street_status s
    order by s.street_name;
end;
$$;

create or replace function public.app_claim_street(p_session text, p_street_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid;
begin
  v_user_id := private.session_user(p_session);
  if v_user_id is null then raise exception 'SESSION_EXPIRED'; end if;
  if nullif(btrim(p_street_name),'') is null then raise exception 'INVALID_STREET'; end if;

  insert into public.street_status(street_name, status, claimed_by)
  values (btrim(p_street_name), 'in_progress', v_user_id);
end;
$$;

create or replace function public.app_set_street_status(p_session text, p_street_name text, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_role text;
  v_owner uuid;
begin
  v_user_id := private.session_user(p_session);
  if v_user_id is null then raise exception 'SESSION_EXPIRED'; end if;
  if p_status not in ('in_progress','done') then raise exception 'INVALID_STATUS'; end if;

  select p.role into v_role from public.profiles p where p.id = v_user_id;
  select s.claimed_by into v_owner from public.street_status s where s.street_name = btrim(p_street_name);
  if v_owner is null then raise exception 'STREET_NOT_FOUND'; end if;
  if v_owner <> v_user_id and v_role <> 'admin' then raise exception 'FORBIDDEN'; end if;

  update public.street_status
     set status = p_status, updated_at = pg_catalog.now()
   where street_name = btrim(p_street_name);
end;
$$;

create or replace function public.app_release_street(p_session text, p_street_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_role text;
  v_owner uuid;
begin
  v_user_id := private.session_user(p_session);
  if v_user_id is null then raise exception 'SESSION_EXPIRED'; end if;

  select p.role into v_role from public.profiles p where p.id = v_user_id;
  select s.claimed_by into v_owner from public.street_status s where s.street_name = btrim(p_street_name);
  if v_owner is null then return; end if;
  if v_owner <> v_user_id and v_role <> 'admin' then raise exception 'FORBIDDEN'; end if;

  delete from public.street_status where street_name = btrim(p_street_name);
end;
$$;

-- Admin user management.
create or replace function public.app_admin_list_users(p_session text)
returns table(id uuid, username text, display_name text, role text, active boolean, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare v_admin_id uuid;
begin
  v_admin_id := private.session_user(p_session);
  if v_admin_id is null or not exists(select 1 from public.profiles p where p.id=v_admin_id and p.role='admin') then
    raise exception 'FORBIDDEN';
  end if;
  return query select p.id, p.username, p.display_name, p.role, p.active, p.created_at
    from public.profiles p order by p.active desc, p.display_name, p.username;
end;
$$;

create or replace function public.app_admin_create_user(
  p_session text,
  p_username text,
  p_display_name text,
  p_password text,
  p_role text default 'user'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_new_id uuid;
  v_username text := lower(btrim(p_username));
  v_name text := btrim(p_display_name);
begin
  v_admin_id := private.session_user(p_session);
  if v_admin_id is null or not exists(select 1 from public.profiles p where p.id=v_admin_id and p.role='admin') then
    raise exception 'FORBIDDEN';
  end if;
  if v_username !~ '^[a-z0-9._-]{3,32}$' then raise exception 'INVALID_USERNAME'; end if;
  if length(v_name) < 1 or length(v_name) > 80 then raise exception 'INVALID_NAME'; end if;
  if length(coalesce(p_password,'')) < 6 then raise exception 'PASSWORD_TOO_SHORT'; end if;
  if p_role not in ('user','admin') then raise exception 'INVALID_ROLE'; end if;

  insert into public.profiles(username, display_name, role)
  values (v_username, v_name, p_role)
  returning id into v_new_id;

  insert into private.user_passwords(user_id, password_hash)
  values (v_new_id, extensions.crypt(p_password, extensions.gen_salt('bf', 10)));

  return v_new_id;
exception
  when unique_violation then raise exception 'USERNAME_EXISTS';
end;
$$;

create or replace function public.app_admin_update_user(
  p_session text,
  p_user_id uuid,
  p_display_name text,
  p_role text,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_admin_id uuid;
begin
  v_admin_id := private.session_user(p_session);
  if v_admin_id is null or not exists(select 1 from public.profiles p where p.id=v_admin_id and p.role='admin') then
    raise exception 'FORBIDDEN';
  end if;
  if p_role not in ('user','admin') then raise exception 'INVALID_ROLE'; end if;
  if length(btrim(coalesce(p_display_name,''))) < 1 or length(btrim(p_display_name)) > 80 then raise exception 'INVALID_NAME'; end if;
  if p_user_id = v_admin_id and (p_role <> 'admin' or p_active = false) then raise exception 'CANNOT_DISABLE_SELF'; end if;

  update public.profiles
     set display_name=btrim(p_display_name), role=p_role, active=p_active
   where id=p_user_id;
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  if p_active = false then delete from private.app_sessions where user_id=p_user_id; end if;
end;
$$;

create or replace function public.app_admin_reset_password(p_session text, p_user_id uuid, p_new_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_admin_id uuid;
begin
  v_admin_id := private.session_user(p_session);
  if v_admin_id is null or not exists(select 1 from public.profiles p where p.id=v_admin_id and p.role='admin') then
    raise exception 'FORBIDDEN';
  end if;
  if length(coalesce(p_new_password,'')) < 6 then raise exception 'PASSWORD_TOO_SHORT'; end if;

  update private.user_passwords
     set password_hash=extensions.crypt(p_new_password, extensions.gen_salt('bf', 10)), updated_at=pg_catalog.now()
   where user_id=p_user_id;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  delete from private.app_sessions where user_id=p_user_id and user_id<>v_admin_id;
end;
$$;

create or replace function public.app_admin_delete_user(p_session text, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_admin_id uuid;
begin
  v_admin_id := private.session_user(p_session);
  if v_admin_id is null or not exists(select 1 from public.profiles p where p.id=v_admin_id and p.role='admin') then
    raise exception 'FORBIDDEN';
  end if;
  if p_user_id = v_admin_id then raise exception 'CANNOT_DELETE_SELF'; end if;
  delete from public.profiles where id=p_user_id;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
end;
$$;

-- Remove default execution grants, then expose only the intended API endpoints.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function public.app_login(text,text) to anon, authenticated;
grant execute on function public.app_me(text) to anon, authenticated;
grant execute on function public.app_logout(text) to anon, authenticated;
grant execute on function public.app_list_profiles(text) to anon, authenticated;
grant execute on function public.app_list_street_status(text) to anon, authenticated;
grant execute on function public.app_claim_street(text,text) to anon, authenticated;
grant execute on function public.app_set_street_status(text,text,text) to anon, authenticated;
grant execute on function public.app_release_street(text,text) to anon, authenticated;
grant execute on function public.app_admin_list_users(text) to anon, authenticated;
grant execute on function public.app_admin_create_user(text,text,text,text,text) to anon, authenticated;
grant execute on function public.app_admin_update_user(text,uuid,text,text,boolean) to anon, authenticated;
grant execute on function public.app_admin_reset_password(text,uuid,text) to anon, authenticated;
grant execute on function public.app_admin_delete_user(text,uuid) to anon, authenticated;

-- One-time first-admin setup. This endpoint refuses to run after any profile exists.
create or replace function public.app_bootstrap_admin(p_username text, p_display_name text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_username text := lower(btrim(p_username));
begin
  if exists(select 1 from public.profiles) then raise exception 'SETUP_ALREADY_COMPLETED'; end if;
  if v_username !~ '^[a-z0-9._-]{3,32}$' then raise exception 'INVALID_USERNAME'; end if;
  if length(btrim(coalesce(p_display_name,''))) < 1 or length(btrim(p_display_name)) > 80 then raise exception 'INVALID_NAME'; end if;
  if length(coalesce(p_password,'')) < 6 then raise exception 'PASSWORD_TOO_SHORT'; end if;
  insert into public.profiles(username, display_name, role, active)
  values (v_username, btrim(p_display_name), 'admin', true) returning id into v_id;
  insert into private.user_passwords(user_id, password_hash)
  values (v_id, extensions.crypt(p_password, extensions.gen_salt('bf', 10)));
  return v_id;
end;
$$;
revoke execute on function public.app_bootstrap_admin(text,text,text) from public, anon, authenticated;
grant execute on function public.app_bootstrap_admin(text,text,text) to anon, authenticated;

notify pgrst, 'reload schema';

-- Hardening: login throttling and anon-only custom API role.
create table if not exists private.login_attempts (
  username text not null,
  ip text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists login_attempts_lookup_idx on private.login_attempts(username, ip, attempted_at desc);
revoke all on table private.login_attempts from public, anon, authenticated;

create or replace function public.app_login(p_username text, p_password text)
returns table(session_token text, user_id uuid, username text, display_name text, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_username text;
  v_display_name text;
  v_role text;
  v_hash text;
  v_token text;
  v_login_username text := lower(btrim(p_username));
  v_ip text := split_part(coalesce((current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for'), 'unknown'), ',', 1);
  v_attempts integer;
begin
  delete from private.login_attempts where attempted_at < pg_catalog.now() - interval '15 minutes';
  select count(*) into v_attempts from private.login_attempts
   where username=v_login_username and ip=v_ip and attempted_at >= pg_catalog.now() - interval '15 minutes';
  if v_attempts >= 10 then return; end if;

  select p.id, p.username, p.display_name, p.role, c.password_hash
    into v_user_id, v_username, v_display_name, v_role, v_hash
  from public.profiles p
  join private.user_passwords c on c.user_id = p.id
  where p.username = v_login_username and p.active = true
  limit 1;

  if v_user_id is null or v_hash is null or extensions.crypt(p_password, v_hash) <> v_hash then
    insert into private.login_attempts(username, ip) values (v_login_username, v_ip);
    return;
  end if;

  delete from private.login_attempts where username=v_login_username and ip=v_ip;
  delete from private.app_sessions where expires_at <= pg_catalog.now();
  v_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.app_sessions(token_hash, user_id, expires_at)
  values (extensions.digest(pg_catalog.convert_to(v_token, 'UTF8'), 'sha256'), v_user_id, pg_catalog.now() + interval '30 days');
  return query select v_token, v_user_id, v_username, v_display_name, v_role;
end;
$$;

create or replace function public.app_bootstrap_admin(p_username text, p_display_name text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_username text := lower(btrim(p_username));
begin
  if exists(select 1 from public.profiles) then raise exception 'SETUP_ALREADY_COMPLETED'; end if;
  if v_username !~ '^[a-z0-9._-]{3,32}$' then raise exception 'INVALID_USERNAME'; end if;
  if length(btrim(coalesce(p_display_name,''))) < 1 or length(btrim(p_display_name)) > 80 then raise exception 'INVALID_NAME'; end if;
  if length(coalesce(p_password,'')) < 6 then raise exception 'PASSWORD_TOO_SHORT'; end if;
  insert into public.profiles(username, display_name, role, active)
  values (v_username, btrim(p_display_name), 'admin', true) returning id into v_id;
  insert into private.user_passwords(user_id, password_hash)
  values (v_id, extensions.crypt(p_password, extensions.gen_salt('bf', 10)));
  revoke execute on function public.app_bootstrap_admin(text,text,text) from anon, authenticated;
  return v_id;
end;
$$;

revoke execute on function public.app_login(text,text) from public, authenticated;
revoke execute on function public.app_me(text) from public, authenticated;
revoke execute on function public.app_logout(text) from public, authenticated;
revoke execute on function public.app_list_profiles(text) from public, authenticated;
revoke execute on function public.app_list_street_status(text) from public, authenticated;
revoke execute on function public.app_claim_street(text,text) from public, authenticated;
revoke execute on function public.app_set_street_status(text,text,text) from public, authenticated;
revoke execute on function public.app_release_street(text,text) from public, authenticated;
revoke execute on function public.app_admin_list_users(text) from public, authenticated;
revoke execute on function public.app_admin_create_user(text,text,text,text,text) from public, authenticated;
revoke execute on function public.app_admin_update_user(text,uuid,text,text,boolean) from public, authenticated;
revoke execute on function public.app_admin_reset_password(text,uuid,text) from public, authenticated;
revoke execute on function public.app_admin_delete_user(text,uuid) from public, authenticated;
revoke execute on function public.app_bootstrap_admin(text,text,text) from public, authenticated;

grant execute on function public.app_login(text,text) to anon;
grant execute on function public.app_me(text) to anon;
grant execute on function public.app_logout(text) to anon;
grant execute on function public.app_list_profiles(text) to anon;
grant execute on function public.app_list_street_status(text) to anon;
grant execute on function public.app_claim_street(text,text) to anon;
grant execute on function public.app_set_street_status(text,text,text) to anon;
grant execute on function public.app_release_street(text,text) to anon;
grant execute on function public.app_admin_list_users(text) to anon;
grant execute on function public.app_admin_create_user(text,text,text,text,text) to anon;
grant execute on function public.app_admin_update_user(text,uuid,text,text,boolean) to anon;
grant execute on function public.app_admin_reset_password(text,uuid,text) to anon;
grant execute on function public.app_admin_delete_user(text,uuid) to anon;
grant execute on function public.app_bootstrap_admin(text,text,text) to anon;
notify pgrst, 'reload schema';
