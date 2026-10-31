-- Reelplane core schema.
--
-- Isolation model (see docs/ARCHITECTURE.md):
--   * All tables live in the `reelplane` schema, which Supabase's PostgREST does not expose.
--   * Row-level security is enabled on every table. Application code never queries as the
--     table owner: the API does `SET LOCAL ROLE reelplane_api` + `app.project_id` per request,
--     the worker runs as `reelplane_worker`. A query that forgets `WHERE project_id = ...`
--     still cannot see another project's rows.
--   * The few cross-tenant lookups (authenticating an API key before the project is known)
--     go through SECURITY DEFINER functions owned by the migration role.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Roles (cluster-global, so created idempotently)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'reelplane_api') then
    create role reelplane_api nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'reelplane_worker') then
    create role reelplane_worker nologin;
  end if;
end
$$;

-- The login role (local `reelplane`, Supabase `postgres`) switches into these per transaction.
do $$
begin
  execute format('grant reelplane_api to %I', current_user);
  execute format('grant reelplane_worker to %I', current_user);
end
$$;

revoke all on schema reelplane from public;
grant usage on schema reelplane to reelplane_api, reelplane_worker;

-- ---------------------------------------------------------------------------
-- Request context helpers
-- ---------------------------------------------------------------------------
create function reelplane.current_project_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.project_id', true), '')::uuid $$;

create function reelplane.current_user_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create function reelplane.set_updated_at() returns trigger
  language plpgsql
  as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Projects and API keys
-- ---------------------------------------------------------------------------
create table reelplane.projects (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(name) between 1 and 100),
  -- Supabase auth user that owns the project (dashboard access).
  owner_id         uuid not null,
  -- Origins allowed to use this project's publishable keys from a browser.
  allowed_origins  text[] not null default '{}',
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index projects_owner_idx on reelplane.projects (owner_id);
create trigger projects_updated_at before update on reelplane.projects
  for each row execute function reelplane.set_updated_at();

create table reelplane.api_keys (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references reelplane.projects (id) on delete cascade,
  kind          text not null check (kind in ('publishable', 'secret')),
  name          text not null default 'Default' check (length(name) between 1 and 100),
  -- First characters of the key, safe to display ("rp_sk_4f9a…").
  prefix        text not null,
  -- HMAC-SHA256(pepper, key). The key itself is never stored.
  key_hash      bytea not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  -- Set during rotation: the old key keeps working until this moment.
  expires_at    timestamptz
);
create index api_keys_project_idx on reelplane.api_keys (project_id);

-- ---------------------------------------------------------------------------
-- Videos, renditions, events
-- ---------------------------------------------------------------------------
create table reelplane.videos (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references reelplane.projects (id) on delete cascade,
  -- The developer's own end-user id, for per-creator feeds. Opaque to us.
  creator_id        text check (length(creator_id) <= 200),
  title             text check (length(title) <= 200),
  status            text not null default 'uploading'
                    check (status in ('uploading', 'queued', 'processing', 'ready', 'failed', 'deleted')),
  failure_reason    text,
  -- Upload
  content_type      text not null,
  size_bytes        bigint not null check (size_bytes > 0),
  source_key        text not null,
  upload_id         text,
  upload_expires_at timestamptz,
  -- Probe results (filled by the worker)
  duration_ms       integer check (duration_ms >= 0),
  width             integer check (width > 0),
  height            integer check (height > 0),
  -- Playback assets (filled by the worker)
  playback_prefix   text,
  master_playlist_key text,
  poster_key        text,
  thumbnail_keys    text[] not null default '{}',
  placeholder       text,
  -- Feed signals
  is_showcase       boolean not null default false,
  likes_count       integer not null default 0 check (likes_count >= 0),
  views_count       integer not null default 0 check (views_count >= 0),
  completions_count integer not null default 0 check (completions_count >= 0),
  -- Housekeeping
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  ready_at          timestamptz,
  deleted_at        timestamptz
);
create index videos_project_feed_idx on reelplane.videos (project_id, created_at desc, id desc)
  where status = 'ready';
create index videos_creator_feed_idx on reelplane.videos (project_id, creator_id, created_at desc, id desc)
  where status = 'ready';
create index videos_status_idx on reelplane.videos (status, created_at);
create trigger videos_updated_at before update on reelplane.videos
  for each row execute function reelplane.set_updated_at();

create table reelplane.renditions (
  id              uuid primary key default gen_random_uuid(),
  video_id        uuid not null references reelplane.videos (id) on delete cascade,
  project_id      uuid not null references reelplane.projects (id) on delete cascade,
  name            text not null,
  width           integer not null check (width > 0),
  height          integer not null check (height > 0),
  bitrate_kbps    integer not null check (bitrate_kbps > 0),
  codecs          text not null,
  playlist_key    text not null,
  created_at      timestamptz not null default now(),
  unique (video_id, name)
);

