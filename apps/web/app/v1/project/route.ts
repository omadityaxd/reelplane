import { corsPreflight } from "@/lib/server/api-route.ts";
import { bind } from "@/lib/server/endpoint.ts";
import { getCurrentProject } from "@/lib/server/endpoints/videos.ts";
import { appDeps } from "@/lib/server/routes.ts";

export const dynamic = "force-dynamic";
export const GET = bind(getCurrentProject, appDeps);
export const OPTIONS = corsPreflight("GET, OPTIONS");
