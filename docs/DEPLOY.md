# Deploying Reelplane (free, no card)

The web app (API, dashboard, demo) goes to Vercel. The database and sign-in run on your
Supabase project, and media lives in S3-compatible storage. The transcoding worker runs on your
laptop, which is fine: the demo works without it (below).

Checked 2026-11-04. Free tiers change; re-check anything marked _verify_.

## 1. Storage: the no-card question

The brief's default was Backblaze B2. **B2 now needs a card for what the demo needs.**
Backblaze's bucket docs (updated 2026-05-22) say that to create your first **public** bucket you
must "have a payment history on file, or use the credit card form to pay a small fee that is
credited to your account balance". A report from 2026-10-27 puts the fee at $1. Private buckets
need no card, but players can't read a private bucket directly.

| Option                                | Card?                                        | Free limits                                                         | Work needed                                                                   |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **A. Supabase Storage** (recommended) | No: you already have the project             | 1 GB stored, 50 MB per file, 5 GB egress + 5 GB cached egress/month | Upload limit to 50 MB; test browser uploads (Supabase has no `PutBucketCors`) |
| B. Backblaze B2, public bucket        | **Yes**: a small fee (reported $1), credited | 10 GB stored; egress free up to 3× stored per month                 | None: the code targets it today                                               |
| C. B2 private + Cloudflare Worker     | No (Cloudflare free plan, _verify_)          | 10 GB stored; Worker 100k requests/day (~6k video views)            | A small signing proxy (Worker) in front of the bucket                         |