create table reelplane.video_events (
  id          bigint generated always as identity primary key,
  video_id    uuid not null references reelplane.videos (id) on delete cascade,
  project_id  uuid not null references reelplane.projects (id) on delete cascade,
  type        text not null,
  from_status text,
  to_status   text,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index video_events_video_idx on reelplane.video_events (video_id, id);

-- Every status change is recorded, and illegal transitions are rejected, in the database
-- itself so that no code path (API, worker, cleanup job, psql) can skip the audit trail.
create function reelplane.video_transition_allowed(from_status text, to_status text) returns boolean
  language sql immutable
  as $$
    select case from_status
      when 'uploading'  then to_status in ('queued', 'failed', 'deleted')
      when 'queued'     then to_status in ('processing', 'failed', 'deleted')
      when 'processing' then to_status in ('ready', 'queued', 'failed', 'deleted')
      when 'ready'      then to_status in ('deleted')
      when 'failed'     then to_status in ('queued', 'deleted')
      else false
    end
  $$;

create function reelplane.audit_video_status() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'INSERT' then
    insert into reelplane.video_events (video_id, project_id, type, to_status)
    values (new.id, new.project_id, 'video.created', new.status);
  elsif new.status is distinct from old.status then
    if not reelplane.video_transition_allowed(old.status, new.status) then
      raise exception 'illegal video status transition % -> % for video %', old.status, new.status, new.id
        using errcode = 'check_violation';
    end if;
    insert into reelplane.video_events (video_id, project_id, type, from_status, to_status, data)
    values (new.id, new.project_id, 'video.' || new.status, old.status, new.status,
            case when new.failure_reason is not null and new.status = 'failed'
                 then jsonb_build_object('reason', new.failure_reason) else '{}' end);
  end if;
  return new;
end
$$;

create trigger videos_status_audit after insert or update of status on reelplane.videos
  for each row execute function reelplane.audit_video_status();

-- ---------------------------------------------------------------------------
-- Job queue (claimed with FOR UPDATE SKIP LOCKED; see services/worker)
-- ---------------------------------------------------------------------------
create table reelplane.jobs (
  id               uuid primary key default gen_random_uuid(),
  video_id         uuid not null references reelplane.videos (id) on delete cascade,
  project_id       uuid not null references reelplane.projects (id) on delete cascade,
  kind             text not null default 'transcode' check (kind in ('transcode')),
  state            text not null default 'queued'
                   check (state in ('queued', 'running', 'succeeded', 'dead', 'cancelled')),
  attempts         integer not null default 0 check (attempts >= 0),
  max_attempts     integer not null default 5 check (max_attempts > 0),
  run_after        timestamptz not null default now(),
  lease_owner      text,
  lease_expires_at timestamptz,
  heartbeat_at     timestamptz,
  progress         smallint not null default 0 check (progress between 0 and 100),
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  check ((state = 'running') = (lease_owner is not null and lease_expires_at is not null))
);
-- At most one live transcode job per video: a retried "complete upload" cannot enqueue twice.
create unique index jobs_one_active_per_video on reelplane.jobs (video_id, kind)
  where state in ('queued', 'running');
-- The claim query scans only runnable work.
create index jobs_claim_idx on reelplane.jobs (run_after) where state = 'queued';
-- Lease reaper scans only running jobs.
create index jobs_lease_idx on reelplane.jobs (lease_expires_at) where state = 'running';
create trigger jobs_updated_at before update on reelplane.jobs
  for each row execute function reelplane.set_updated_at();

create function reelplane.audit_job_state() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'INSERT' then
    insert into reelplane.video_events (video_id, project_id, type, data)
    values (new.video_id, new.project_id, 'job.queued', jsonb_build_object('job_id', new.id));
  elsif new.state is distinct from old.state then
    insert into reelplane.video_events (video_id, project_id, type, data)
    values (new.video_id, new.project_id, 'job.' || new.state,
            jsonb_strip_nulls(jsonb_build_object(
              'job_id', new.id,
              'attempt', new.attempts,
              'worker', coalesce(new.lease_owner, old.lease_owner),
              'error', case when new.state in ('queued', 'dead') then new.last_error end)));
  end if;
  return new;
end
$$;

create trigger jobs_state_audit after insert or update of state on reelplane.jobs
  for each row execute function reelplane.audit_job_state();

-- ---------------------------------------------------------------------------
-- Playback analytics and likes
-- ---------------------------------------------------------------------------
create table reelplane.playback_events (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references reelplane.projects (id) on delete cascade,
  video_id    uuid not null references reelplane.videos (id) on delete cascade,
  session_id  text not null check (length(session_id) <= 100),
  type        text not null check (type in ('ttff', 'rebuffer', 'watch', 'quality_switch', 'error')),
  value_ms    integer check (value_ms >= 0),
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index playback_events_project_time_idx on reelplane.playback_events (project_id, created_at);
create index playback_events_video_idx on reelplane.playback_events (video_id, type);

create table reelplane.likes (
  project_id  uuid not null references reelplane.projects (id) on delete cascade,
  video_id    uuid not null references reelplane.videos (id) on delete cascade,
  viewer_id   text not null check (length(viewer_id) <= 200),
  created_at  timestamptz not null default now(),
  primary key (video_id, viewer_id)
);

-- ---------------------------------------------------------------------------
-- Webhooks (transactional outbox: deliveries are rows written with the state change)
-- ---------------------------------------------------------------------------
create table reelplane.webhook_endpoints (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references reelplane.projects (id) on delete cascade,
  url         text not null check (url ~ '^https?://'),
  -- Signing secret; must be readable to sign payloads, so it is protected by RLS, not hashing.
  secret      text not null,
  events      text[] not null default '{video.ready,video.failed,video.deleted}',
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index webhook_endpoints_project_idx on reelplane.webhook_endpoints (project_id);
create trigger webhook_endpoints_updated_at before update on reelplane.webhook_endpoints
  for each row execute function reelplane.set_updated_at();

create table reelplane.webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  endpoint_id      uuid not null references reelplane.webhook_endpoints (id) on delete cascade,
  project_id       uuid not null references reelplane.projects (id) on delete cascade,
  event_type       text not null,
  payload          jsonb not null,
  state            text not null default 'pending' check (state in ('pending', 'succeeded', 'dead')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_status_code integer,
  last_error       text,
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz
);
create index webhook_deliveries_due_idx on reelplane.webhook_deliveries (next_attempt_at)
  where state = 'pending';
create index webhook_deliveries_endpoint_idx on reelplane.webhook_deliveries (endpoint_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Idempotency keys (Stripe-style: same key + same request => same response)
-- ---------------------------------------------------------------------------
create table reelplane.idempotency_keys (
  project_id    uuid not null references reelplane.projects (id) on delete cascade,
  key           text not null check (length(key) between 1 and 255),
  operation     text not null,
  request_hash  text not null,
  status_code   integer,
  response      jsonb,
  created_at    timestamptz not null default now(),
  primary key (project_id, operation, key)
);
create index idempotency_keys_created_idx on reelplane.idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table reelplane.projects           enable row level security;
alter table reelplane.api_keys           enable row level security;
alter table reelplane.videos             enable row level security;
alter table reelplane.renditions         enable row level security;
alter table reelplane.video_events       enable row level security;
alter table reelplane.jobs               enable row level security;
alter table reelplane.playback_events    enable row level security;
alter table reelplane.likes              enable row level security;
alter table reelplane.webhook_endpoints  enable row level security;
alter table reelplane.webhook_deliveries enable row level security;
alter table reelplane.idempotency_keys   enable row level security;

-- API role: a project sees only its own rows; a dashboard user sees the projects they own.
create policy projects_api on reelplane.projects to reelplane_api
  using (id = reelplane.current_project_id() or owner_id = reelplane.current_user_id())
  with check (owner_id = reelplane.current_user_id() or id = reelplane.current_project_id());

do $$
declare
  t text;
begin
  foreach t in array array[
    'api_keys', 'videos', 'renditions', 'video_events', 'jobs', 'playback_events', 'likes',
    'webhook_endpoints', 'webhook_deliveries', 'idempotency_keys'
  ] loop
    execute format(
      'create policy %I on reelplane.%I to reelplane_api
         using (project_id = reelplane.current_project_id())
         with check (project_id = reelplane.current_project_id())',
      t || '_tenant', t);
  end loop;
end
$$;

-- Worker role: processes jobs for every project, but only touches what transcoding needs.
do $$
declare
  t text;
begin
  foreach t in array array[
    'projects', 'videos', 'renditions', 'video_events', 'jobs', 'webhook_endpoints', 'webhook_deliveries'
  ] loop
    execute format('create policy %I on reelplane.%I to reelplane_worker using (true) with check (true)',
      t || '_worker', t);
  end loop;
end
$$;

grant select, insert, update, delete on all tables in schema reelplane to reelplane_api;
grant select on reelplane.projects, reelplane.webhook_endpoints to reelplane_worker;
grant select, insert, update on reelplane.videos, reelplane.renditions, reelplane.jobs,
  reelplane.video_events, reelplane.webhook_deliveries to reelplane_worker;
grant delete on reelplane.renditions to reelplane_worker;
-- The API never edits or deletes the audit trail.
revoke update, delete on reelplane.video_events from reelplane_api;

-- ---------------------------------------------------------------------------
-- API key authentication (runs before the project is known, so it bypasses RLS)
-- ---------------------------------------------------------------------------
create function reelplane.authenticate_api_key(p_key_hash bytea)
  returns table (key_id uuid, project_id uuid, kind text, allowed_origins text[])
  language plpgsql
  security definer
  set search_path = reelplane, pg_temp
  as $$
begin
  return query
    select k.id, k.project_id, k.kind, p.allowed_origins
      from reelplane.api_keys k
      join reelplane.projects p on p.id = k.project_id
     where k.key_hash = p_key_hash
       and k.revoked_at is null
       and (k.expires_at is null or k.expires_at > now());

  -- Publishable keys sit on the hot feed path: record usage at most once a minute.
  if found then
    update reelplane.api_keys
       set last_used_at = now()
     where key_hash = p_key_hash
       and (last_used_at is null or last_used_at < now() - interval '1 minute');
  end if;
end
$$;

revoke all on function reelplane.authenticate_api_key(bytea) from public;
grant execute on function reelplane.authenticate_api_key(bytea) to reelplane_api;
