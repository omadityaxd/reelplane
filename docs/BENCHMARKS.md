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

**Current build** (start at 720p, preload capped at ~4 s, warm next; 40 bench videos including
1080p60 clips; measured 2026-11-01):

| Network (Chrome preset) | Without preloading                | With preloading + warm next   | Faster by     |
| ----------------------- | --------------------------------- | ----------------------------- | ------------- |
| **Fast 4G**, 25 swipes  | p50 **1081 ms** · p95 **1381 ms** | p50 **35 ms** · p95 **75 ms** | **31×** (p50) |

Starting on 720p instead of 240p makes the first segment bigger, so the no-preload path got
slower (916 → 1081 ms p50). That is the price of a sharp first frame, and preloading hides it
completely. Earlier build (240p start, whole-clip preloads, 30 bench videos):

| Network (Chrome preset) | Without preloading        | With preloading + warm next | Faster by |
| ----------------------- | ------------------------- | --------------------------- | --------- |
| Fast 4G, 25 swipes      | p50 916 ms · p95 1139 ms  | p50 36 ms · p95 94 ms       | 25× (p50) |
| Slow 4G, 20 swipes      | p50 2551 ms · p95 2758 ms | p50 36 ms · p95 56 ms       | 71× (p50) |

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

### On a real iPhone

**Setup:** a real iPhone (iOS, native HLS in WebKit) on home Wi-Fi. The laptop above serves
everything: `next start`, RustFS and Postgres, started with `pnpm phone`. No throttling and no
CDN, so these are local-network numbers, not mobile-network ones. Measured 2026-11-02 by the
project author, on the same bench videos as the Chrome run above. The current numbers are the
third (Chrome on iOS) and fourth (Safari) runs below.

| Mode                   | Swipes                | Swipe-to-play                                  |
| ---------------------- | --------------------- | ---------------------------------------------- |
| With preloading + warm | 25/25, 0 timeouts     | p50 **69 ms** · p95 **389 ms**                 |
| Without preloading     | **partial run: 2/25** | about 1.7–2.8 s per swipe (full run to follow) |

**Playback on the same iPhone** (`?debug=1`, sound on, after the warm-up mute fix): 0 stalls on 3
of 4 videos and one 0.1 s stall on the fourth, 0 dropped frames, buffer held 6–12 s ahead.

**Why p95 is 5.6× p50 on the iPhone (vs 2.1× in Chrome).** With 25 swipes, p95 is the
second-slowest swipe, so 389 ms says at least two swipes took 389 ms or more; half took 69 ms
or less. The iPhone run recorded only p50/p95, so the two slow swipes can't be attributed
yet. In the latest Chrome run the slowest swipe was the first (150 ms, while the page was still
setting up the other preloads); in the run before, it was swipe 24 (130 ms). The likely causes on iOS, none measured yet:

- the target video was not warmed yet;
- the target was not buffered far enough (iOS decides how much a paused `<video>` loads);
- WebKit set up a new player for the video entering N+2 at the same moment as the swipe.

`/bench` now records the target video's state at each swipe (`readyState`, seconds buffered,
whether the warmer had played it). When a run finishes it shows the 3 slowest swipes on screen.
The next iPhone run will say which cause it is. No change to the player until then: an
unmeasured "fix" could just as well make it worse.

**Second iPhone run: Chrome on iOS** (WebKit underneath, so native HLS like Safari), same Wi-Fi,
`pnpm phone`, `/bench?preload=1`, measured 2026-11-15 by the project author:

| Swipes            | p50       | p95          | Slowest three (swipe: ms, state of the target at the swipe)                      |
| ----------------- | --------- | ------------ | -------------------------------------------------------------------------------- |
| 25/25, 0 timeouts | **99 ms** | **14215 ms** | #2: 15686 · #9: 14215 · #14: 11759; all `readyState` 4, ~11.9 s buffered, warmed |

