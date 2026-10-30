# Build "ReelKit": an open-source Reels SDK + video backend (weekend MVP)

You are building a production-quality MVP from scratch in this empty folder. Work phase by phase (section 8). After each phase: make sure everything builds and the tests pass, commit with a clear message, give me a 3-line summary, then continue unless you need something from me (an account, a key). Make sensible small decisions yourself.

**Before writing any code:** check the current stable version and docs of every tool, library and service in this brief, and the current free-tier terms of every service. If something is outdated, deprecated or no longer free, use the current equivalent and tell me what you changed. Also check that the name "ReelKit" is free on npm and GitHub; if not, suggest 3 alternatives and pick one.

---

## 1. The idea

Any developer can add a vertical, swipeable short-video feed (like Instagram Reels) to their web app with a few lines:

```tsx
<ReelFeed publishableKey="pk_..." feed="trending" />
```

Behind that one component, ReelKit handles everything video apps find painful:

1. **Upload:** large files on bad mobile networks, resumable, straight to storage
2. **Processing:** transcoding into multiple qualities, adaptive streaming (HLS), thumbnails
3. **Delivery:** fast playback that adapts to the network
4. **The Reels feel:** instant swipe-to-play thanks to preloading, no spinners
5. **Developer tools:** dashboard, API keys, webhooks, playback analytics

It's **open source and self-hostable**. Existing services (Mux, api.video, Cloudinary) sell video plumbing; ReelKit gives the _complete feed experience_, free to run yourself.

This is a resume project for backend and systems roles. The most important parts are the **upload path, the job queue and the transcoding worker** and how they behave under failure. Code quality, tests, measured numbers and a strong README matter more than features.

---

## 2. Constraints (non-negotiable)

- **Zero cost, no credit card.** Every service must work on a free tier without a card. Verify each one. If something needs a card, stop and tell me the no-card alternative.
- **Storage is swappable.** All storage goes through one S3-compatible interface, so switching between Backblaze B2, Cloudflare R2 or MinIO is only a config change.
- **The worker runs anywhere.** It is one Docker image that runs on my Windows laptop, a free Hugging Face Docker Space, or any VM.
- **The demo feed always works,** even when the worker is asleep or off. Showcase videos are processed once and served straight from storage.
- **Demo guardrails:** max 60 seconds and 100 MB per upload, uploads only for signed-in users, a daily upload cap for the whole demo, per-user rate limits, demo uploads auto-deleted after 7 days (showcase videos kept), and a report button.

---

## 3. Architecture

**Control plane** (always on, free on Vercel): **Next.js + TypeScript**

- the public REST API (`/v1/...`)
- the developer dashboard
- the demo site (a live feed plus "upload a reel")

**Data plane** (the heavy part): **a Go worker** in Docker

- takes transcoding jobs from the queue, runs FFmpeg, uploads the results, reports progress

**Shared pieces:**

- **PostgreSQL** (a new free Supabase project): videos, projects, API keys, jobs, events. It's also the **job queue** (see §5), so there's no extra queue service.
- **Object storage** (S3-compatible, Backblaze B2 by default): originals, HLS renditions, thumbnails
- **Supabase Auth** for dashboard and demo sign-in
- **Upstash Redis** (free, optional): rate limits and hot-feed caching. If it isn't set up, fall back to Postgres-based rate limiting.

Monorepo (pnpm workspaces):

```
apps/web            Next.js: API, dashboard, demo
packages/sdk-react  the <ReelFeed /> component (published to npm)
packages/sdk-core   framework-free player + preloading logic
services/worker     Go transcoding worker (Docker)
docs/               architecture, API reference, decisions
```

---

## 4. The upload path

