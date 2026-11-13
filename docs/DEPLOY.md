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

## 3. The steps

**The step-by-step launch (accounts, keys, every env var, seeding, publishing) is in
[LAUNCH-CHECKLIST.md](LAUNCH-CHECKLIST.md).** This page keeps the reasoning behind it.

**Publishing the SDK:** dry runs pass (`pnpm publish --dry-run`):

| Package                | Packed  | Files |
| ---------------------- | ------- | ----- |
| `@reelplane/sdk-core`  | 61.6 kB | 42    |
| `@reelplane/sdk-react` | 17.9 kB | 15    |

Each ships `dist/` (ESM + types, maps with embedded sources), README and LICENSE.

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