**The p95 is not a player measurement, and it should not be quoted as one.** With 25 swipes, p95
is the second-slowest swipe, so these three outliers alone set it. All three targets were fully
loaded at the swipe (`readyState` 4, the whole 12 s clip buffered, already warmed), so the
network was not the cause. A 12–16 s wait with everything loaded means the page was not playing
at all. The screenshot of the run shows iOS's "◀" back link to another app, so the run was interrupted by
an app switch at least once. That run's `/bench` could not record visibility, so the cause of
each outlier can't be proven from it.

**What the outliers led to:**

- **A real bug, fixed:** a swipe right before the page was hidden started `play()` while hidden.
  If the browser refused it, nothing resumed the video when the page came back: it waited for
  a tap, fully buffered, exactly as in these three swipes. The visibility handler now resumes the
  active video on return unless the viewer paused it (`controller.test.ts`, "starts the
  swiped-to video when the page comes back").
- **`/bench` now records why a swipe was slow:** whether the page was hidden at the swipe and for
  how long before the frame, when the player called `play()` and how it settled (resolved,
  rejected and why, still pending), and whether autoplay was refused. Statistics use visible
  time only. Hidden or refused swipes are flagged (⚑), and a "clean" p50/p95 leaves them out.

**Third iPhone run: Chrome on iOS, with the fix and the diagnostics** (same Wi-Fi, `pnpm phone`,
`/bench?preload=1`, reported 2026-11-16 by the project author). **These are the iPhone numbers to
quote:**

| Swipes                       | Clean (22 unflagged swipes) | All completed swipes, visible time | Flagged | Timeouts |
| ---------------------------- | --------------------------- | ---------------------------------- | ------- | -------- |
| 25 attempts, 24 with a frame | **p50 83 ms · p95 116 ms**  | p50 83 ms · p95 303 ms             | 3       | 1        |

All three flagged swipes had the page hidden at the swipe. They were two events, not three:

- **An app switch (67.7 s).** It caused the run's only timeout. The bench then retried the same
  video while iOS was still handing the page back (the retry's 19 ms "hidden" is the tail of the
  same switch). That video's `play()` from before the switch went through on return, 501 ms
  after the retry. The old display listed both attempts as "swipe 16"; rows are now numbered per
  attempt, retries are marked, and a `play()` still in flight from before the swipe is reported
  as such.
- **A 346 ms blip** with no app switch noticed. `play()` was called the moment the page was
  back (+340 ms), and the first frame came 303 ms after that, against ~80 ms for a warmed swipe:
  the video started cold. WebKit is known to deliver `visibilitychange` unreliably on iOS: it
  suspends a hidden page's process, and the system app switcher and Safari's own tab switcher
  don't fire it when opened. Notification banners and Control Center are not reported to hide
  the page. A brief trip into Chrome's own UI or a partial app-switcher swipe fits, but the run
  can't say which. Since then, when the page comes back (on `visibilitychange` or `pageshow`)
  the player re-warms the next video at once instead of at the next 4 s warm-up, so the swipe
  after a hide is not also cold.

**Fourth iPhone run: Safari** (same iPhone and Wi-Fi, `pnpm phone`, `/bench?preload=1`, reported
2026-11-16 by the project author). It replaces the 2026-11-02 Safari run at the top of this
section, which predates the diagnostics and the visibility fixes:

| Browser                  | Swipes         | p50 (clean) | p95 (clean) | Flagged | Timeouts |
| ------------------------ | -------------- | ----------- | ----------- | ------- | -------- |
| Safari                   | 25/25          | **95 ms**   | **133 ms**  | 0       | 0        |
| Chrome on iOS (3rd run)  | 22 clean of 25 | **83 ms**   | **116 ms**  | 3       | 1        |
| Safari, 2026-11-02 (old) | 25/25          | 69 ms       | 389 ms      | –       | 0        |

Nothing in the Safari run was flagged, so its p50/p95 are clean as measured. The three slowest
swipes (149, 133 and 124 ms) all look like the typical one: the player called `play()` 6–7 ms after
the swipe, it resolved by 13–16 ms, and the target was `readyState` 4, fully buffered (10.9 s) and
warmed. The other ~110–135 ms is WebKit getting the first new frame to the screen after `play()`
resolves, which the player does not control. Safari and Chrome on iOS use the same engine; the
12 ms gap in p50 is within what one 25-swipe run per browser can resolve. The old run's 389 ms p95
was most likely the same kind of hidden-page outlier the third run found; it could not record why.

### What warming and preloading cost

Measured in Chrome over 60 s spent on one video, with N+1 warmed and N+2 preloaded
(`/bench?warm=1`, 2026-11-01).

|                           | Playing video (N) | Warmed next video (N+1)                    | Preloaded (N+2) |
| ------------------------- | ----------------- | ------------------------------------------ | --------------- |
| Frames decoded per minute | 1422              | **18** (+1.3% decode work)                 | 0               |
| Extra data per minute     | —                 | **0** (it replays already-buffered frames) | 0               |
| Buffered ahead, held      | whole clip        | 3.95 s                                     | 3.95 s          |

- **Warming's cost is decode work, not data:** about 1.3% more frames decoded than playback
  alone, and 0 bytes. Battery use on a real phone was not measured (no device instrumentation
  here); decoded frames are the proxy.
- **Preloading was the real data cost.** hls.js treats `maxBufferLength` as a _minimum_ and kept
  buffering up to 60 MB / 600 s, so N+1 and N+2 each downloaded their whole clip. Preloads are
  now hard-capped (`maxMaxBufferLength`) at ~4 s, two 2-second segments. At the 720p60 rung that
  is ~1.7 MB per video swiped past, instead of the entire video.
- **Adaptive:** warming switches off with Data Saver, on slow networks (2g/3g or a measured
  estimate under 2.5 Mbps), with `prefers-reduced-data`, and on a low battery (< 20%, not
  charging; Battery API, Chromium only). Off, swipe-to-play falls back to the "preload only"
  numbers above (~150 ms). iOS Safari exposes none of these signals, but Low Power Mode refuses
  autoplay, and the warmer then stops by itself.

## Ladder quality

VMAF (phone model, `vmaf_v0.6.1` with `enable_transform`) and SSIM, measured by
[`cmd/ladder-quality`](../services/worker/cmd/ladder-quality/main.go). Each rung is encoded with
the pipeline's exact settings (x264 `veryfast`, capped VBR, 2 s GOP, source frame rate),
upscaled to the viewing size (1080x1920, or the source size if smaller), and compared with the
source. The first 10 s of each clip; raw output in [`benchmarks/ladder-*.json`](benchmarks/).

**Final ladder.** ≤30 fps targets are 300 / 1000 / 2500 / 4500 kbps; above 30 fps they are ×1.5.

| Source                      | Rung              | Actual kbps | VMAF (phone) | SSIM   |
| --------------------------- | ----------------- | ----------- | ------------ | ------ |
| BBB 1080x1920 **60 fps**    | 240p              | 484         | 80.71        | 0.9863 |
|                             | 480p              | 1494        | 96.14        | 0.9944 |
|                             | 720p              | 3624        | 99.66        | 0.9974 |
|                             | **1080p**         | 6727        | 99.99        | 0.9986 |
| BBB 1080x1920 30 fps        | 240p              | 311         | 79.32        | 0.9848 |
|                             | 480p              | 955         | 95.97        | 0.9934 |
|                             | 720p              | 2300        | 99.61        | 0.9969 |
|                             | 1080p             | 4228        | 99.96        | 0.9983 |
| Sintel 460x818 24 fps       | 240p              | 298         | 93.39        | 0.9762 |
|                             | **460p (native)** | 860         | 99.33        | 0.9910 |
| BBB trailer 608x1080 25 fps | 240p              | 233         | 86.70        | 0.9553 |
|                             | 480p              | 628         | 96.94        | 0.9842 |
|                             | **608p (native)** | 1023        | 98.84        | 0.9918 |

**How the bitrates were chosen.** A sweep at 0.35× / 0.6× / 1× / 1.4× of each target on the
1080x1920 clip (at 60 and 30 fps) showed animation compresses very easily: 720p at 30 fps
already reaches VMAF 98.7 at 1.6 Mbps. The ladder deliberately keeps headroom above what
animation needs, for camera footage (sensor noise, fine texture). **The targets have not yet
been validated on real phone footage.** When phone clips are added, run
`go run ./cmd/ladder-quality <clip>` and adjust the table in
[`ladder.go`](../services/worker/internal/media/ladder.go).

**Why Sintel looked soft on the iPhone.** After the letterbox crop, Sintel is 460x818: below the
480p rung. "Never upscale" therefore gave it **only the 240p rendition**, which the phone stretched
to its 1170 px-wide screen. Sources more than 20% above their highest standard rung now get an
extra native-resolution rung (460p here, VMAF 99.3). The phone was also starting every video on
240p, because the master playlist listed 240p first and Safari starts on the first variant.

**Frame rate** is preserved: 24, 25, 30, 50 and 60 fps (exact rational rates such as
30000/1001) are never capped. Each rendition is encoded at the source rate; the 60 fps test
confirms 60/1 on every rung including 720p and 1080p. Variable-rate phone clips snap to the
nearest standard rate. Only high-speed captures above 60 fps (120/240 fps slow-motion) are
reduced to 60.

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
the poster, so the screen is never blank.

### First video: inlining its playlists

Before, the first video cost four sequential requests before a frame: the master playlist, the
variant playlist, the init segment and the first segment. Now the feed's first page carries the
first video's master and starting variant playlists (read from storage once, then cached in
memory), and the SDK hands them to hls.js through its playlist loader. The first video goes
straight to the segments.

