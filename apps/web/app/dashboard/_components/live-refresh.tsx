"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const REFRESH_MS = 2000;

/** Re-renders the server page every 2 s while `active` (a video still being processed). */
export function LiveRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  return active ? (
    <span className="dash-badge dash-badge--info" role="status">
      live
    </span>
  ) : null;
}
