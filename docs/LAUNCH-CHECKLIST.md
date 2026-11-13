# Launch checklist

Everything to do by hand to put Reelplane online, in order. About 1–2 hours.

**How it works:**
- Values go into `.env.production` at the repo root. Copy it from `.env.production.example`;
  it's gitignored. The variables marked _[Vercel]_ there also go into Vercel.
- Each step ends with a **Check**. Don't move on until it passes.
- The reasons behind the choices (Supabase Storage, the worker on your laptop) are in
  [DEPLOY.md](DEPLOY.md).

**Before you start:**
- [ ] Docker Desktop is running.
- [ ] `pnpm check` passes.
- [ ] `cp .env.production.example .env.production`, if you don't have one yet.

---

## 1. Supabase project values

You already have the project. Supabase dashboard → your project → **Project Settings → API**:

| Copy                                      | Into (`.env.production` and Vercel) |
| ----------------------------------------- | ----------------------------------- |
| Project URL (`https://<ref>.supabase.co`) | `NEXT_PUBLIC_SUPABASE_URL`          |
| `anon` / publishable key                  | `NEXT_PUBLIC_SUPABASE_ANON_KEY`     |

Never copy the `service_role` / secret key into Vercel or any `NEXT_PUBLIC_` variable.

- [ ] **Check:** open `https://<ref>.supabase.co/auth/v1/settings?apikey=<anon key>` in a
  browser. It answers with JSON settings, including an `external` list of sign-in
  providers.

## 2. Database connection strings

Dashboard → **Connect** (top bar) → "Connection string", with your database password filled in.
Copy two of them:

| Copy                                       | Into                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| **Session pooler** URI (port **5432**)     | `DATABASE_URL` in `.env.production` (migrations, seed, worker)         |
| **Transaction pooler** URI (port **6543**) | `DATABASE_URL` in **Vercel** only (step 7), plus `DATABASE_POOL_MAX=2` |

Then create the schema:

```bash
pnpm prod:migrate
```

- [ ] **Check:** it prints `Applied: 0001_init, … 0010_worker_presence`.
- [ ] **Check:** Dashboard → **SQL Editor** →
  `select rolname from pg_roles where rolname like 'reelplane%';` returns `reelplane_api`
  and `reelplane_worker`.

If it fails with a certificate error: the Session pooler string must end with
`?sslmode=require`. If it still fails, tell me the exact error. Node's `pg` driver and
Supabase's certificate chain sometimes need a small config change.

## 3. Storage bucket and S3 keys (Supabase Storage)

1. **Storage → New bucket:**
   - **Name:** `reelplane`.
   - **Public bucket:** **on**.
   - **Restrict file size:** on, **50 MB**.
   - **Allowed MIME types:** leave empty.
2. **Storage → Settings → S3 Connection:** turn on "Connection via S3 protocol" if it's off.
   Copy:
   - **Endpoint** → `STORAGE_ENDPOINT` (like `https://<ref>.supabase.co/storage/v1/s3`)
   - **Region** → `STORAGE_REGION` (like `ap-south-1`)
3. Same page → **New access key**, name it `reelplane`. Copy:
   - **Access key ID** → `STORAGE_ACCESS_KEY_ID`
   - **Secret access key** → `STORAGE_SECRET_ACCESS_KEY` (shown once)
4. Set `STORAGE_PUBLIC_BASE_URL` to
   `https://<ref>.supabase.co/storage/v1/object/public/reelplane`.
   `STORAGE_PROVIDER=supabase`, `STORAGE_BUCKET=reelplane` and `UPLOAD_MAX_BYTES=52428800` are
   already filled in.

```bash
pnpm prod:init-storage
```

