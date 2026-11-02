# Reelplane

Open-source, self-hostable Reels SDK and video backend: resumable direct-to-storage uploads, a
Postgres job queue, a Go/FFmpeg transcoding worker and a `<ReelFeed />` component.

> Work in progress. Built phase by phase from [the brief](docs/briefs/reelkit-brief.md).

## Run it locally (no accounts needed)

```bash
pnpm install
pnpm infra:up      # Postgres 18 + RustFS (S3-compatible) in Docker
pnpm infra:init    # create the bucket + CORS rules, run DB migrations
pnpm db:seed       # create a local project and print its API keys (shown once)
pnpm services      # shows which backend each component uses
pnpm check         # lint + typecheck + tests (tests need `infra:up`)
pnpm --filter @reelplane/web dev   # http://localhost:3000/v1/project
```

The transcoding worker (Go + FFmpeg), natively or in Docker:

```bash
pnpm worker:dev    # needs Go and FFmpeg on PATH
pnpm worker:up     # or: build and run the Docker image next to the local stack
pnpm worker:chaos  # kill workers at random while N jobs run; checks exactly-once
```

### Test on your phone (one command)

```bash
pnpm phone               # add --skip-build to reuse the last web build
```

It starts the Docker infra, builds and runs the worker, seeds the demo and bench videos for your
current Wi-Fi address, builds and serves the web app on `0.0.0.0:3000`, and prints the URLs:

```
Ready. On your phone (same Wi-Fi as this laptop):
  Feed:          http://192.168.1.12:3000/?debug=1
  Bench:         http://192.168.1.12:3000/bench?preload=1  and  ?preload=0
```

Ctrl+C stops the worker and the web app; `pnpm infra:down` stops Docker. Run it again whenever
your Wi-Fi address changes. If the phone can't connect, allow Node.js through the Windows
firewall on private networks.

The same steps by hand (needs the worker running):

```bash
pnpm showcase:clips   # cut the CC BY Blender clips (see content/README.md)
pnpm showcase:seed    # upload them + your phone videos through the real upload path
pnpm bench:seed       # 30 distinct videos for /bench
pnpm --filter @reelplane/web build && pnpm --filter @reelplane/web start -H 0.0.0.0
# open http://<your-lan-ip>:3000 on your phone (same Wi-Fi); /bench?preload=1|0 to measure
```

Use it in your app:

```tsx
import { ReelFeed } from "@reelplane/sdk-react";

<div style={{ height: "100dvh" }}>
  <ReelFeed publishableKey="rp_pk_…" feed="trending" />
</div>;
```

Run the storage contract against the real local S3 server:

```bash
STORAGE_INTEGRATION=1 pnpm --filter @reelplane/storage test
```

## Dashboard

`pnpm --filter @reelplane/web dev`, then open http://localhost:3000/dashboard. Locally there is
no sign-in (you own the seeded projects); with Supabase configured, sign-in is by email magic
link. Per project:

- **Videos:** upload from the browser, preview, and a live processing timeline per video (every
  status change and job attempt, from the audit trail), plus the rendition ladder it got.
- **Jobs:** state, attempts, progress and errors, filterable.
- **Analytics:** time to first frame p50/p95, rebuffers per view, completion and views, from
  the player SDK's playback events.
- **API keys:** create, rotate with a grace period, revoke. Keys are shown once.
- **Webhooks:** endpoints, signing secrets, a test event, and a delivery log with redelivery.

### Webhooks

`video.ready`, `video.failed` and `video.deleted` are POSTed to your endpoints by the worker,
signed and retried. Verify them with the SDK:

```ts
import { verifyWebhook } from "@reelplane/sdk-core";

export async function POST(request: Request) {
  const event = await verifyWebhook({
    payload: await request.text(), // the raw body
    signature: request.headers.get("Reelplane-Signature"),
    secret: process.env.REELPLANE_WEBHOOK_SECRET!,
  });
  if (event.type === "video.ready") {
    // event.data.video.id is ready; GET /v1/videos/:id for its playback URLs.
  }
  return new Response(null, { status: 204 });
}
```

Deliveries are at-least-once: dedupe on `event.id`. To try webhooks on your laptop with a
receiver on localhost, run the worker with `WEBHOOK_ALLOW_PRIVATE_URLS=true`.

## Layout

```
apps/web            Next.js: API, dashboard, demo          (Phase 2+)
packages/storage    one S3-compatible storage interface
packages/sdk-core   framework-free player + preloading     (Phase 5)
packages/sdk-react  the <ReelFeed /> component             (Phase 5)
services/worker     Go transcoding worker                   (Phase 4)
docs/               architecture, services, decisions
```

Service choices and free-tier checks: [docs/SERVICES.md](docs/SERVICES.md).

## License

MIT
