-- Lead Finder subscriptions: private schema (not exposed through Supabase's
-- public API). __SCHEMA__ is replaced by the configured schema name.

create schema if not exists __SCHEMA__;
revoke all on schema __SCHEMA__ from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema __SCHEMA__ from anon, authenticated';
  end if;
end $$;

create table if not exists __SCHEMA__.devices (
  id           text primary key,
  public_key   text not null,
  created_at   timestamptz not null,
  last_seen_at timestamptz not null
);

create table if not exists __SCHEMA__.applications (
  id                    text primary key,
  device_id             text not null references __SCHEMA__.devices(id),
  plan                  text not null,
  message               text not null default '',
  email                 text,
  email_verified        boolean not null default false,
  -- payment evidence: the image lives in Storage until its retention ends;
  -- size and SHA-256 stay as a permanent reference
  screenshot_path       text,
  screenshot_type       text not null,
  screenshot_size       integer not null,
  screenshot_sha256     text not null,
  screenshot_deleted_at timestamptz,
  status                text not null check (status in ('pending', 'approved', 'cancelled')),
  created_at            timestamptz not null,
  decided_at            timestamptz,
  seq                   bigint generated always as identity  -- insertion order, breaks timestamp ties
);
create index if not exists applications_device on __SCHEMA__.applications (device_id, created_at desc, seq desc);
create index if not exists applications_retention on __SCHEMA__.applications (decided_at) where screenshot_deleted_at is null and status <> 'pending';

create table if not exists __SCHEMA__.action_tokens (
  hash           text primary key,
  application_id text not null references __SCHEMA__.applications(id) on delete cascade,
  action         text not null check (action in ('approve', 'cancel', 'verify_email')),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz
);
create index if not exists action_tokens_app on __SCHEMA__.action_tokens (application_id);

create table if not exists __SCHEMA__.licenses (
  device_id      text primary key references __SCHEMA__.devices(id),
  plan           text not null,
  application_id text not null references __SCHEMA__.applications(id),
  activated_at   timestamptz not null,
  expires_at     timestamptz
);

create table if not exists __SCHEMA__.trials (
  machine_id text primary key,
  used       integer not null default 0,
  updated_at timestamptz not null
);

create table if not exists __SCHEMA__.seen_requests (
  sig_hash   text primary key,
  expires_at bigint not null
);
create index if not exists seen_requests_expiry on __SCHEMA__.seen_requests (expires_at);

create table if not exists __SCHEMA__.maintenance_log (
  id      bigserial primary key,
  ran_at  timestamptz not null default now(),
  job     text not null,
  ok      boolean not null,
  details jsonb not null default '{}'::jsonb
);

create table if not exists __SCHEMA__.usage_alerts (
  kind    text primary key,
  level   integer not null,
  sent_at timestamptz not null
);

-- Database-only cleanup with explicit, narrow conditions. Never touches
-- applications, licences, devices or trials.
create or replace function __SCHEMA__.cleanup_db(p_now timestamptz default now())
returns jsonb
language plpgsql
set search_path = __SCHEMA__, pg_temp
as $fn$
declare
  n_seen   integer;
  n_tokens integer;
  n_logs   integer;
begin
  -- replay-protection entries are needed for minutes only
  delete from seen_requests where expires_at < (extract(epoch from p_now) * 1000)::bigint;
  get diagnostics n_seen = row_count;

  -- email links: used ones, and expired ones of decided applications (a
  -- pending application keeps its links so fresh ones can be requested);
  -- email-verification links once used or expired
  delete from action_tokens t
   where (t.used_at is not null and t.used_at < p_now - interval '1 day')
      or (t.action = 'verify_email' and t.expires_at < p_now - interval '1 day')
      or (t.expires_at < p_now - interval '1 day'
          and exists (select 1 from applications a where a.id = t.application_id and a.status <> 'pending'));
  get diagnostics n_tokens = row_count;

  delete from maintenance_log where ran_at < p_now - interval '90 days';
  get diagnostics n_logs = row_count;

  insert into maintenance_log (ran_at, job, ok, details)
  values (p_now, 'cleanup_db', true, jsonb_build_object('seen_requests', n_seen, 'action_tokens', n_tokens, 'old_logs', n_logs));
  return jsonb_build_object('seen_requests', n_seen, 'action_tokens', n_tokens, 'old_logs', n_logs);
end
$fn$;
revoke all on function __SCHEMA__.cleanup_db(timestamptz) from public;