**What A means in practice:**
- **Uploads go up to 50 MB** (a 60 s phone video is usually 30–80 MB, so some won't fit).
- **The bucket is public as a whole,** originals included. They sit at
  `originals/<project uuid>/<video uuid>/source`, a path the API never reveals and nobody can
  guess.
- **5 GB of egress is roughly 1,000–2,000 demo views a month.** A view plus preloads is about
  3–5 MB at 720p.

All three are S3-compatible, so moving later is a config change plus copying the objects.

## 2. Where the worker runs

Hugging Face Docker Spaces need a paid plan, so I compared what's left:

| Host                                     | Card?                                                  | CPU / RAM                   | Always on?                                                                   | Fit for FFmpeg                                        |
| ---------------------------------------- | ------------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| Hugging Face Docker Space                | Paid plan (PRO) to create                              | 2 vCPU / 16 GB              | Sleeps when idle                                                             | Good, but not free                                    |
| Koyeb free                               | Sometimes (bot check); reports of a hold               | 0.1 vCPU / 512 MB           | Scales to zero after 1 h without traffic; **web services only, not workers** | No                                                    |
| Render free                              | No (reportedly)                                        | 0.1 CPU / 512 MB            | Spins down after 15 min idle; **no free background workers**                 | No                                                    |
| Northflank sandbox                       | Conflicting (its page says no card; reviewers say yes) | Small shared slice          | Always on, 2 free services                                                   | Too small: ~20× slower than 2 vCPU                    |
| Back4app containers                      | No (reportedly)                                        | 0.25 CPU / 256 MB           | Unclear                                                                      | No (256 MB)                                           |
| Oracle / Google / AWS / Azure free tiers | **Yes** (identity check)                               | Up to 4 ARM cores on Oracle | Yes                                                                          | Good, but need a card                                 |
| GitHub Actions on a schedule             | No                                                     | Runner VMs, 6 h jobs        | Runs every ≥5 min                                                            | **Against GitHub's terms** (not a serverless backend) |

**For scale:** the worker measured 1.38× realtime on 2 vCPUs (BENCHMARKS.md), so a 0.1 vCPU
host would need several minutes for a 12 s clip, and 512 MB is tight for a 1080p ladder.
**Verdict: keep the worker on the laptop.** The deployed app is built for that:

- **The demo feed never needs the worker:** showcase videos are transcoded once, before deploy,
  and served from storage.
- **Uploads queue while it's off.** The upload page and a queued video's dashboard page say so,
  using a presence stamp each worker writes every ~20 s.
- **Expiry and storage cleanup run daily on Vercel** (`/api/cron/cleanup`) even with no worker.
- **Webhooks wait** until a worker runs; they're sent by the worker.

## 3. Accounts, in order

You already have Supabase (sign-in works). Still needed:

1. **Storage** (option A, B or C above).
2. **Database: the same Supabase project** (Postgres + the job queue). No new account.
3. **Vercel** (Hobby, no card), importing the repo from GitHub.
4. **npm**, only to publish the SDK yourself.

Each step below says which values go where. Production values live only in Vercel and in a
local `.env.production` (gitignored) used to migrate and seed. Nothing goes in git.

### 3a. Database (Supabase Postgres)

1. Supabase dashboard → your project → **Connect** (top bar).
2. Copy two connection strings, both with your database password filled in:
   - **Transaction pooler** (port **6543**) → `DATABASE_URL` in **Vercel**. Serverless functions
     open many short connections, and this pooler is built for them.
   - **Session pooler** (port **5432**) → `DATABASE_URL` in your local `.env.production`, for
     migrations, seeding and the worker. The worker holds row locks and sets its role per
     connection, which needs session mode.
3. Put the **session pooler** string in `.env.production` as `DATABASE_URL`, and keep the
   transaction pooler string for Vercel (section 4). Then tell me: I run the migrations against
   it and check the RLS roles were created. Supabase's `postgres` user should be able to
   create roles; I'll verify.

### 3b. Storage: Supabase Storage (option A, chosen)

1. **Create the bucket.** Supabase dashboard → **Storage** → **New bucket**:
   - **Name:** `reelplane`.
   - **Public bucket:** on. Players read the HLS files directly.
   - **Restrict file size:** on, **50 MB** (the free plan's maximum).
   - **Allowed MIME types:** leave empty. The bucket holds videos, playlists, segments and
     images.
2. **Turn on S3 access.** Storage → **Settings** (or Project Settings → Storage) → **S3
   Connection**:
   - Enable "Connection via S3 protocol" if it's off.
   - Copy the **Endpoint**, like `https://<ref>.supabase.co/storage/v1/s3`.
   - Copy the **Region**, like `ap-south-1`.
3. **Create an S3 access key.** In the same section → **New access key**, name it
   `reelplane`. Copy the **Access key ID** and the **Secret access key**; the secret is shown
   once.
4. **Fill in `.env.production`** (repo root, gitignored):

   | Variable                    | Value                                                          |
   | --------------------------- | -------------------------------------------------------------- |
   | `STORAGE_PROVIDER`          | `supabase` (already filled in)                                 |
   | `STORAGE_ENDPOINT`          | the Endpoint from step 2                                       |
   | `STORAGE_REGION`            | the Region from step 2                                         |
   | `STORAGE_BUCKET`            | `reelplane` (already filled in)                                |
   | `STORAGE_ACCESS_KEY_ID`     | from step 3                                                    |
   | `STORAGE_SECRET_ACCESS_KEY` | from step 3                                                    |
   | `STORAGE_PUBLIC_BASE_URL`   | `https://<ref>.supabase.co/storage/v1/object/public/reelplane` |
   | `UPLOAD_MAX_BYTES`          | `52428800` (50 MB, already filled in)                          |

Then tell me. Before anything else uses it, I check that a browser can upload in parts straight
to it (Supabase manages CORS itself) and that a published playlist plays from the public URL.

## 4. Vercel checklist (`apps/web`)

**Project:** New Project → import the GitHub repo.
- **Root Directory:** `apps/web`. Leave "Include files outside the root directory" on: the app
  uses the workspace packages.
- **Framework:** Next.js (detected). Install and build commands: the defaults (pnpm is detected
  from `pnpm-lock.yaml`).
- **Node.js:** 24.x.
- **Function region:** the same region as your Supabase project.

**Environment variables (Production only):**

| Variable                            | Value                                           | Notes                                                     |
| ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `DATABASE_URL`                      | Supabase **transaction pooler** URI (port 6543) | Secret                                                    |
| `DATABASE_POOL_MAX`                 | `2`                                             | Connections per function instance                         |
| `API_KEY_PEPPER`                    | 43 random characters (I generate it)            | **Must equal** the one used to seed production keys       |
| `NEXT_PUBLIC_SUPABASE_URL`          | `https://<ref>.supabase.co`                     | Same as local                                             |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`     | the anon / publishable key                      | Same as local                                             |
| `NEXT_PUBLIC_SITE_URL`              | `https://<your-app>.vercel.app`                 | Sign-in links use it; required in production              |
| `NEXT_PUBLIC_DEMO_PUBLISHABLE_KEY`  | printed by the production seed                  | Inlined at build time: set it **before** deploying        |
| `NEXT_PUBLIC_BENCH_PUBLISHABLE_KEY` | optional, from `pnpm bench:seed`                | Only if you want `/bench` in production                   |
| `STORAGE_*`                         | from your storage choice                        | Provider, endpoint, region, bucket, keys, public base URL |
| `CRON_SECRET`                       | 32+ random characters (I generate it)           | Vercel sends it to `/api/cron/cleanup`                    |
| `TRUSTED_PROXY`                     | `vercel`                                        | The default on Vercel; set it explicitly anyway           |

**Do not set in production:**
- `SUPABASE_SERVICE_ROLE_KEY`: only the e2e test uses it.
- `RATE_LIMIT_SCALE`: ignored on Vercel anyway.
- `REELPLANE_LOCAL_AUTH`: ignored with Supabase configured anyway.
- `WEBHOOK_ALLOW_PRIVATE_URLS`.

**Cron:** `apps/web/vercel.json` schedules `/api/cron/cleanup` daily at 04:17 UTC. Hobby
allows daily crons, and the run is skipped if a worker cleaned up in the last hour. Vercel adds
`Authorization: Bearer $CRON_SECRET` itself. Requests without it get 401, and with no secret
configured the route answers 503.

**Supabase → Authentication → URL Configuration:**
- **Site URL:** `https://<your-app>.vercel.app` (the magic-link template's `{{ .SiteURL }}`).
- **Redirect URLs:** add `https://<your-app>.vercel.app/auth/callback`. Keep
  `http://localhost:3000/**` for local development.

**After the first deploy:** the production seed adds `https://<your-app>.vercel.app` to the demo
project's allowed origins. Supabase Storage needs no CORS setup; B and C would.

## 5. Seeding production

With `.env.production` loaded: run the migrations, start a worker against production, then
`pnpm showcase:seed`. The seed uploads the showcase clips through the real upload path and
waits until the worker has published them. It prints the demo publishable key for
`NEXT_PUBLIC_DEMO_PUBLISHABLE_KEY`, and only then do you deploy.

## 6. Publishing the SDK (you)

Dry runs pass (`pnpm publish --dry-run`):

| Package                | Packed  | Files |
| ---------------------- | ------- | ----- |
| `@reelplane/sdk-core`  | 61.6 kB | 42    |
| `@reelplane/sdk-react` | 17.9 kB | 15    |

Both ship `dist/` (ESM + types, maps with embedded sources), README and LICENSE.
`@reelplane/sdk-react` depends on `@reelplane/sdk-core@^0.1.0`, so publish core first:

```bash
npm login                      # with 2FA
pnpm --filter @reelplane/sdk-core --filter @reelplane/sdk-react build
cd packages/sdk-core && pnpm publish --access public
cd ../sdk-react && pnpm publish --access public
```

The `@reelplane` scope must be yours on npm first (free org: npmjs.com/org/create).

## Sources

- [Backblaze: create and manage buckets (public bucket requirements)](https://www.backblaze.com/docs/cloud-storage-create-and-manage-buckets)
- [Report of the $1 B2 card payment](https://github.com/mhvnsnt/agent-ops/pull/231)
- [Backblaze S3 PutBucketCors](https://backblaze.com/apidocs/s3-put-bucket-cors)
- [Supabase Storage S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility), [Supabase pricing](https://supabase.com/pricing)
- [Cloudflare Workers pricing and limits](https://developers.cloudflare.com/workers/platform/pricing/index.md)
- [Koyeb instances](https://www.koyeb.com/docs/reference/instances), [Koyeb pricing FAQ](https://www.koyeb.com/docs/faqs/pricing)
- [Render compute plans](https://render.com/docs/compute-plans), [Render: free tiers in 2026](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)
- [Northflank pricing](https://northflank.com/pricing)
- [GitHub Terms for Additional Products (Actions)](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)
- [Free Docker hosting without a card (comparison)](https://hostadvice.com/docker-hosting/free-docker-hosting-no-credit-card/)
