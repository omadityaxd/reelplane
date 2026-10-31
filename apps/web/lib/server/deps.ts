import type { ObjectStorage } from "@reelplane/storage";
import type { AuthDeps } from "./auth.ts";
import type { UploadLimits } from "./uploads/limits.ts";

/** Everything a route handler needs; production values come from `appDeps()`, tests inject. */
export interface AppDeps extends AuthDeps {
  storage: ObjectStorage;
  limits: UploadLimits;
}
