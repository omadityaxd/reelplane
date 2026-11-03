-- Hardening: rate limits, demo guardrails (quotas, reports), and the cleanup job.

-- ---------------------------------------------------------------------------
-- Rate limits (Postgres fallback; see apps/web/lib/server/rate-limit.ts)
-- ---------------------------------------------------------------------------
-- Fixed-window counters. UNLOGGED: no WAL, so a hit is cheap; after a crash the table is
-- emptied, which at worst forgives one window of traffic.
create unlogged table reelplane.rate_limits (
  bucket       text not null check (length(bucket) <= 300),
  window_start timestamptz not null,
  hits         integer not null default 1,
  primary key (bucket, window_start)
);
alter table reelplane.rate_limits enable row level security;

-- Counts one hit and returns the window's total. Keys are opaque strings built by the API, so
-- the function is SECURITY DEFINER and the API role has no direct access to the table.
create function reelplane.rate_limit_hit(p_bucket text, p_window_seconds integer)
  returns table (hits integer, reset_at timestamptz)
  language sql
  security definer
  set search_path = reelplane, pg_temp
  as $$
    insert into reelplane.rate_limits as r (bucket, window_start)
    values (p_bucket,
            to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds))
    on conflict (bucket, window_start) do update set hits = r.hits + 1
    returning r.hits, r.window_start + make_interval(secs => p_window_seconds)
  $$;
revoke all on function reelplane.rate_limit_hit(text, integer) from public;
grant execute on function reelplane.rate_limit_hit(text, integer) to reelplane_api;

-- ---------------------------------------------------------------------------
-- Demo uploads: per-user and whole-demo daily quotas
-- ---------------------------------------------------------------------------
-- One row per accepted demo upload, taken before the upload starts. Taking it under a lock on
-- the project row means concurrent requests can't both squeeze under the cap.
create table reelplane.demo_upload_quota (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references reelplane.projects (id) on delete cascade,
  user_id     uuid not null,
  created_at  timestamptz not null default now()
);
create index demo_upload_quota_idx on reelplane.demo_upload_quota (project_id, created_at);
alter table reelplane.demo_upload_quota enable row level security;

-- Returns 'ok', 'user_limit' or 'demo_limit' (UTC day). Only the current project's quota.
create function reelplane.take_demo_upload_quota(p_user_id uuid, p_per_user integer, p_per_demo integer)
  returns text
  language plpgsql
  security definer
  set search_path = reelplane, pg_temp
  as $$
declare
  project uuid := reelplane.current_project_id();
  day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
begin
  perform 1 from reelplane.projects where id = project and is_demo for update;
  if not found then
    raise exception 'not a demo project' using errcode = 'check_violation';
  end if;
  if (select count(*) from reelplane.demo_upload_quota
       where project_id = project and user_id = p_user_id and created_at >= day_start) >= p_per_user then
    return 'user_limit';
  end if;
  if (select count(*) from reelplane.demo_upload_quota
       where project_id = project and created_at >= day_start) >= p_per_demo then
    return 'demo_limit';
  end if;
  insert into reelplane.demo_upload_quota (project_id, user_id) values (project, p_user_id);
  return 'ok';
end
$$;
revoke all on function reelplane.take_demo_upload_quota(uuid, integer, integer) from public;
grant execute on function reelplane.take_demo_upload_quota(uuid, integer, integer) to reelplane_api;

-- ---------------------------------------------------------------------------
-- Reports: a video reported by 3 different viewers leaves every feed until reviewed
-- ---------------------------------------------------------------------------
alter table reelplane.videos add column hidden_at timestamptz;

create table reelplane.video_reports (
  video_id    uuid not null references reelplane.videos (id) on delete cascade,
  project_id  uuid not null references reelplane.projects (id) on delete cascade,
  -- HMAC of the reporter's address, so one viewer counts once and no address is stored.
  reporter    text not null check (length(reporter) <= 100),
  reason      text not null check (reason in ('spam', 'nudity', 'violence', 'copyright', 'other')),
  created_at  timestamptz not null default now(),
  primary key (video_id, reporter)
);
alter table reelplane.video_reports enable row level security;
create policy video_reports_tenant on reelplane.video_reports to reelplane_api
  using (project_id = reelplane.current_project_id())
  with check (project_id = reelplane.current_project_id());
grant select, insert on reelplane.video_reports to reelplane_api;

create function reelplane.hide_reported_video() returns trigger
  language plpgsql
  security definer
  set search_path = reelplane, pg_temp
  as $$
begin
  update reelplane.videos set hidden_at = now()
   where id = new.video_id and hidden_at is null
     and (select count(*) from reelplane.video_reports where video_id = new.video_id) >= 3;
  return null;
end
$$;
create trigger video_reports_hide after insert on reelplane.video_reports
  for each row execute function reelplane.hide_reported_video();

