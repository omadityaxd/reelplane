import type { Metadata } from "next";
import Link from "next/link";
import { UploadButton } from "@/app/dashboard/_components/upload-button.tsx";
import { authMode, currentUser } from "@/lib/server/dashboard/session.ts";
import { DEMO_LIMITS, workerOnline } from "@/lib/server/demo.ts";
import { DEFAULT_UPLOAD_LIMITS } from "@/lib/server/uploads/limits.ts";

const MAX_MB = Math.floor(DEFAULT_UPLOAD_LIMITS.maxBytes / (1024 * 1024));

import "../dashboard/dashboard.css";
import { createDemoUpload } from "./actions.ts";

export const metadata: Metadata = { title: "Upload a reel · Reelplane" };
export const dynamic = "force-dynamic";

export default async function UploadPage() {
  const [user, online] = await Promise.all([currentUser(), workerOnline()]);
  return (
    <main className="dash dash-login" style={{ paddingTop: "10vh" }}>
      <p>
        <Link href="/">← Back to the feed</Link>
      </p>
      <h1>Upload your own reel</h1>
      <p className="dash-note">
        It goes through the real pipeline: straight to storage, transcoded by the worker into an HLS
        ladder, then into the demo feed. Up to 60 s and {MAX_MB} MB, {DEMO_LIMITS.perUserPerDay} a
        day. Demo uploads are deleted after 7 days, and anyone can report one.
      </p>
      {!online && (
        <p className="dash-secret" role="status">
          The transcoding worker is offline right now (it runs on the author's laptop). Your upload
          is stored and queued, and appears in the feed once the worker is back. The feed itself
          works either way: its videos are already processed.
        </p>
      )}
      {user ? (
        <section className="dash-card">
          <UploadButton
            start={createDemoUpload}
            note="Only upload videos you have the rights to."
          />
        </section>
      ) : authMode() === "disabled" ? (
        <p className="dash-note">Uploads need sign-in, which isn't configured on this server.</p>
      ) : (
        <Link className="dash-button dash-button--primary" href="/login?next=/upload">
          Sign in to upload
        </Link>
      )}
    </main>
  );
}
