-- Webhooks (outbox written by the database), video deletion, and what the dashboard reads.

-- ---------------------------------------------------------------------------
-- Delivery log columns
-- ---------------------------------------------------------------------------
alter table reelplane.webhook_deliveries
  -- One id per event, shared by its deliveries to every endpoint: receivers dedupe on it.
  add column event_id         uuid not null default gen_random_uuid(),
  add column last_attempt_at  timestamptz,
  add column last_duration_ms integer check (last_duration_ms >= 0),
  -- The start of the receiver's response body, for the dashboard's delivery log.
  add column last_response    text check (length(last_response) <= 1024);

-- ---------------------------------------------------------------------------
-- video.ready / video.failed / video.deleted, queued by the status change itself
-- ---------------------------------------------------------------------------
-- Same pattern as the audit trail (0001): the outbox row is written in the transaction that
-- changes the status, by the database, so no code path (worker, API, cleanup job, psql) can
-- change a status without queueing its webhook, and a rolled-back change queues nothing.
create function reelplane.webhook_payload(v reelplane.videos, event_type text, event_id uuid)
  returns jsonb
  language sql stable
  as $$
    select jsonb_build_object(
      'id', event_id,
      'type', event_type,
      'createdAt', now(),
      'projectId', v.project_id,
      'data', jsonb_build_object('video', jsonb_strip_nulls(jsonb_build_object(
        'id', v.id,
        'status', v.status,
        'title', v.title,
        'creatorId', v.creator_id,
        'durationMs', v.duration_ms,
        'width', v.width,
        'height', v.height,
        'failureReason', case when v.status = 'failed' then v.failure_reason end,
        'metadata', v.metadata))))
  $$;

create function reelplane.queue_video_webhooks() returns trigger
  language plpgsql
  security definer
  set search_path = reelplane, pg_temp
  as $$
declare
  event_type text := 'video.' || new.status;
  event_id   uuid := gen_random_uuid();
begin
  insert into reelplane.webhook_deliveries (endpoint_id, project_id, event_type, event_id, payload)
  select e.id, e.project_id, event_type, event_id, reelplane.webhook_payload(new, event_type, event_id)
    from reelplane.webhook_endpoints e
   where e.project_id = new.project_id and e.enabled and event_type = any (e.events);
  return null;
end
$$;

create trigger videos_webhooks after update of status on reelplane.videos
  for each row
  when (new.status is distinct from old.status and new.status in ('ready', 'failed', 'deleted'))
  execute function reelplane.queue_video_webhooks();

-- ---------------------------------------------------------------------------
-- Deleting a video
-- ---------------------------------------------------------------------------
-- Deleted videos' objects (the published renditions and the original) are swept like any other
-- garbage, so the prefix check now also accepts a video's whole media and originals folders.
alter table reelplane.storage_garbage drop constraint storage_garbage_prefix_check;
alter table reelplane.storage_garbage add constraint storage_garbage_prefix_check
  check (prefix ~ '^media/[^/]+/[^/]+/([^/]+/)?$' or prefix ~ '^originals/[^/]+/[^/]+/$');

-- Marks a video of the current project deleted, cancels its queued job and queues its storage
-- for sweeping, in one transaction. A job already running notices at publish time (the video
-- is no longer 'processing') and discards its output. SECURITY DEFINER because the API role
-- has no access to storage_garbage; it checks the project itself.
-- Returns the previous status, or null if the project has no such (undeleted) video.
create function reelplane.delete_video(p_video_id uuid, p_grace interval default interval '10 minutes')
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

  update reelplane.jobs
     set state = 'cancelled', finished_at = now(), last_error = 'video deleted'
   where video_id = v.id and state = 'queued';
  update reelplane.videos set status = 'deleted', deleted_at = now() where id = v.id;

  insert into reelplane.storage_garbage (prefix, reason, not_before)
  values (format('media/%s/%s/', v.project_id, v.id), 'video deleted', now() + p_grace),
         (format('originals/%s/%s/', v.project_id, v.id), 'video deleted', now() + p_grace)
  on conflict (prefix) do nothing;
  return v.status;
end
$$;

revoke all on function reelplane.delete_video(uuid, interval) from public;
grant execute on function reelplane.delete_video(uuid, interval) to reelplane_api;
