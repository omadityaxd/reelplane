# Known issues

From two independent code reviews (2026-11-13): one of the Go queue and worker, one of the
upload path and the player SDK. Each reviewer read the code without having seen it written.
What they found that mattered is fixed and tested; the commit lists it. Everything else is
below, with its impact and the fix I'd make.

**Fixed in that round**, for reference:
- **Storage prefixes reused after a graceful release,** which let the sweeper delete a
  published video's files (critical).
- **Fencing that a restarted worker with the same id could pass.**
- **Storage delete errors ignored.**
- **Webhook results lost on shutdown.**
- **Error messages with invalid UTF-8 or NUL bytes that Postgres refused.**
- **A failed hls.js load breaking a feed slot for good,** and a destroyed feed still loading
  videos.
- **The last video's watch time never sent.**
- **Duplicate trackers after a fast A → B → A swipe.**
- **The preload buffer cap stuck on during hls.js's first load.**
- **No recovery from fatal stream errors.**
- **Uploads failing when storage hides the `ETag` header** (Supabase).
- **No timeout on stalled part uploads.**
- **A rejected upload reported as success on retry.**
- **A stale server-rendered page after a feed switch.**
- **`onActiveChange` re-firing on every render.**
- **The feed's buttons not working from the keyboard.**

**Fixed since** (2026-11-13), each with tests:
- **No deadline on a job or an encode.** A job now stops after `WORKER_JOB_TIMEOUT` (45 min).
  The encode and stills stop after 2 min + 20× the video's length. Both are retried.
- **No cap on the downloaded size.** The download stops past the declared `size_bytes`, and the
  job fails without a retry.
- **Corrupt files retried until dead-lettered.** FFmpeg failures whose stderr blames the input
  (corrupt data, no decoder, a refused format) now fail at once. Disk, memory and kill signals
  are still retried.
- **Duration read only from the container.** The worker falls back to the stream's duration,
  then Matroska's `DURATION` tag, then the last packet's timestamp. A browser-recorded WebM
  with no duration header now publishes.
- **`[0:v]` instead of the probed stream.** The encode and stills now read the stream that was
  probed (`0:v:N`), not cover art that comes first.
- **No protocol or format allow-list for FFmpeg.** Every FFmpeg and ffprobe input now gets
  `-protocol_whitelist file -format_whitelist mov,matroska`. A concat or HLS playlist
  disguised as an upload is refused.

## Worker (Go)

| Issue                                                                     | Impact                                                                                                                                                                | Fix                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Stills can be silently missing** (`images.go`)                          | If the audio outlasts the video, a thumbnail at 75% may not exist. A missing placeholder fails the job (retried); a missing thumbnail is published as a dangling key. | Stat each still; retry at an earlier timestamp; treat missing stills as non-fatal.  |
| **Complete isn't retried after a transient database error** (`worker.go`) | A finished encode is thrown away and redone after the lease expires.                                                                                                  | Retry Complete a few times with backoff.                                            |
| **The heartbeat doesn't track the local lease deadline**                  | During a database outage the worker keeps encoding after its lease lapsed, then loses the fence. Wasted work only.                                                    | Cancel the job once the local lease deadline passes without a successful heartbeat. |
| **Full-jitter backoff can retry at ~0 s**                                 | A transient failure can be retried immediately.                                                                                                                       | Equal jitter (half fixed, half random).                                             |
| **Abandoned multipart uploads whose abort fails are only logged**         | Their parts stay in storage.                                                                                                                                          | Record failed aborts like storage garbage, or add a bucket lifecycle rule.          |
| **Temp dirs after a hard kill**                                           | `reelplane-job-*` folders stay in the temp dir.                                                                                                                       | Sweep stale ones at startup.                                                        |
| **`Pdeathsig` on Linux is per thread** (Go issue 27505)                   | In rare cases FFmpeg is killed early, or survives the worker.                                                                                                         | Run FFmpeg from a locked OS thread, or in its own process group with a watchdog.    |
| **Sweeps hold a pooled connection during network deletes**                | Up to 20 deletes inside one transaction share the pool with webhooks.                                                                                                 | Claim rows, commit, delete, then record in a second transaction.                    |

## Upload path and API

| Issue                                                                        | Impact                                                                                                                                                                | Fix                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Idempotent replays keep the upload token in plaintext** (`idempotency.ts`) | The `POST /v1/uploads` response, token included, is stored for 24 h in `idempotency_keys`. Anyone with database access could use a live token for its video.          | Store the response without the token, and mint a fresh one on replay.      |
| **A database error after a successful create releases the idempotency key**  | A retry then creates a second upload; the first multipart upload is orphaned until the cleanup job. The 120 s stale-claim takeover can double-run a very slow create. | Keep the key on post-success failures, and lengthen the takeover.          |
| **Abort ignores a failed multipart abort** (`service.ts`)                    | Parts stay until the bucket's lifecycle rules (if any) remove them.                                                                                                   | Record it as garbage.                                                      |
| **QuickTime files without an `ftyp` box are rejected** (`sniff.ts`)          | Very old `.mov` files, which FFmpeg would accept, fail with "unsupported file type".                                                                                  | Also accept `moov`, `wide` and `mdat` first boxes for `video/quicktime`.   |
| **A resumed upload doesn't check it's the same file**                        | Resuming with a different file of the same size mixes parts. The worker then fails or publishes garbage.                                                              | Keep a hash of the first and last part per session, and compare on resume. |
| **Aborting during backoff rejects with the raw reason**                      | Callers see the `AbortSignal`'s reason, not `UploadError("aborted")`.                                                                                                 | Wrap it.                                                                   |

## Player SDK

| Issue                                                              | Impact                                                                                     | Fix                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| **The warmer ignores page visibility** (`warmer.ts`)               | In a hidden tab the next video still plays one frame every 4 s.                            | Skip warming while `document.hidden`.                    |
| **A rejected warm-up `play()` stops warming**                      | If the window re-applies mid warm-up, warming of that video stops until the next swipe.    | Reschedule on rejection.                                 |
| **The first page has no retry** (`controller.ts`)                  | If the first feed request fails, the feed shows an error and stays empty.                  | Retry with backoff, plus a retry button in `<ReelFeed>`. |
| **`flush()` sends at most 100 events on page hide** (`metrics.ts`) | A very long session can lose events beyond 100 at the end.                                 | Split the final flush into several `keepalive` requests. |
| **`verifyWebhook` keeps only the last `v1=` signature**            | A multi-signature header during secret rotation won't verify. No guard on an empty secret. | Accept any matching `v1`; reject an empty secret.        |

## Operations

- **Supabase pauses free projects** after 7 days without activity; the local project was paused
  when this list was written. A paused project means the live demo is down. Something has to use
  it at least weekly, or it moves to a paid plan.
- **Uploads are processed only while the laptop runs `pnpm prod:worker`.** That's by design
  (see [DEPLOY.md](DEPLOY.md)); the demo says so.
