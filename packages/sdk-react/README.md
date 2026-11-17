# @reelplane/sdk-react

`<ReelFeed />`: a vertical, swipeable short-video feed for the
Reelplane video backend. HLS with an adaptive
ladder, the next videos preloaded and warmed for instant swipe-to-play, playback metrics sent
back for analytics.

```bash
npm install @reelplane/sdk-react
```

```tsx
import { ReelFeed } from "@reelplane/sdk-react";

export function Reels() {
  return (
    <div style={{ height: "100dvh" }}>
      <ReelFeed publishableKey="rp_pk_…" feed="trending" />
    </div>
  );
}
```

- `publishableKey`: your project's publishable key. Safe in the browser: it only reads feeds,
  and only from the origins you allow in the dashboard.
- `feed`: `trending` (default), `latest` or `creator:<id>`.
- `apiBaseUrl`: where your Reelplane API lives (default: the page's origin).
- `initialPage`: the first page fetched on your server, so the first video's poster paints
  before any JavaScript runs.
- `renderOverlay`, `onActiveChange`, `onMetric`, `debug`: see the type definitions.

Swipe, scroll or use the arrow keys to move; tap or Space to pause; `m` toggles sound. React 18
or 19. MIT licensed. Source, issues and the video backend:
[github.com/omadityaxd/reelplane](https://github.com/omadityaxd/reelplane).