`pnpm --filter @reelplane/web bench:first-frame 10 <label>`
([script](../apps/web/scripts/bench-first-frame.ts)). Each run is a fresh Chrome context on a
390x844 @3x touch phone, under the DevTools "Fast 4G" throttle (9 Mbps × 0.9 down, 165 ms
latency), loading `/bench`, which fetches its first page in the browser. Both builds were
measured the same day, against the same local stack and bench videos (2026-11-13). Raw output:
[`first-frame-before.json`](benchmarks/first-frame-before.json) and
[`first-frame-after.json`](benchmarks/first-frame-after.json).

| First video, n = 10 each       | Before (p50 · p95) | After (p50 · p95)     | Change             |
| ------------------------------ | ------------------ | --------------------- | ------------------ |
| Activation → first frame       | 1919 ms · 2190 ms  | **1205 ms · 1364 ms** | **−714 ms (−37%)** |
| Navigation start → first frame | 2829 ms · 3085 ms  | **2092 ms · 2233 ms** | **−737 ms (−26%)** |

- **These "before" numbers are higher than the 1163 ms above.** That table came from the
  DevTools-driven runs of 2026-11-01; this script is a different harness (Playwright's Chrome,
  CDP throttling). Compare within a table, not across them.
- **Cross-check:** two runs in the DevTools-driven Chrome gave 2086 and 1598 ms after the change.
  In the second (the only one inspected), resource timing showed no playlist request for the
  first video before its first segment.
