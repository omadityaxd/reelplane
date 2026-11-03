import type { FeedPage } from "@reelplane/sdk-core";
import { demoProjectId } from "@/lib/server/demo.ts";
import { firstFeedPage } from "@/lib/server/endpoints/feeds.ts";
import { appDeps } from "@/lib/server/routes.ts";
import { DemoFeed } from "./demo-feed.tsx";

export const dynamic = "force-dynamic";

/** Same page size as <ReelFeed>'s default, so the client continues with the next page. */
const FIRST_PAGE = 10;

/** The first feed page, rendered into the HTML; null (the client fetches it) if that fails. */
async function initialPage(): Promise<FeedPage | null> {
  try {
    const projectId = await demoProjectId();
    if (!projectId) return null;
    return (await firstFeedPage(appDeps(), projectId, { kind: "latest" }, FIRST_PAGE)) as FeedPage;
  } catch (error) {
    console.error("[demo] server-rendering the first feed page failed", error);
    return null;
  }
}

export default async function HomePage() {
  const publishableKey = process.env.NEXT_PUBLIC_DEMO_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return (
      <main style={{ padding: 24, maxWidth: 560, margin: "0 auto" }}>
        <h1>Reelplane</h1>
        <p>
          The demo feed is not set up yet. Run <code>pnpm showcase:seed</code> (with the worker
          running) and restart the dev server.
        </p>
      </main>
    );
  }
  return (
    <main style={{ height: "100dvh" }}>
      <DemoFeed publishableKey={publishableKey} initialPage={await initialPage()} />
    </main>
  );
}
