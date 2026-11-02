import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { authMode, requireUser } from "@/lib/server/dashboard/session.ts";
import { signOut } from "../login/actions.ts";
import "./dashboard.css";

export const metadata: Metadata = { title: "Dashboard · Reelplane" };
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const mode = authMode();
  return (
    <div className="dash">
      <header className="dash-top">
        <Link href="/dashboard" className="dash-brand">
          Reelplane
        </Link>
        <span className="dash-spacer" />
        {mode === "local" ? (
          <span className="dash-badge" title="No sign-in: local development only">
            local developer
          </span>
        ) : (
          <>
            <span className="dash-note" style={{ margin: 0 }}>
              {user.email}
            </span>
            <form action={signOut}>
              <button type="submit" className="dash-button">
                Sign out
              </button>
            </form>
          </>
        )}
      </header>
      <main className="dash-main">{children}</main>
    </div>
  );
}
