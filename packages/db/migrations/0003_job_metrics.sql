-- Measured per-job numbers (transcode wall time, media duration, speed vs realtime).
-- Written by the worker when a job succeeds; read by the dashboard and docs/BENCHMARKS.md.
alter table reelplane.jobs add column metrics jsonb;
