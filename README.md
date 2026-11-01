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

Run the storage contract against the real local S3 server:

```bash
STORAGE_INTEGRATION=1 pnpm --filter @reelplane/storage test
```

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
