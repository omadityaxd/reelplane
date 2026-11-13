-- Claims never reuse a storage prefix, and the sweeper never deletes a published one.
--
-- Before: a graceful release did `attempts = attempts - 1` (a shutdown isn't a failed attempt),
-- so the next claim got the same attempt number, and so the same attempt prefix, which the
-- release had just queued as storage garbage. Ten minutes later the sweeper could delete the
-- files of the video that next claim published. Fencing also only compared lease_owner, so a
-- frozen process restarted with the same worker id (Docker: same hostname, PID 1) passed it.
--
-- Now every claim gets the next value of this counter, which is never decremented; storage
-- prefixes and fencing both use it.
alter table reelplane.jobs add column claims integer not null default 0 check (claims >= 0);
update reelplane.jobs set claims = attempts;

-- Defence in depth for the sweeper: garbage rows for a prefix a video currently publishes
-- from are dropped, not deleted from storage. (A deleted video's whole folder,
-- media/<p>/<v>/, never equals an attempt prefix, so deletions still sweep everything.)
create index videos_playback_prefix_idx on reelplane.videos (playback_prefix)
  where playback_prefix is not null;

create function reelplane.drop_published_garbage() returns integer
  language plpgsql
  security definer
  set search_path = reelplane, pg_temp
  as $$
declare
  dropped integer;
begin
  delete from reelplane.storage_garbage g
   using reelplane.videos v
   where v.playback_prefix is not null and g.prefix = v.playback_prefix || '/';
  get diagnostics dropped = row_count;
  return dropped;
end
$$;
revoke all on function reelplane.drop_published_garbage() from public;
grant execute on function reelplane.drop_published_garbage() to reelplane_worker;
