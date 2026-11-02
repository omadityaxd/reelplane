import { bind } from "@/lib/server/endpoint.ts";
import { deleteProjectVideo, getProjectVideo } from "@/lib/server/endpoints/videos.ts";
import { appDeps } from "@/lib/server/routes.ts";

export const dynamic = "force-dynamic";
export const GET = bind(getProjectVideo, appDeps);
export const DELETE = bind(deleteProjectVideo, appDeps);
