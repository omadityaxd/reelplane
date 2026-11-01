-- The output frame rate of each rendition (preserved from the source: 24/25/30/50/60…), shown
-- by the player's debug overlay and used to check the ladder never drops frames.
alter table reelplane.renditions
  add column fps numeric(7, 3) check (fps > 0 and fps <= 240);
