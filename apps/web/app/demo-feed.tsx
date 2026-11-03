"use client";

import type { FeedItem } from "@reelplane/sdk-core";
import { ReelFeed } from "@reelplane/sdk-react";
import Link from "next/link";
import { useEffect, useState } from "react";

const REASONS = [
  { value: "spam", label: "Spam" },
  { value: "nudity", label: "Nudity" },
  { value: "violence", label: "Violence" },
  { value: "copyright", label: "Copyright" },
  { value: "other", label: "Something else" },
] as const;

const chip = {
  pointerEvents: "auto",
  border: 0,
  borderRadius: 999,
  padding: "6px 12px",
  background: "rgb(0 0 0 / 0.5)",
  color: "#fff",
  font: "600 13px system-ui, sans-serif",
  textDecoration: "none",
  cursor: "pointer",
} as const;

/** Title, credit and a report button (three reports hide a video from the feed). */
function Overlay({ item, publishableKey }: { item: FeedItem; publishableKey: string }) {
  const [state, setState] = useState<"idle" | "choosing" | "sent" | "failed">("idle");
  const credit = typeof item.metadata.credit === "string" ? item.metadata.credit : null;
  const license = typeof item.metadata.license === "string" ? item.metadata.license : null;

  async function report(reason: string) {
    try {
      const response = await fetch(`/v1/videos/${item.id}/reports`, {
        method: "POST",
        headers: { authorization: `Bearer ${publishableKey}`, "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      setState(response.ok ? "sent" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      {item.title && <p className="rp-title">{item.title}</p>}
      {(credit || license) && (
        <p className="rp-credit">{[credit, license].filter(Boolean).join(" · ")}</p>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, marginRight: 56 }}>
        {state === "idle" && (
          <button type="button" style={chip} onClick={() => setState("choosing")}>
            Report
          </button>
        )}
        {state === "choosing" &&
          REASONS.map((reason) => (
            <button
              key={reason.value}
              type="button"
              style={chip}
              onClick={() => void report(reason.value)}
            >
              {reason.label}
            </button>
          ))}
        {state === "sent" && <span role="status">Reported. Thanks.</span>}
        {state === "failed" && <span role="alert">Couldn't send the report. Try again later.</span>}
      </div>
    </>
  );
}

export function DemoFeed({ publishableKey }: { publishableKey: string }) {
  // `?debug=1` shows live playback details over the feed (for testing on real phones).
  const [debug, setDebug] = useState(false);
  useEffect(() => setDebug(new URLSearchParams(window.location.search).get("debug") === "1"), []);
  return (
    <>
      <nav
        aria-label="Reelplane"
        style={{
          position: "fixed",
          top: "calc(12px + env(safe-area-inset-top, 0px))",
          left: 12,
          zIndex: 5,
          display: "flex",
          gap: 8,
        }}
      >
        <Link href="/upload" style={chip}>
          Upload a reel
        </Link>
        <Link href="/developers" style={chip}>
          Use Reelplane
        </Link>
      </nav>
      <ReelFeed
        publishableKey={publishableKey}
        feed="latest"
        debug={debug}
        renderOverlay={(item) => <Overlay item={item} publishableKey={publishableKey} />}
        aria-label="Reelplane demo feed"
      />
    </>
  );
}
