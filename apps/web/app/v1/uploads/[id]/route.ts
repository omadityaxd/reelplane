import { corsPreflight } from "@/lib/server/api-route.ts";
import { bind } from "@/lib/server/endpoint.ts";
import { abortUpload } from "@/lib/server/endpoints/uploads.ts";
import { appDeps } from "@/lib/server/routes.ts";

export const dynamic = "force-dynamic";
export const DELETE = bind(abortUpload, appDeps);
export const OPTIONS = corsPreflight("DELETE, OPTIONS");
