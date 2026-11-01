import { corsPreflight } from "@/lib/server/api-route.ts";
import { bind } from "@/lib/server/endpoint.ts";
import { likeVideo, unlikeVideo } from "@/lib/server/endpoints/feeds.ts";
import { appDeps } from "@/lib/server/routes.ts";

export const dynamic = "force-dynamic";
export const POST = bind(likeVideo, appDeps);
export const DELETE = bind(unlikeVideo, appDeps);
export const OPTIONS = corsPreflight("POST, DELETE, OPTIONS");
