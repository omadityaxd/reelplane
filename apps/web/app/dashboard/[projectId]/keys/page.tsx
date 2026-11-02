import { type ApiKeyRecord, listApiKeys } from "@reelplane/db";
import { requireProject } from "@/lib/server/dashboard/session.ts";
import { appDeps } from "@/lib/server/routes.ts";
import { type KeyRow, KeysManager } from "../../_components/keys-manager.tsx";

function keyState(key: ApiKeyRecord, now: Date): KeyRow["state"] {
  if (key.revokedAt) return "revoked";
  if (key.expiresAt) return key.expiresAt > now ? "expiring" : "expired";
  return "active";
}

export default async function KeysPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { project } = await requireProject((await params).projectId);
  const now = new Date();
  const keys: KeyRow[] = (await listApiKeys(appDeps().pool, project.id)).map((key) => ({
    id: key.id,
    kind: key.kind,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    state: keyState(key, now),
    expiresAt: key.expiresAt?.toISOString() ?? null,
  }));
  return (
    <>
      <p className="dash-note">
        Publishable keys are safe in a browser: they can only read feeds, and only from your allowed
        origins (Settings). Secret keys have full access: keep them on your server. Keys are stored
        as hashes, so a key is shown only when it is created.
      </p>
      <KeysManager projectId={project.id} keys={keys} />
    </>
  );
}