- **Where it doesn't help yet:**
  - **Native HLS** (Safari, every iOS browser) loads playlists itself, so iPhones still make the
    two requests.
  - **Slow networks:** there the SDK starts from the low-start master (`hlsLowStartUrl`), which
    isn't inlined.

## Chaos test: the queue under hard kills

`pnpm worker:chaos -jobs 100 -workers 4 -kill-min 800ms -kill-max 2500ms -seed 7`, run on
2026-11-01 and again on 2026-11-13, after the claim counter (migration 0011) and the worker
robustness changes (deadlines, the download cap, the FFmpeg input guard). Raw output:
[`benchmarks/chaos-100-jobs.json`](benchmarks/chaos-100-jobs.json) and
[`benchmarks/chaos-100-jobs-2026-11-13.json`](benchmarks/chaos-100-jobs-2026-11-13.json).

Every 0.8–2.5 s a random worker process was terminated with `TerminateProcess` (no signal
handler, no cleanup, FFmpeg killed with it) and restarted 0.2–1.5 s later. Lease 4 s, heartbeat
1 s. Each job transcodes an 8 s 720x1280 clip into 3 renditions.

| Measure                                               | 2026-11-01                              | 2026-11-13                               |
| ----------------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| Jobs                                                  | 100                                     | 100                                      |
| Workers killed                                        | **64** (59 while holding a job)         | **72** (65 while holding a job)          |
| Jobs recovered after a lease expired                  | 59                                      | 64                                       |
| Attempts per job                                      | 1: 64 jobs · 2: 21 · 3: 8 · 4: 6 · 5: 1 | 1: 60 jobs · 2: 24 · 3: 10 · 4: 4 · 5: 2 |
| **Jobs succeeded**                                    | **100 / 100**                           | **100 / 100**                            |
| **Videos completed exactly once**                     | **100 / 100**                           | **100 / 100**                            |
| Videos with duplicate jobs                            | **0**                                   | **0**                                    |
| Playlists complete in storage (every segment present) | 100 / 100                               | 100 / 100                                |
| Orphaned objects left by killed attempts              | **0**                                   | **0**                                    |
| Mean transcode speed (3 rungs, 4 workers sharing CPU) | 7.2× realtime                           | 7.4× realtime                            |
| Wall time                                             | 1 min 49 s                              | 2 min 5 s                                |

