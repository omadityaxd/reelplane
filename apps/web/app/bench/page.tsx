import { BenchRunner } from "./bench-runner.tsx";

export default function BenchPage() {
  const publishableKey = process.env.NEXT_PUBLIC_BENCH_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return (
      <main style={{ padding: 24 }}>
        Run <code>pnpm bench:seed</code> (with the worker running) and restart the server.
      </main>
    );
  }
  return <BenchRunner publishableKey={publishableKey} />;
}
