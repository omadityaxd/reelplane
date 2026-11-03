import type { Metadata } from "next";
import Link from "next/link";
import "../dashboard/dashboard.css";

export const metadata: Metadata = { title: "Use Reelplane in your app" };

const install = "npm install @reelplane/sdk-react";

const feed = `import { ReelFeed } from "@reelplane/sdk-react";

export function Reels() {
  return (
    <div style={{ height: "100dvh" }}>
      <ReelFeed publishableKey="rp_pk_…" feed="trending" />
    </div>
  );
}`;

const upload = `// Server: create an upload session with your secret key.
const res = await fetch("https://<your-reelplane>/v1/uploads", {
  method: "POST",
  headers: {
    authorization: \`Bearer \${process.env.REELPLANE_SECRET_KEY}\`,
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  },
  body: JSON.stringify({ contentType: file.type, sizeBytes: file.size }),
});
const { data } = await res.json(); // hand data.upload to the browser

// Browser: upload straight to storage, resumable, in parallel parts.
import { uploadVideo } from "@reelplane/sdk-core";
await uploadVideo({ apiBaseUrl: "https://<your-reelplane>", file, session: data.upload });`;

const webhook = `import { verifyWebhook } from "@reelplane/sdk-core";

export async function POST(request: Request) {
  const event = await verifyWebhook({
    payload: await request.text(),
    signature: request.headers.get("Reelplane-Signature"),
    secret: process.env.REELPLANE_WEBHOOK_SECRET!,
  });
  if (event.type === "video.ready") { /* publish it in your app */ }
  return new Response(null, { status: 204 });
}`;

function Code({ children }: { children: string }) {
  return (
    <pre className="dash-card mono" style={{ overflowX: "auto", margin: "0 0 16px" }}>
      <code>{children}</code>
    </pre>
  );
}

export default function DevelopersPage() {
  return (
    <div className="dash">
      <main className="dash-main" style={{ maxWidth: 760 }}>
        <p>
          <Link href="/">← Back to the feed</Link>
        </p>
        <h1>Use Reelplane in your app</h1>
        <p className="dash-note">
          The feed you just swiped is the open-source <code>&lt;ReelFeed /&gt;</code> component: HLS
          with an adaptive ladder, the next videos preloaded and warmed, and playback metrics sent
          back for analytics. Create a project and keys in the{" "}
          <Link href="/dashboard">dashboard</Link>.
        </p>
        <h2>1. Install</h2>
        <Code>{install}</Code>
        <h2>2. Show a feed</h2>
        <p className="dash-note">
          A publishable key is safe in the browser: it reads feeds, only from your allowed origins.
        </p>
        <Code>{feed}</Code>
        <h2>3. Let users upload</h2>
        <Code>{upload}</Code>
        <h2>4. Hear when a video is ready</h2>
        <Code>{webhook}</Code>
      </main>
    </div>
  );
}
