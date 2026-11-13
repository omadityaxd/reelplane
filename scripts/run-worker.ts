/**
 * `pnpm prod:worker`: runs the Go worker with the environment this script was started with
 * (`tsx --env-file=.env.production`), so it works on production's queue and storage. The worker
 * itself reads only environment variables.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const child = spawn("go", ["run", "./cmd/worker"], {
  cwd: join(import.meta.dirname, "..", "services", "worker"),
  env: process.env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
