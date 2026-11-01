import { DemoFeed } from "./demo-feed.tsx";

export default function HomePage() {
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
      <DemoFeed publishableKey={publishableKey} />
    </main>
  );
}
