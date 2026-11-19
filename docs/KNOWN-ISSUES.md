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
- **Idempotent replays kept the upload token in plaintext.** The stored `POST /v1/uploads`
  response now holds the token sealed with AES-256-GCM, under a key derived from
  `API_KEY_PEPPER`. A replay still returns the same working token, and database access alone
  can't read it.
- **No retry for a failed feed page.** A page lost to the network, a timeout, a rate limit or a
  5xx is retried 3 times with backoff. After that `<ReelFeed>` shows the error with a
  "Try again" button, which calls the new `FeedController.retry()`.
- **Warming in hidden tabs, and warming stopped by one refused `play()`.** The warmer now skips
  its cycle while `document.hidden`. A refused warm-up is rescheduled, not dropped.
- **`verifyWebhook` kept only the last `v1=` signature, with no guard on an empty secret.** It
  now accepts any matching `v1` (several are sent while a secret is rotated), and refuses an
  empty or missing secret with a `WebhookVerificationError`. Node already refused an empty HMAC
  key, but other runtimes needn't.

**Fixed before launch** (2026-11-17, security), each with tests:

- **Published renditions kept the upload's metadata,** including a phone's GPS location and
  model (FFmpeg copies container metadata by default). The worker now drops all source
  metadata and chapters (2026-11-19). The 8 showcase clips carried none.
- **Original uploads could be downloaded by anyone.** The bucket is public so the feed plays
  from it, and `originals/<project>/<video>/source` was built from ids the feed returns. New
  originals go under a random 128-bit folder no public API returns, and are deleted once the
  video is published, showcase videos excepted (2026-11-19). The existing originals are the 8
  CC BY showcase clips, public anyway.

- **The production worker ran FFmpeg directly on the laptop.** `pnpm prod:worker` now runs the
  worker only in its Docker container: non-root, no Linux capabilities, no privilege escalation,
  a read-only filesystem except a 4 GB `/tmp` that can't run programs, 4 GB of memory, 512
  processes, and only the worker's own variables. Base images are pinned by digest; FFmpeg is
  refreshed weekly from Debian. The local compose worker has the same lockdown, and the
  dashboard e2e transcodes through it. The native worker is for local development only.

- **Database connections to a remote host weren't encrypted.** Node's `pg` only uses TLS when
  asked. The app, scripts and worker now require TLS with a verified certificate for any
  non-local database (Supabase's root CA for Supabase hosts), with no plain-text fallback.
- **No security headers.** Every response now sends a Content-Security-Policy built from the
  deployment's own Supabase and storage hosts, `X-Frame-Options: DENY`, `nosniff`, a referrer
  policy, a permissions policy, `Cross-Origin-Opener-Policy` and HSTS. An e2e test plays and
  swipes the feed and loads every public page under the policy with no violation.
- **Vulnerable dependencies.** Next.js 16.4.6 (a moderate advisory in 16.3–16.4.4) and Go
  toolchain 1.27.4 (15 standard-library advisories, 10 reachable from the worker). `pnpm
  audit` and `govulncheck` are clean.

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

| Issue                                                                       | Impact                                                                                                                                                                | Fix                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **A database error after a successful create releases the idempotency key** | A retry then creates a second upload; the first multipart upload is orphaned until the cleanup job. The 120 s stale-claim takeover can double-run a very slow create. | Keep the key on post-success failures, and lengthen the takeover.          |
| **Abort ignores a failed multipart abort** (`service.ts`)                   | Parts stay until the bucket's lifecycle rules (if any) remove them.                                                                                                   | Record it as garbage.                                                      |
| **QuickTime files without an `ftyp` box are rejected** (`sniff.ts`)         | Very old `.mov` files, which FFmpeg would accept, fail with "unsupported file type".                                                                                  | Also accept `moov`, `wide` and `mdat` first boxes for `video/quicktime`.   |
| **A resumed upload doesn't check it's the same file**                       | Resuming with a different file of the same size mixes parts. The worker then fails or publishes garbage.                                                              | Keep a hash of the first and last part per session, and compare on resume. |
| **Aborting during backoff rejects with the raw reason**                     | Callers see the `AbortSignal`'s reason, not `UploadError("aborted")`.                                                                                                 | Wrap it.                                                                   |

## Player SDK

| Issue                                                              | Impact                                                                                                                                                                                            | Fix                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **`flush()` sends at most 100 events on page hide** (`metrics.ts`) | A very long session can lose events beyond 100 at the end.                                                                                                                                        | Split the final flush into several `keepalive` requests.                                                 |
| **Inlined first playlists only help hls.js on fast networks**      | Native HLS (every iOS browser) fetches playlists itself, and on slow networks the SDK starts from `hlsLowStartUrl`, which isn't inlined. Those first videos still make the two playlist requests. | Inline the low-start master and its first variant too; for native HLS, a `<link rel="preload">` of both. |

## Security: accepted for launch

| Issue                                                       | Impact                                                                                                                                                                                                                                             | Fix                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **The CSP allows inline scripts**                           | Next.js inlines its bootstrap scripts, so `script-src` keeps `'unsafe-inline'`. External scripts are still refused, and the app renders no raw HTML, so an injection needs a bug React doesn't already escape.                                     | A per-request nonce (Next.js supports it, but every page becomes dynamic).                 |
| **FFmpeg parses untrusted uploads**                         | Contained: a memory-safety bug in FFmpeg runs inside the locked-down container (see Fixed before launch), not as your user on the laptop. It could still read the worker's own variables (database and storage credentials) and reach the network. | Run the worker on a separate machine or VM, with storage credentials scoped to the bucket. |
| **CI downloads FFmpeg's `latest` build without a checksum** | A compromised download runs in CI only, with a read-only token and no secrets.                                                                                                                                                                     | Mirror a fixed build with a pinned SHA-256.                                                |
| **A resumed upload doesn't check it's the same file**       | Only the uploader's own video is affected.                                                                                                                                                                                                         | Listed under Upload path.                                                                  |

## Operations

- **Supabase pauses free projects** after 7 days without activity; the local project was paused
  when this list was written. A paused project means the live demo is down. Something has to use
  it at least weekly, or it moves to a paid plan.
- **The daily cleanup is a Vercel Cron Job, which Vercel now calls legacy** (to be migrated to
  Schedules, no date given; checked 2026-11-18). Cron Jobs keep working; Schedules is still in
  beta, so the launch stays on Cron Jobs. Migrating is free on Hobby (5,000 runs a month) and
  the route needs no change: a path schedule still sends `Authorization: Bearer $CRON_SECRET`.
  In `apps/web/vercel.json`, replace `crons` (never keep both: the job would run twice) with
  `"schedules": { "cleanup": { "schedule": "17 4 * * *", "path": "/api/cron/cleanup", "requestMethod": "GET" } }`
  (path schedules default to POST). See vercel.com/docs/schedules/migrate-from-cron-jobs.
- **Email sign-in links open only on the device that requested them.** Supabase locks the email
  templates until custom SMTP is configured, and the default link carries a PKCE code whose
  verifier is in the requesting browser. GitHub sign-in is unaffected. Fix: custom SMTP, then the
  `/auth/confirm` template in docs/LAUNCH-CHECKLIST.md step 9.
- **A GitHub sign-in and an email sign-in are separate accounts** unless the GitHub account's
  primary email is verified and the same address (Supabase links identities only then).
- **Uploads are processed only while the laptop runs `pnpm prod:worker`** (in Docker). That's by design
  (see [DEPLOY.md](DEPLOY.md)); the demo says so.
