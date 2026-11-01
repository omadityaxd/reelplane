# Benchmarks

Measured numbers only. Each entry says what ran, on what hardware, and how to reproduce it.
Rows still marked _pending_ have not been measured yet; they are never estimated.

**Hardware (laptop):** Intel Core i7-14650HX (16 cores / 24 threads), 16 GB RAM, Windows 11,
Docker Desktop. Postgres 18.6 and RustFS 1.0.4 run locally in Docker.

## Swipe-to-play: with vs without preloading

**Swipe-to-play** is the time from a swipe to the next video's first _painted_ frame
(`requestVideoFrameCallback`), measured by [`/bench`](../apps/web/app/bench/bench-runner.tsx).

**Method.**
- **Browser and build:** Chrome via DevTools, emulating a 390x844 @3x touch phone, against the
  production build (`next start`).
- **Content:** the same 30 bench videos (6 licensed clips × 5 copies, each a distinct video
  with its own URLs), 2–3 s of viewing between swipes.
- **Cold cache in both modes:** every run is a fresh page in its own browser context, and every
  media URL carries a per-run nonce.
- **Same network for both modes:** each pair ran under the same DevTools throttle preset.
- **Raw samples:** [`benchmarks/swipe-to-play-*.json`](benchmarks/).

| Network (Chrome preset) | Without preloading                | With preloading + warm next   | Faster by     |
| ----------------------- | --------------------------------- | ----------------------------- | ------------- |
| **Fast 4G**, 25 swipes  | p50 **916 ms** · p95 **1139 ms**  | p50 **36 ms** · p95 **94 ms** | **25×** (p50) |
| **Slow 4G**, 20 swipes  | p50 **2551 ms** · p95 **2758 ms** | p50 **36 ms** · p95 **56 ms** | **71×** (p50) |

With preloading, every swipe in both runs landed on an already-buffered video, so the network
drops out of swipe-to-play entirely: the result is the same on Fast and Slow 4G. Without it, each
swipe waits for the master playlist, the variant playlist, the init segment and the first media
segment, so the cost grows as the network gets worse.

**How the preloading number was reached** (each step measured):

| Version                                        | Fast 4G p50 / p95 | What changed                                                 |
| ---------------------------------------------- | ----------------- | ------------------------------------------------------------ |
| Preload only (first build)                     | 184 / 205 ms      | —                                                            |
| Skip the needless seek to 0                    | 152 / 167 ms      | promoting a preloaded video no longer sets `currentTime = 0` |
| Defer other slots' setup until the first frame | 172 / 209 ms      | **no gain, reverted**                                        |
| **Warm the next video**                        | **36 / 94 ms**    | N+1 plays one muted offscreen frame, re-warmed every 4 s     |

The warm-up step came from measuring Chrome directly. A preloaded `<video>` that has _never
played_ took 140–210 ms from `play()` to its first new frame, with the whole clip already
buffered. The decoder and renderer start lazily on first play and are torn down again some
seconds after a pause. A video that played moments earlier started in 6–25 ms. With 9 s of
viewing between swipes (8 swipes), warmed swipe-to-play stayed at p50 44 ms / p95 52 ms, so the
periodic re-warm works.

**Not yet measured:** iPhone Safari/Chrome (native HLS, WebKit) on a real device. See Phase 5 notes.

## Time to first frame

From the same runs: **TTFF** = the SDK's own metric, from a video becoming active to its first
painted frame.

|                                                                 | p50     | p95     | n   |
| --------------------------------------------------------------- | ------- | ------- | --- |
| After a swipe, preloaded (Fast 4G)                              | 32 ms   | 93 ms   | 25  |
| After a swipe, not preloaded (Fast 4G)                          | 914 ms  | 1137 ms | 25  |
| First video of a page, activation → first frame (Fast 4G)       | 1163 ms | 1621 ms | 10  |
| First video of a page, navigation start → first frame (Fast 4G) | 1669 ms | 3457 ms | 10  |

The first-video p95 is the first load of the page, before the JS bundle and the lazily loaded
hls.js chunk were cached. During startup the feed shows the blurred inline placeholder and then
the poster, so the screen is never blank. The first video still costs four sequential requests;
shortening that is future work (for example, inlining the first rendition's playlists in the
feed response).

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

- Swipe-to-play and TTFF on a real iPhone (Safari and Chrome, native HLS)
- Feed API p95 under load, k6 (Phase 7)

## SDK size

`tsc` output, unminified, all modules included (2026-11-01):

| Package | Raw | gzip |
| --- | --- | --- |
| `@reelplane/sdk-core` (player, preloading, metrics and the resumable uploader) | 38.1 KB | 10.8 KB |
| `@reelplane/sdk-react` (`<ReelFeed />` + styles) | 14.7 KB | 4.9 KB |

hls.js is not included: it is a dynamic `import()`, so bundlers split it into a separate chunk,
loaded on first playback and never on Apple devices (native HLS). Both packages are
`sideEffects: false` and tree-shake: an app that only uses `uploadVideo` doesn't ship the player.
