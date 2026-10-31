-- Upload sessions: a browser uploads with a short-lived token scoped to one video, never with
-- a project API key. The token is random (32 bytes); only its SHA-256 is stored.

alter table reelplane.videos
  add column upload_token_hash   bytea,
  add column part_size_bytes     integer check (part_size_bytes > 0),
  add column original_filename   text check (length(original_filename) <= 255),
  add column declared_duration_ms integer check (declared_duration_ms >= 0);

-- Resolves an upload token to its project before any tenant context exists (hence SECURITY
-- DEFINER). Status is returned rather than filtered so a replayed "complete" can be answered.
create function reelplane.authenticate_upload_token(p_video_id uuid, p_token_hash bytea)
  returns table (project_id uuid, status text, allowed_origins text[])
  language sql
  stable
  security definer
  set search_path = reelplane, pg_temp
  as $$
    select v.project_id, v.status, p.allowed_origins
      from reelplane.videos v
      join reelplane.projects p on p.id = v.project_id
     where v.id = p_video_id
       and v.upload_token_hash = p_token_hash
       and v.upload_expires_at > now()
  $$;

revoke all on function reelplane.authenticate_upload_token(uuid, bytea) from public;
grant execute on function reelplane.authenticate_upload_token(uuid, bytea) to reelplane_api;