The same configuration with 40 jobs and 3 workers (seed 42) also passes: 18 kills, 40/40 exactly
once, 0 orphans. The first run of that configuration found **46 orphaned objects**, which led to
the transactional `storage_garbage` cleanup (see [ARCHITECTURE.md](ARCHITECTURE.md)).

**What this does not cover:** a hard-killed process cannot come back as a zombie, so "zombie
completions rejected" is 0 here. Fencing against a _paused-but-alive_ worker is covered by the
tests `TestQueue/a_worker_whose_lease_was_reaped_cannot_complete_the_job_(fencing)` and
`TestAWorkerThatLosesItsLeaseStopsAndDoesNotPublish`.

## Transcode speed

Speed = seconds of source video per second of encoding, for the whole ladder in one FFmpeg run,
`-preset veryfast`.

**The showcase set on a 2-vCPU worker** (`pnpm bench:transcode`). The worker's Docker image ran
with `--cpus=2`, the size of a small free VM, on 11 clips (144 s of video). Each clip went
through the real API and upload path; raw results are in
[`benchmarks/transcode-*.json`](benchmarks/). Measured 2026-11-03.

| Clip                                           | Ladder                    | First run  | With the thread cap |
| ---------------------------------------------- | ------------------------- | ---------- | ------------------- |
| Sintel 460x818 @ 24 fps, 12 s (×3)             | 240p, native 460p         | 1.14–1.45× | **4.19–4.64×**      |
| Big Buck Bunny 608x1080 @ 25 fps, 10–11 s (×3) | 240p, 480p, native 608p   | 1.67–1.84× | **2.57–2.64×**      |
| Phone clips 576x1024 @ 30 fps, 10–27 s (×3)    | 240p, 480p, native 576p   | 1.11–1.23× | **2.75–2.97×**      |
| Big Buck Bunny 1080x1920 @ 60 fps, 12 s (×2)   | 240p–1080p, all at 60 fps | 0.06–0.07× | **0.37×**           |
| **All 11 clips**                               |                           | **0.32×**  | **1.38×**           |

