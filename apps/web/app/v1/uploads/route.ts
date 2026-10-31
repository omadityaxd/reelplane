import { corsPreflight } from "@/lib/server/api-route.ts";
import { bind } from "@/lib/server/endpoint.ts";
import { createUpload } from "@/lib/server/endpoints/uploads.ts";
import { appDeps } from "@/lib/server/routes.ts";

export const dynamic = "force-dynamic";
export const POST = bind(createUpload, appDeps);
export const OPTIONS = corsPreflight("POST, OPTIONS");
