"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { path: "", label: "Videos" },
  { path: "/jobs", label: "Jobs" },
  { path: "/analytics", label: "Analytics" },
  { path: "/keys", label: "API keys" },
  { path: "/webhooks", label: "Webhooks" },
  { path: "/settings", label: "Settings" },
];

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/dashboard/${projectId}`;
  const current =
    TABS.filter((tab) => tab.path && pathname.startsWith(base + tab.path)).at(-1)?.path ?? "";
  return (
    <nav className="dash-tabs" aria-label="Project">
      {TABS.map((tab) => (
        <Link
          key={tab.path}
          href={base + tab.path}
          aria-current={tab.path === current ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