- [ ] **Check:** it prints `Found bucket "reelplane" on supabase`. Two lines saying CORS rules
  and a public-read policy couldn't be set are **expected**: Supabase manages both itself
  (CORS internally, public reads through the bucket's Public switch).

## 4. Generate the two secrets

Run this twice, once per value:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

| Value      | Into (`.env.production` and Vercel) |
| ---------- | ----------------------------------- |
| first run  | `API_KEY_PEPPER`                    |
| second run | `CRON_SECRET`                       |

Never change `API_KEY_PEPPER` after seeding: every API key is hashed with it, so a new pepper
invalidates all of them.

- [ ] **Check:** both lines in `.env.production` have a 43-character value.

## 5. GitHub repository

1. github.com → **New repository** → name `reelplane`, **Public**, no README, licence or
   .gitignore (the repo already has them).
2. Push:

   ```bash
   git remote add origin https://github.com/<you>/reelplane.git
   git push -u origin main
   ```

3. Tell me the URL. I add it to both npm packages (`repository`, `homepage`) and to the
   READMEs.

- [ ] **Check:** the repo page shows the commits, and `.env`, `.env.production` and
  `apps/web/.env.local` are **not** in it.

## 6. GitHub sign-in (OAuth app)

Sign-in to the dashboard and to `/upload` is "Sign in with GitHub" through Supabase, with an
email link as the fallback.

1. github.com → **Settings → Developer settings → OAuth Apps → New OAuth App**:
   - **Application name:** `Reelplane`
   - **Homepage URL:** `https://<your-app>.vercel.app`. If you don't know it yet, use the repo
     URL and change it after step 7.
   - **Authorization callback URL:** `https://<ref>.supabase.co/auth/v1/callback`. This is
     Supabase's address, not your app's.
2. **Register application** → copy the **Client ID** → **Generate a new client secret** → copy
   it (shown once).
3. Supabase → **Authentication → Sign In / Providers → GitHub** → enable it, paste the Client ID
   and Client Secret → **Save**.

Nothing goes into `.env.production` or Vercel here: the GitHub secret lives only in Supabase.

- [ ] **Check:** reload `https://<ref>.supabase.co/auth/v1/settings?apikey=<anon key>`. It now
  shows `"github": true` under `external`. The sign-in itself is checked in step 9.

## 7. Vercel project

1. vercel.com → **Add New → Project** → import `reelplane` from GitHub.
2. **Root Directory:** `apps/web`. Leave "Include files outside the root directory" on.
3. **Framework:** Next.js (detected). Build and install commands: the defaults.
4. **Environment Variables**, scope **Production** only:

   | Variable                        | Value                                                   |
   | ------------------------------- | ------------------------------------------------------- |
   | `DATABASE_URL`                  | the **Transaction pooler** URI (port 6543), from step 2 |
   | `DATABASE_POOL_MAX`             | `2`                                                     |
   | `NEXT_PUBLIC_SUPABASE_URL`      | step 1                                                  |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | step 1                                                  |
   | `STORAGE_PROVIDER`              | `supabase`                                              |
   | `STORAGE_ENDPOINT`              | step 3                                                  |
   | `STORAGE_REGION`                | step 3                                                  |
   | `STORAGE_BUCKET`                | `reelplane`                                             |
   | `STORAGE_ACCESS_KEY_ID`         | step 3                                                  |
   | `STORAGE_SECRET_ACCESS_KEY`     | step 3                                                  |
   | `STORAGE_PUBLIC_BASE_URL`       | step 3                                                  |
   | `UPLOAD_MAX_BYTES`              | `52428800`                                              |
   | `API_KEY_PEPPER`                | step 4 (the same value as `.env.production`)            |
   | `CRON_SECRET`                   | step 4                                                  |
   | `TRUSTED_PROXY`                 | `vercel`                                                |

   Two more are added later: `NEXT_PUBLIC_SITE_URL` (step 8) and
   `NEXT_PUBLIC_DEMO_PUBLISHABLE_KEY` (step 11).

   **Never set:**
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `RATE_LIMIT_SCALE`
   - `REELPLANE_LOCAL_AUTH`
   - `WEBHOOK_ALLOW_PRIVATE_URLS`
5. **Settings → Functions → Region:** the same region as your Supabase project.
6. **Deploy.**

- [ ] **Check:** `https://<your-app>.vercel.app/v1/health` answers `{"status":"ok"}`.
- [ ] **Check:** `https://<your-app>.vercel.app/` shows "The demo feed is not set up yet". The
  demo key comes in step 11.

## 8. Site URL in Vercel

1. Vercel → Settings → Environment Variables → add `NEXT_PUBLIC_SITE_URL` =
   `https://<your-app>.vercel.app`, Production. Add it to `.env.production` too.
2. Deployments → the latest → **Redeploy**. `NEXT_PUBLIC_*` values are built into the app, so
   changing one always needs a redeploy.

- [ ] **Check:** the redeploy succeeds.

## 9. Supabase URL settings

Supabase → **Authentication → URL Configuration**:
- **Site URL:** `https://<your-app>.vercel.app`
- **Redirect URLs:** add `https://<your-app>.vercel.app/auth/callback`. Keep
  `http://localhost:3000/**` for local development.

Supabase → **Authentication → Emails → Magic Link**: the link in the template should be

```
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email
```

so a link requested on one device also opens on another.

- [ ] **Check:** `https://<your-app>.vercel.app/login` → **Sign in with GitHub** → GitHub asks
  to authorize "Reelplane" → you land on `/dashboard`, showing your GitHub email.
- [ ] **Check:** sign out, request an email link, open it on your phone → it signs you in.

## 10. Your user id (for seeding)

Supabase → **Authentication → Users** → your row (the GitHub sign-in from step 9) → copy
**User UID** → `SEED_OWNER_ID` in `.env.production`. The seeded demo project then belongs to
you and shows in your dashboard.

- [ ] **Check:** `SEED_OWNER_ID` is a 36-character UUID.

## 11. Seed the showcase videos into production

Two terminals, both at the repo root:

```bash
# terminal 1: a worker on production's queue and storage (Ctrl+C when seeding is done)
pnpm prod:worker

# terminal 2:
pnpm prod:seed
```

The seed uploads every clip in `content/showcase` through the real upload path, waits until
the worker has published them, and prints:

```
NEXT_PUBLIC_DEMO_PUBLISHABLE_KEY=rp_pk_…
```

Add it to Vercel (Production) and to `.env.production`, then **Redeploy**.

- [ ] **Check:** `https://<your-app>.vercel.app/` plays the feed, on your laptop and on your
  phone over mobile data.
- [ ] **Check:** `/dashboard` lists "Reelplane demo", and its **Videos** tab shows every clip as
  **ready**.

## 12. Daily cleanup cron

Vercel → **Settings → Cron Jobs** should list `/api/cron/cleanup`, daily at 04:17 UTC, from
`apps/web/vercel.json`.

- [ ] **Check:** click **Run** next to it → its log shows a 200 and a JSON report. Without
  `CRON_SECRET` it answers 503; with a wrong one, 401.

## 13. Publish the SDK to npm

1. npmjs.com → sign up or log in → enable 2FA → **Add Organization** → `reelplane` (free, for
   public packages).
2. Locally:

   ```bash
   npm login
   pnpm --filter @reelplane/sdk-core --filter @reelplane/sdk-react build
   cd packages/sdk-core && pnpm publish --access public
   cd ../sdk-react && pnpm publish --access public
   ```

   Publish `sdk-core` first: `sdk-react` depends on it.

- [ ] **Check:** `npm view @reelplane/sdk-react version` prints `0.1.0`.

## 14. Hand over for the smoke test

Tell me the production URL. I check:
- the feed plays;
- the API answers with the right CORS and rate-limit headers;
- GitHub and email sign-in work;
- the dashboard and `/upload` behave with the worker on and off;
- the cron answers.

Then I report the results.

## Afterwards

- **To process uploads, run `pnpm prod:worker`.** While it's off, uploads wait in the queue,
  and the upload page says so.
- **Supabase pauses a free project after 7 days without activity,** and a paused project means
  the demo is down. Opening the demo or the dashboard counts as activity.
