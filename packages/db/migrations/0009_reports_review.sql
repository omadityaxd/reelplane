-- Reports: showcase videos are curated, so viewer reports never auto-hide them; and a hidden
-- video can be reviewed and shown again (its reports are cleared so they don't re-hide it).

create or replace function reelplane.hide_reported_video() returns trigger
  language plpgsql
  security definer
  set search_path = reelplane, pg_temp
  as $$
begin
  update reelplane.videos set hidden_at = now()
   where id = new.video_id and hidden_at is null and not is_showcase
     and (select count(*) from reelplane.video_reports where video_id = new.video_id) >= 3;
  return null;
end
$$;

-- The API role may clear reports of its own project's videos (RLS scopes the rows).
grant delete on reelplane.video_reports to reelplane_api;
