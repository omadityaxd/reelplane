import { getProject } from "@reelplane/db";
import { apiRoute, corsPreflight, json } from "@/lib/server/api-route.ts";
import { db } from "@/lib/server/db.ts";
import { ApiError } from "@/lib/server/errors.ts";
import { appDeps } from "@/lib/server/routes.ts";

export const dynamic = "force-dynamic";

/** GET /v1/project — the project the API key belongs to. Works with either key kind. */
export const GET = apiRoute(
  { allow: ["secret", "publishable"] },
  async (_request, auth) => {
    const project = await getProject(db(), auth.projectId);
    if (!project) throw new ApiError("not_found", "Project not found.");
    return json({
      data: {
        id: project.id,
        name: project.name,
        // Allowed origins are configuration a secret-key holder manages; not for browsers.
        ...(auth.keyKind === "secret" ? { allowedOrigins: project.allowedOrigins } : {}),
      },
    });
  },
  appDeps,
);

export const OPTIONS = corsPreflight("GET, OPTIONS");