**Why the first run was so slow.** `--cpus=2` is a CPU-time quota, not a core count. Inside the
container FFmpeg still saw all 24 of the laptop's threads (`nproc` = 24, `cpu.max` =
`200000 100000`). So it started a full set of threads for the decoder, the filters and _each_ of the
ladder's encoders, which then fought over 2 CPUs.

- **Measured in isolation**, in the same container: one 1080p60 encode took 31.8 s with
  FFmpeg's default threads and 14.5 s with `-threads 2`.
- **The fix:** the worker now gives FFmpeg a thread budget when it is CPU-limited. It reads the
  limit from Go's quota-aware `GOMAXPROCS` and gives each parallel encoder an equal share.
  `FFMPEG_THREADS` overrides it.

**On an unrestricted machine the cap is off,** because there it lost. Same 11 clips, worker
container with no CPU limit on the laptop's 24 threads:

| Threads                        | All 11 clips       | 1080p60 clip | Sintel clip |
| ------------------------------ | ------------------ | ------------ | ----------- |
| FFmpeg's default (what ships)  | **2.91× realtime** | 0.62×        | 11.8×       |
| Capped at 24 (budget per rung) | 2.50× realtime     | 0.53×        | 10.1×       |

**1080p60 is the expensive case:** four 60 fps rungs including a 1080p one. On 2 vCPUs a 12 s
1080p60 upload takes about 33 s to publish. A worker this size handles casual demo uploads, but
not a queue of 60 fps phone videos. Lower-resolution sources run 2.6–4.6× realtime there.

**Earlier measurements** (720x1280 30 fps source, three rungs, Phase 4):

| Where                                     | Speed                            | Notes                           |
| ----------------------------------------- | -------------------------------- | ------------------------------- |
| Laptop, 4 workers in parallel (chaos run) | 7.2× realtime (mean of 100 jobs) | CPU shared by 4 encodes         |
| Laptop, 3 workers in parallel (chaos run) | 9.1× realtime (mean of 40 jobs)  |                                 |
| Laptop, worker in Docker, single job      | 6.4× realtime                    | one 6 s upload via the real API |

## Feed and upload API under load (k6)

**Setup.**

- **Load:** `pnpm loadtest` ([`loadtest/feed-and-uploads.js`](../loadtest/feed-and-uploads.js)),
  k6 2.3.0 on the laptop.
- **Server:** one `next start` process (production build) and Postgres 18 in Docker on the
  same machine. So this is one Node process's capacity, not Vercel's, which runs many.
- **Requests:**
  - `GET /v1/feeds/latest` with a publishable key from an allowed origin, page sizes 5–30 at
    random. The 10 s per-instance feed cache answered 95–99% of them.
  - `POST /v1/uploads` (a real multipart session in storage), then `DELETE` to abort it.
- **Rate limits** were scaled ×1000 for these runs (`RATE_LIMIT_SCALE`): k6 is one address, and
  the point was throughput. Every request still paid for its two rate-limit writes.

Each run followed a 15 s warm-up. Constant arrival rate:

| Load (requests/s)        | Feed p50 / p95 / p99  | Create upload p95 | Abort p95 | Errors | Dropped |
| ------------------------ | --------------------- | ----------------- | --------- | ------ | ------- |
| 50 feed + 5 upload       | 12 / 20 / – ms        | 55 ms             | 52 ms     | 0      | 0       |
| 75 feed + 5 upload       | 11 / 24 / – ms        | 66 ms             | 59 ms     | 0      | 0       |
| **100 feed + 10 upload** | **14 / 48 / 150 ms**  | **103 ms**        | 111 ms    | 0      | 0       |
| 150 feed + 10 upload     | 1579 / 2098 / 2830 ms | 2642 ms           | 3110 ms   | 0      | 1,732   |

The 100 and 150 req/s runs lasted 60 s. The 50 and 75 req/s runs lasted 30 s and predate p99
recording.

**One process tops out at about 120–140 requests/s.** At 150 req/s requests queue and k6 has
to drop iterations. A single cached feed request costs about 15 ms. Database time is only about
4 ms of that, measured with the queries timed on their own (p50 of 200):

