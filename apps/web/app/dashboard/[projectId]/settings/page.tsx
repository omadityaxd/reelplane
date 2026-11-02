import { requireProject } from "@/lib/server/dashboard/session.ts";
import { SettingsForm } from "../../_components/settings-form.tsx";

export default async function SettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { project } = await requireProject((await params).projectId);
  return (
    <section className="dash-card">
      <SettingsForm
        projectId={project.id}
        name={project.name}
        origins={project.allowedOrigins.join("\n")}
      />
    </section>
  );
}
