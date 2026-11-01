# Benchmarks

Measured numbers only. Each entry says what ran, on what hardware, and how to reproduce it.
Rows still marked _pending_ have not been measured yet; they are never estimated.

**Hardware (laptop):** Intel Core i7-14650HX (16 cores / 24 threads), 16 GB RAM, Windows 11,
Docker Desktop. Postgres 18.6 and RustFS 1.0.4 run locally in Docker.

## Chaos test: the queue under hard kills

`pnpm worker:chaos -- -jobs 100 -workers 4 -kill-min 800ms -kill-max 2500ms -seed 7`, run on
2026-11-01. Raw output: [`benchmarks/chaos-100-jobs.json`](benchmarks/chaos-100-jobs.json).

Every 0.8–2.5 s a random worker process was terminated with `TerminateProcess` (no signal
handler, no cleanup, FFmpeg killed with it) and restarted 0.2–1.5 s later. Lease 4 s, heartbeat
1 s. Each job transcodes an 8 s 720x1280 clip into 3 renditions.

| Measure                                               | Result                                  |
| ----------------------------------------------------- | --------------------------------------- |
| Jobs                                                  | 100                                     |
| Workers killed                                        | **64** (59 while holding a job)         |
| Jobs recovered after a lease expired                  | 59                                      |
| Attempts per job                                      | 1: 64 jobs · 2: 21 · 3: 8 · 4: 6 · 5: 1 |
| **Jobs succeeded**                                    | **100 / 100**                           |
| **Videos completed exactly once**                     | **100 / 100**                           |
| Videos with duplicate jobs                            | **0**                                   |
| Playlists complete in storage (every segment present) | 100 / 100                               |
| Orphaned objects left by killed attempts              | **0**                                   |
| Wall time                                             | 1 min 49 s                              |

The same configuration with 40 jobs and 3 workers (seed 42) also passes: 18 kills, 40/40 exactly
once, 0 orphans. The first run of that configuration found **46 orphaned objects**, which led to
the transactional `storage_garbage` cleanup (see [ARCHITECTURE.md](ARCHITECTURE.md)).

**What this does not cover:** a hard-killed process cannot come back as a zombie, so "zombie
completions rejected" is 0 here. Fencing against a _paused-but-alive_ worker is covered by the
tests `TestQueue/a_worker_whose_lease_was_reaped_cannot_complete_the_job_(fencing)` and
`TestAWorkerThatLosesItsLeaseStopsAndDoesNotPublish`.

## Transcode speed

Speed = seconds of source video per second of encoding, for all three rungs (240p/480p/720p)
together, `-preset veryfast`, 720x1280 30 fps source with AAC audio.

| Where                                     | Speed                            | Notes                                           |
| ----------------------------------------- | -------------------------------- | ----------------------------------------------- |
| Laptop, 4 workers in parallel (chaos run) | 7.2× realtime (mean of 100 jobs) | CPU shared by 4 encodes                         |
| Laptop, 3 workers in parallel (chaos run) | 9.1× realtime (mean of 40 jobs)  |                                                 |
| Laptop, worker in Docker, single job      | 6.4× realtime                    | one 6 s upload via the real API                 |
| Free 2-vCPU worker host                   | _pending_                        | to measure with `docker run --cpus=2` (Phase 7) |

## Pending

These will be filled in by the phases that build them:

- Time to first frame, p50/p95 (Phase 5)
- Swipe-to-play time with and without preloading (Phase 5)
- Feed API p95 under load, k6 (Phase 7)
