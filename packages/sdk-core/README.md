# @reelplane/sdk-core

The framework-free core of the Reelplane SDK:
resumable direct-to-storage uploads, the feed player with preloading, playback metrics, and
webhook verification. `@reelplane/sdk-react` builds `<ReelFeed />` on it.

```bash
npm install @reelplane/sdk-core
```

Upload a video from the browser (your server creates the session with its secret key):

```ts
import { uploadVideo } from "@reelplane/sdk-core";

await uploadVideo({
  apiBaseUrl: "https://<your-reelplane>",
  file,
  session, // { videoId, token } from POST /v1/uploads on your server
  onProgress: ({ fraction }) => console.log(Math.round(fraction * 100), "%"),
});
```

Verify a webhook on your server (Node 20+, Deno, Bun, edge runtimes):

```ts
import { verifyWebhook } from "@reelplane/sdk-core";

const event = await verifyWebhook({
  payload: await request.text(),
  signature: request.headers.get("Reelplane-Signature"),
  secret: process.env.REELPLANE_WEBHOOK_SECRET!,
});
```

hls.js (light build) is loaded on demand for the first playback, and never on Apple devices,
which play HLS natively. MIT licensed.
