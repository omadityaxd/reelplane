# Services: versions, free tiers and no-card check

Checked on **2026-10-30**. Free tiers change often, so re-check before relying on any number here.

## Name

"ReelKit" is taken: `reelkit`, `@reelkit/react` and `@reelkit/core` are live npm packages, and
`github.com/reelkit` exists. Candidates checked on the same day:

| Name                   | npm  | `@scope/react` | GitHub user/org |
| ---------------------- | ---- | -------------- | --------------- |
| **Reelplane** (chosen) | free | free           | free            |
| Reelyard               | free | free           | free            |
| ReelStack              | free | free           | taken           |

**Reelplane** was chosen: the project's design is a control plane and a data plane for reels.

## Toolchain (latest stable on the check date)

| Tool                   | Version                          |
| ---------------------- | -------------------------------- |
| Node.js                | 24 (LTS line)                    |
| pnpm                   | 10.33                            |
| TypeScript             | 7.0 (native compiler)            |
| Next.js / React        | 16.4 / 19.3                      |
| hls.js                 | 1.7                              |
| Vitest                 | 5.0                              |
| Biome (lint + format)  | 2.6, replacing ESLint + Prettier |
| AWS SDK v3 (S3 client) | 3.1160                           |
| Go                     | 1.27                             |
| Postgres (local)       | 18.6                             |
| RustFS (local S3)      | 1.0.4                            |

## Services

| Service                 | Role                          | Free tier (official page)                                                                                                                                                 | Card needed?                                                   | Verdict                                |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| Supabase                | Postgres, queue, Auth         | 2 active projects, 500 MB DB, 5 GB egress, 50k MAU; pauses after 1 week inactive                                                                                          | No (free plan sign-up via GitHub/email)                        | OK. Keep the demo active, or it pauses |
| Backblaze B2            | Object storage                | 10 GB stored free; egress free up to 3× stored data/month, then $0.01/GB; free via Cloudflare and other CDN partners                                                      | Sign-up page says "No credit card required"                    | OK, the default                        |
| Cloudflare R2           | Alternative storage           | 10 GB, zero egress                                                                                                                                                        | Several 2025–26 reports say enabling R2 needs a card or PayPal | Fallback only, needs a card            |
| Upstash Redis           | Rate limits, cache (optional) | 500K commands/month, 256 MB                                                                                                                                               | No                                                             | OK, optional                           |
| Vercel                  | Hosts `apps/web`              | Hobby plan                                                                                                                                                                | No                                                             | OK (Hobby is non-commercial use)       |
| npm                     | SDK publishing                | Free public packages and orgs                                                                                                                                             | No                                                             | OK                                     |
| **Hugging Face Spaces** | Worker host                   | **Docker and Gradio Spaces now need a paid plan (PRO) to create.** Only Static Spaces are free. CPU Basic is 2 vCPU / 16 GB, sleeps when idle, and has no persistent disk | Paid plan                                                      | **Changed, see below**                 |
| MinIO (local)           | Offline S3                    | **No longer distributed as free images** (Oct 2025); repo archived 2026                                                                                                   | n/a                                                            | **Replaced by RustFS**                 |

## What changed from the brief and why

1. **MinIO → RustFS for local storage.** MinIO stopped publishing community binaries and Docker
   images in October 2025, and its repo was later archived. RustFS (Apache-2.0) is
   S3-compatible, and the storage contract test passes against it. Code talks only to the S3
   API, so MinIO, Garage or SeaweedFS still work as a config change.
2. **Hugging Face Docker Space is no longer free.** Creating one needs PRO. The no-cost options
   are:
   - **Your laptop (default):** `docker compose` runs the worker next to the queue; the demo
     feed keeps working when it's off, because showcase videos are pre-processed.
   - **Any free VM you already have.** Most no-card container hosts are too small for FFmpeg:
     Koyeb's free tier is 0.1 vCPU, and Fly.io needs a card. Render's free web service
     reportedly needs a card for Docker deploys; unverified.
   - Pay for HF PRO if you want the brief's original setup.

   The worker is one Docker image either way, so this is a Phase 8 deployment choice.
3. **"ReelKit" → "Reelplane"** (name taken, see above).
4. **Biome instead of ESLint + Prettier:** one fast tool and one config.
5. **AWS SDK checksum default.** Since 2025 the SDK adds CRC32 checksums to uploads by default.
   That breaks presigned browser part uploads on several S3-compatible providers, so the client
   is set to `WHEN_REQUIRED`.

## Sources

- [Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing)
- [Supabase pricing](https://supabase.com/pricing)
- [Hugging Face Spaces overview: hardware and paid-plan requirement](https://huggingface.co/docs/hub/spaces-overview)
- [Upstash Redis pricing](https://upstash.com/pricing/redis)
- [MinIO CE retirement summary](https://glukhov.org/data-infrastructure/object-storage/minio-dead/),
  [It's FOSS on MinIO](https://itsfoss.com/news/minio-moves-away-from-open-source/)
- [RustFS](https://github.com/rustfs/rustfs)
- [R2 card requirement report](https://freetier.co/directory/products/cloudflare-r2)
- [Render free tier](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)
