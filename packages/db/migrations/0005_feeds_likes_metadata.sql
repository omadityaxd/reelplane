-- Developer-supplied metadata (e.g. credits for licensed clips), likes counter, feed indexes.

alter table reelplane.videos
  add column metadata jsonb not null default '{}'
  check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 4096);

-- likes_count is maintained by the database, so it can never drift from the likes table.
create function reelplane.count_likes() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'INSERT' then
    update reelplane.videos set likes_count = likes_count + 1 where id = new.video_id;
  else
    update reelplane.videos set likes_count = greatest(likes_count - 1, 0) where id = old.video_id;
  end if;
  return null;
end
$$;

create trigger likes_count after insert or delete on reelplane.likes
  for each row execute function reelplane.count_likes();

-- Trending considers recent ready videos; this index serves that candidate scan.
create index videos_ready_recent_idx on reelplane.videos (project_id, ready_at desc)
  where status = 'ready';
