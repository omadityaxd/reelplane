import Link from "next/link";
import type { ReactNode } from "react";
import { requireProject } from "@/lib/server/dashboard/session.ts";
import { ProjectTabs } from "../_components/tabs.tsx";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { project } = await requireProject((await params).projectId);
  return (
    <>
      <div className="dash-crumbs">
        <Link href="/dashboard">Projects</Link> /
      </div>
      <h1>{project.name}</h1>
      <div className="mono dash-note">{project.id}</div>
      <ProjectTabs projectId={project.id} />
      {children}
    </>
  );
}
