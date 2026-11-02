import { listProjectsForUser } from "@reelplane/db";
import Link from "next/link";
import { formatDate } from "@/lib/dashboard/format.ts";
import { requireUser } from "@/lib/server/dashboard/session.ts";
import { db } from "@/lib/server/db.ts";
import { CreateProject } from "./_components/create-project.tsx";

export default async function ProjectsPage() {
  const user = await requireUser();
  const projects = await listProjectsForUser(db(), user.id);
  return (
    <>
      <h1>Projects</h1>
      <p className="dash-note">Each project has its own videos, API keys and webhooks.</p>
      <section className="dash-card">
        <CreateProject />
      </section>
      {projects.length === 0 ? (
        <p className="dash-empty">No projects yet.</p>
      ) : (
        <section className="dash-card dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Allowed origins</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link href={`/dashboard/${project.id}`}>
                      <strong>{project.name}</strong>
                    </Link>
                    {project.isDemo && <span className="dash-badge">demo</span>}
                  </td>
                  <td className="mono">{project.allowedOrigins.join(", ") || "–"}</td>
                  <td>{formatDate(project.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