-- ---------------------------------------------------------------------------
-- Deleting videos: one internal routine for the API and the cleanup job
-- ---------------------------------------------------------------------------
create function reelplane.delete_video_row(v reelplane.videos, p_grace interval) returns void
  language plpgsql
  security definer
  set search_path = reelplane, pg_temp
  as $$
begin
  update reelplane.jobs
     set state = 'cancelled', finished_at = now(), last_error = 'video deleted'
   where video_id = v.id and state = 'queued';
  update reelplane.videos set status = 'deleted', deleted_at = now() where id = v.id;
  insert into reelplane.storage_garbage (prefix, reason, not_before)
  values (format('media/%s/%s/', v.project_id, v.id), 'video deleted', now() + p_grace),
         (format('originals/%s/%s/', v.project_id, v.id), 'video deleted', now() + p_grace)
  on conflict (prefix) do nothing;
end
$$;
revoke all on function reelplane.delete_video_row(reelplane.videos, interval) from public;

create or replace function reelplane.delete_video(p_video_id uuid, p_grace interval default interval '10 minutes')
  returns text
  language plpgsql
  security definer
  set search_path = reelplane, pg_temp
  as $$
declare
  v reelplane.videos;
begin
  select * into v from reelplane.videos
   where id = p_video_id and project_id = reelplane.current_project_id() and status <> 'deleted'
   for update;
  if not found then
    return null;
  end if;
  perform reelplane.delete_video_row(v, p_grace);
  return v.status;
end
$$;

-- ---------------------------------------------------------------------------
-- The cleanup job (called by the worker's housekeeping; safe to call from many workers)
-- ---------------------------------------------------------------------------
create table reelplane.maintenance (
  task        text primary key,
  last_run_at timestamptz not null
);
alter table reelplane.maintenance enable row level security;

-- Runs at most once per p_every across all workers (an advisory lock plus the last-run time).
-- Returns what it did, including the multipart uploads the caller must abort in storage.
create function reelplane.run_cleanup(
  p_every interval default interval '10 minutes',
  p_demo_max_age interval default interval '7 days',
  p_batch integer default 100
) returns jsonb
  language plpgsql
  security definer
  set search_path = reelplane, pg_temp
  as $$
declare
  v reelplane.videos;
  demo_deleted integer := 0;
  stale_deleted integer := 0;
  aborts jsonb := '[]';
  idempotency integer;
  windows integer;
  quotas integer;
begin
  if not pg_try_advisory_xact_lock(hashtext('reelplane.run_cleanup')) then
    return jsonb_build_object('ran', false, 'reason', 'another worker is running it');
  end if;
  if exists (select 1 from reelplane.maintenance
              where task = 'cleanup' and last_run_at > now() - p_every) then
    return jsonb_build_object('ran', false, 'reason', 'ran recently');
  end if;
  insert into reelplane.maintenance (task, last_run_at) values ('cleanup', now())
  on conflict (task) do update set last_run_at = excluded.last_run_at;

  -- Demo uploads expire after 7 days; showcase videos are kept.
  for v in
    select vid.* from reelplane.videos vid join reelplane.projects p on p.id = vid.project_id
     where p.is_demo and not vid.is_showcase and vid.status <> 'deleted'
       and vid.created_at < now() - p_demo_max_age
     order by vid.created_at
     limit p_batch
     for update of vid skip locked
  loop
    perform reelplane.delete_video_row(v, interval '0');
    demo_deleted := demo_deleted + 1;
  end loop;

  -- Abandoned uploads (the session expired an hour ago): free the video row and its parts.
  for v in
    select * from reelplane.videos
     where status = 'uploading' and upload_expires_at < now() - interval '1 hour'
     order by upload_expires_at
     limit p_batch
     for update skip locked
  loop
    perform reelplane.delete_video_row(v, interval '0');
    if v.upload_id is not null then
      aborts := aborts || jsonb_build_object('key', v.source_key, 'uploadId', v.upload_id);
    end if;
    stale_deleted := stale_deleted + 1;
  end loop;

  delete from reelplane.idempotency_keys where created_at < now() - interval '24 hours';
  get diagnostics idempotency = row_count;
  delete from reelplane.rate_limits where window_start < now() - interval '1 hour';
  get diagnostics windows = row_count;
  delete from reelplane.demo_upload_quota where created_at < now() - interval '2 days';
  get diagnostics quotas = row_count;

  return jsonb_build_object(
    'ran', true,
    'demoVideosDeleted', demo_deleted,
    'abandonedUploadsDeleted', stale_deleted,
    'idempotencyKeysDeleted', idempotency,
    'rateLimitWindowsDeleted', windows,
    'quotaRowsDeleted', quotas,
    'aborts', aborts);
end
$$;
revoke all on function reelplane.run_cleanup(interval, interval, integer) from public;
grant execute on function reelplane.run_cleanup(interval, interval, integer) to reelplane_worker;