- **Direct to storage:** the client asks the API for an upload session, and the API returns **presigned multipart upload URLs**. The browser uploads straight to storage, so video bytes never pass through Vercel (which has request size and time limits).
- **Resumable:** upload in chunks (about 5–10 MB each). If the connection drops, resume from the last finished chunk, not from zero. Show progress in the SDK.
- **Validation:** check size, duration and file type before accepting (reject non-video files even if they're renamed to `.mp4`). Re-check in the worker with `ffprobe`.
- **Idempotency:** creating an upload or completing it twice (a client retry) must not create duplicate videos or jobs. Use idempotency keys.
- When the upload completes, the video goes `uploading → queued` and a job row is created **in the same database transaction**.

## 5. The job queue and worker (the core: be thorough here)

**Queue in Postgres:**

- Workers claim jobs with `SELECT ... FOR UPDATE SKIP LOCKED`, so two workers never grab the same job.
- **Leases:** a claimed job has a lease (for example 2 minutes) that the worker renews with a heartbeat while it works. If a worker crashes or is killed, the lease expires and another worker picks the job up again.
- **Retries** with exponential backoff and jitter, plus a max-attempts limit. After that, move the job to a **dead-letter** state with the error kept for debugging.
- **Idempotent processing:** a job that runs twice (after a crash) must produce the same result, with no half-written outputs. Write outputs to a temporary prefix, then publish them.
- **Graceful shutdown:** on SIGTERM, finish or release the current job cleanly.
- Every state change is recorded in a `video_events` table (an audit trail and a timeline in the dashboard).

**Transcoding** (FFmpeg, called from Go):

- Inspect with `ffprobe`. Handle rotation metadata from phone videos, vertical vs horizontal, and variable frame rates.
- **Rendition ladder** for 9:16 vertical video: about 240p, 480p, 720p (1080p only if the source is that big). Use H.264 + AAC for maximum compatibility, never upscale, and use sensible bitrates for each size.
- Package as **HLS with fMP4/CMAF segments** (about 2-second segments, which suit short videos and fast starts), plus a master playlist.
- Generate a poster image, a few thumbnails and a tiny blurred placeholder.
- Report progress (percentage) back to the database.
- Use `-preset veryfast` by default so free CPUs stay usable.

**Chaos test (required):** a script that runs N jobs while randomly killing the worker. It must prove that **every job finishes exactly once, with no lost or duplicated videos**. Print the results. This becomes a headline README number.

## 6. Playback and the Reels experience (`sdk-core` + `sdk-react`)

- Use **hls.js** where needed and native HLS on Safari/iOS.
- **Vertical swipe feed:** full-screen on mobile, centred phone-width column on desktop. Swipe, scroll-wheel and arrow keys; tap to pause; mute toggle; autoplay muted (browser rules).
- **Preloading** is the key feature: while video N plays, load the playlist plus the first segment(s) of N+1 and N+2, and keep N−1 ready for swiping back. Unload videos far away to save memory and data. Limit the number of live video elements (recycle them).
- Start at a low quality for instant playback, then let adaptive bitrate ramp up.
- **Measure quality** and send it to the API in batches:
  - time to first frame
  - rebuffer count and duration
  - watch time and completion percentage
  - quality switches
- Themeable, accessible (keyboard, labels, reduced motion), works in light and dark mode, and typed.
- Small bundle size; tree-shakeable; no heavy dependencies.

**Feed API:** `GET /v1/feeds/:feed` with cursor pagination. MVP feeds:

- `latest`
- `trending`: an explainable score from completion rate, likes and recency, with time decay
- per-creator

Cache hot feed pages briefly.

## 7. Developer platform

- **Projects and API keys:** publishable keys (safe in the browser, read-only feed access, restricted to allowed origins) and secret keys (server-side, full access). Store only hashes of secret keys, show a key once on creation, support rotating and revoking.
- **REST API v1:** videos (create upload, complete, get, list, delete), feeds, playback events, likes. Document it with OpenAPI, plus a reference page.
- **Webhooks:** `video.ready`, `video.failed`, `video.deleted`, signed with HMAC (with a timestamp to stop replay attacks), retried with backoff, and with delivery logs in the dashboard.
- **Dashboard:**
  - upload and preview videos
  - a live processing timeline per video
  - jobs and their status
  - playback analytics (time to first frame p50/p95, rebuffer rate, completion)
  - API keys and webhooks
- **Demo site:** the live feed (showcase videos) plus "upload your own reel" for signed-in users, and a clear "use ReelKit in your app" section with copy-paste code.
- **Security:**
  - row-level security on every table
  - rate limits on every route
  - CORS and allowed origins
  - presigned URLs that expire quickly
  - no secrets in the client bundle
  - a project can never read another project's videos (add tests for this)

## 8. Build phases

1. **Setup and verification:** monorepo, tooling, `.env.example`, a no-card check of every service, the storage interface plus a local **MinIO** in Docker Compose so everything runs offline on my laptop.
2. **Data model and API keys:** schema and migrations (projects, keys, videos, renditions, jobs, video_events, playback_events, webhooks), key hashing, auth middleware.
3. **Upload path:** sessions, presigned multipart, resume, validation, idempotency.
4. **Queue and Go worker:** claim, lease, heartbeat, retries, dead-letter, transcoding, HLS, thumbnails, progress. Write the chaos test now.
5. **Player and feed SDK:** playback, swipe feed, preloading, metrics, the feed API.
6. **Dashboard, webhooks, analytics.**
7. **Hardening:**
   - rate limits and demo guardrails
   - the 7-day cleanup job
   - security tests (cross-project access)
   - a load test (k6) of the feed and upload-session endpoints
   - Lighthouse on the demo
8. **Deploy and docs:**
   - Vercel for `apps/web`
   - the worker on a Hugging Face Docker Space (verify current terms, CPU limits and sleep behaviour), with instructions for running it on my laptop
   - seed showcase videos (only properly licensed clips, or ones I record myself; tell me which)
   - publish the SDK to npm (dry run first; I'll publish)

## 9. Deliverables for my resume

- **README:**
  - one-line pitch, live demo link, GIF placeholder
  - the 5-line quick start
  - a Mermaid architecture diagram (control plane vs data plane)
  - how the queue survives crashes
  - the rendition ladder
  - preloading strategy
  - measured numbers (see below)
  - self-hosting guide
- **`docs/ARCHITECTURE.md`:** key decisions and trade-offs, such as why Postgres as the queue instead of Kafka/SQS, why direct-to-storage uploads, why 2s segments, why H.264, and what changes at 1,000× scale.
- **`docs/BENCHMARKS.md`, real measured numbers only, never invented:**
  - transcode speed (×realtime) on the free worker
  - time to first frame p50/p95
  - swipe-to-play time with and without preloading
  - chaos test results
  - feed API p95 under load
- Clean commit history, typed everything, tests for the queue, worker, API and SDK.

## 10. Accounts and keys I'll set up (list each in `.env.example` with step-by-step instructions)

- **Supabase:** a new free project (my other one is used by another app)
- **Backblaze B2:** bucket plus an application key. Verify it needs no card, and how playback bandwidth is charged; if it's a problem, tell me the alternative.
- **Upstash Redis:** optional, a new free database
- **Hugging Face:** account + Docker Space for the worker
- **Vercel:** I'll import the repo
- **npm:** for publishing the SDK

When a key is missing, everything must still run locally (MinIO plus a local Postgres in Docker Compose), so I can build the whole thing on my laptop before creating any account.

Start with Phase 1 now.
