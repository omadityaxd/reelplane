-- Storage garbage: object prefixes to delete, recorded in the SAME transaction that makes them
-- garbage (a reaped, failed or released attempt; a video deleted mid-processing). Workers sweep
-- it with SKIP LOCKED. This replaces best-effort cleanup, which the chaos test showed leaks
-- objects whenever the cleaning worker is itself killed.
create table reelplane.storage_garbage (
  prefix      text primary key check (prefix ~ '^media/[^/]+/[^/]+/[^/]+/$'),
  reason      text not null,
  -- Grace period so a paused-but-alive worker ("zombie") has stopped uploading before we sweep.
  not_before  timestamptz not null,
  attempts    integer not null default 0,
  last_error  text,
  created_at  timestamptz not null default now()
);
create index storage_garbage_due_idx on reelplane.storage_garbage (not_before);

alter table reelplane.storage_garbage enable row level security;
create policy storage_garbage_worker on reelplane.storage_garbage to reelplane_worker
  using (true) with check (true);
grant select, insert, update, delete on reelplane.storage_garbage to reelplane_worker;
