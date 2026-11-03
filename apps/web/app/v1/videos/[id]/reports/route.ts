import { corsPreflight } from "@/lib/server/api-route.ts";
import { bind } from "@/lib/server/endpoint.ts";
import { reportFeedVideo } from "@/lib/server/endpoints/feeds.ts";
import { appDeps } from "@/lib/server/routes.ts";

export const dynamic = "force-dynamic";
export const POST = bind(reportFeedVideo, appDeps);
export const OPTIONS = corsPreflight("POST, OPTIONS");