- a round trip: 0.53 ms;
- a rate-limit hit: 0.68 ms;
- authenticating a key: 2.59 ms.

The rest is Node/Next.js CPU. More capacity means more instances, not a faster database.

**The rate limits themselves**, unscaled: one address sent 5 feed requests/s and 1 upload
session/s for 60 s.

- **Feed:** 301 requests, 213 allowed and 88 answered 429, every 429 with a `Retry-After`. The
  rule is 120 per minute per viewer address, and the run straddled two fixed windows.
- **Upload sessions:** 49 of 61 created (30 per minute per key).
- **The trade-off of fixed windows:** up to twice the limit can pass around a window boundary.

## Lighthouse (demo site)

Lighthouse 13.5.0, mobile profile (simulated slow 4G and 4× CPU slowdown), headless Chrome,
against the production build on the laptop. Media came from local storage. Median of 3 runs per
page; raw scores are in [`benchmarks/lighthouse-*.json`](benchmarks/). Measured 2026-11-03.

| Page          | Performance | Accessibility | Best practices | SEO | LCP       | TBT        | CLS |
| ------------- | ----------- | ------------- | -------------- | --- | --------- | ---------- | --- |
| `/` before    | 70          | 100           | 96             | 100 | 4.6 s     | 505 ms     | 0   |
| **`/` after** | **96**      | 100           | **100**        | 100 | **2.5 s** | **126 ms** | 0   |
| `/developers` | 99          | 100           | 100            | 100 | 2.1 s     | 32 ms      | 0   |
| `/upload`     | 100         | 95¹           | 100            | 100 | 1.5 s     | 35 ms      | 0   |

**What changed on `/`**, each found in the first report:

- **LCP 4.6 → 2.5 s.** The largest paint was the first slide's text, rendered only after
  JavaScript loaded and fetched the feed (1.45 s "element render delay"). The page now
  server-renders the first feed page (`<ReelFeed initialPage>`), so the first poster and title
  are in the HTML, and the poster is fetched with `fetchpriority="high"`.
- **TBT 505 → 126 ms.** The biggest script was hls.js, 583 KB. Its light build is 366 KB. It
  leaves out alternate audio, subtitles, DRM and CMCD, none of which Reelplane's single-track
  muxed renditions use.
- **Best practices 96 → 100:** an app icon (the 404 in the console).

¹ The primary button's white text on `#db2777` failed the contrast check. The accent is now
`#be185d` (6.0:1); not re-measured after that change.

The "before" row was measured on commit `8580b62` in a separate worktree, with the same media
setup. The very first audit of the day scored 66, but its media URLs pointed at an old LAN
address and timed out, so it isn't comparable and isn't in the table.

## Pending

These will be filled in by the phases that build them:

- Swipe-to-play without preloading on the iPhone: full 25-swipe run (only 2/25 so far)
- Transcode speed on the actual free worker host (Phase 8; the 2-vCPU numbers above are a
  quota-limited container on the laptop's CPU)

## SDK size

`tsc` output, unminified, all modules included (2026-11-01):

| Package                                                                        | Raw     | gzip    |
| ------------------------------------------------------------------------------ | ------- | ------- |
| `@reelplane/sdk-core` (player, preloading, metrics and the resumable uploader) | 38.1 KB | 10.8 KB |
| `@reelplane/sdk-react` (`<ReelFeed />` + styles)                               | 14.7 KB | 4.9 KB  |

hls.js is not included: it is a dynamic `import()`, so bundlers split it into a separate chunk,
loaded on first playback and never on Apple devices (native HLS). Since Phase 7 that is hls.js's
light build: a 366 KB minified chunk in the demo's production build, down from 583 KB for the
full build (see Lighthouse above). Both packages are
`sideEffects: false` and tree-shake: an app that only uses `uploadVideo` doesn't ship the player.
