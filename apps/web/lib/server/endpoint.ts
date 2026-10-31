import { type ApiHandler, type ApiRouteOptions, apiRoute } from "./api-route.ts";
import type { AppDeps } from "./deps.ts";

/** An endpoint's auth rules and handler, independent of where its dependencies come from. */
export interface Endpoint {
  options: ApiRouteOptions;
  handler: ApiHandler<AppDeps>;
}

export function endpoint(options: ApiRouteOptions, handler: ApiHandler<AppDeps>): Endpoint {
  return { options, handler };
}

/** Binds an endpoint to concrete dependencies: `appDeps` in routes, test doubles in tests. */
export function bind(definition: Endpoint, deps: () => AppDeps) {
  return apiRoute(definition.options, definition.handler, deps);
}
