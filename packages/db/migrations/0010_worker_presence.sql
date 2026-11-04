-- Worker presence: the worker may run on a laptop that is often off, so the app shows when
-- uploads will wait. Each worker stamps this from its housekeeping loop (every ~20 s).

create function reelplane.worker_seen() returns void
  language sql
  security definer
  set search_path = reelplane, pg_temp
  as $$
    insert into reelplane.maintenance (task, last_run_at) values ('worker:seen', now())
    on conflict (task) do update set last_run_at = excluded.last_run_at
  $$;
revoke all on function reelplane.worker_seen() from public;
grant execute on function reelplane.worker_seen() to reelplane_worker;

-- When any worker was last seen (null: never). Readable by the API for status messages.
create function reelplane.worker_last_seen() returns timestamptz
  language sql
  stable
  security definer
  set search_path = reelplane, pg_temp
  as $$ select last_run_at from reelplane.maintenance where task = 'worker:seen' $$;
revoke all on function reelplane.worker_last_seen() from public;
grant execute on function reelplane.worker_last_seen() to reelplane_api;

-- The daily cron (Vercel) runs the same cleanup as the worker, as the worker role.
grant execute on function reelplane.run_cleanup(interval, interval, integer) to reelplane_worker;
