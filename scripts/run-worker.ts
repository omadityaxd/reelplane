/**
 * `pnpm prod:worker`: runs the worker on production's queue and storage (env from
 * `tsx --env-file=.env.production`) inside its Docker container, never directly on this machine.
 * It processes files anyone can upload, so FFmpeg runs isolated: no Linux capabilities, no
 * privilege escalation, a read-only filesystem except a size-capped /tmp, memory and process
 * limits, as the image's non-root user, and only the variables the worker reads.
 *
 * Local development keeps the native worker (`pnpm worker:dev`, `pnpm phone`), or the
 * compose service (`pnpm worker:up`).
 */
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const IMAGE = "reelplane-worker:prod";
const CONTAINER = "reelplane-worker-prod";
/** Every variable the worker reads (services/worker/internal/config); nothing else goes in. */
const WORKER_ENV = [
  "DATABASE_URL",
  "STORAGE_PROVIDER",
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_FORCE_PATH_STYLE",
  "LOG_FORMAT",
  "MAX_VIDEO_DURATION",
  "DEMO_VIDEO_MAX_AGE",
  "FFMPEG_PRESET",
  "FFMPEG_THREADS",
  "WEBHOOK_MAX_ATTEMPTS",
  "WEBHOOK_RETRY_BASE",
  "WEBHOOK_RETRY_MAX",
  "WEBHOOK_TIMEOUT",
  "WORKER_CLEANUP_INTERVAL",
  "WORKER_GARBAGE_DELAY",
  "WORKER_HEARTBEAT_INTERVAL",
  "WORKER_JOB_TIMEOUT",
  "WORKER_LEASE_DURATION",
  "WORKER_POLL_INTERVAL",
  "WORKER_RETRY_BASE",
  "WORKER_RETRY_MAX",
  "WORKER_SHUTDOWN_GRACE",
];

function fail(message: string): never {
  process.stderr.write(`prod:worker: ${message}\n`);
  process.exit(1);
}

/** ISO week, e.g. 2026-W47: rebuilds the FFmpeg layer weekly to pick up Debian's security fixes. */
function isoWeek(date = new Date()): string {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL is not set in .env.production.");
if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(databaseUrl)) {
  fail("DATABASE_URL points at localhost, which inside the container is the container itself.");
}
if (process.env.WEBHOOK_ALLOW_PRIVATE_URLS) {
  fail("WEBHOOK_ALLOW_PRIVATE_URLS is for local development only; remove it from .env.production.");
}
if (spawnSync("docker", ["version", "--format", "{{.Server.Version}}"]).status !== 0) {
  fail("Docker isn't running. Start Docker Desktop and run `pnpm prod:worker` again.");
}

const build = spawnSync(
  "docker",
  [
    "build",
    "--tag",
    IMAGE,
    "--build-arg",
    `FFMPEG_REFRESH=${isoWeek()}`,
    join(import.meta.dirname, "..", "services", "worker"),
  ],
  { stdio: "inherit" },
);
if (build.status !== 0) fail("the worker image failed to build.");

const run = [
  "run",
  "--rm",
  "--init",
  "--name",
  CONTAINER,
  "--read-only",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,nodev,size=4g",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "512",
  "--memory",
  "4g",
  "--memory-swap",
  "4g",
  "--stop-timeout",
  "30", // longer than WORKER_SHUTDOWN_GRACE (20 s): a job in flight finishes or is released
  // `-e NAME` without a value: Docker copies it from this process, so secrets never appear in
  // the command line or the process list.
  ...WORKER_ENV.filter((name) => process.env[name]).flatMap((name) => ["-e", name]),
  IMAGE,
];
const child = spawn("docker", run, { stdio: "inherit" });
// Ctrl+C reaches `docker run` directly, which hands it to the worker (it then drains). Forwarding
// it as well would be a second signal, which ends the worker without draining.
process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => {
  spawnSync("docker", ["stop", CONTAINER], { stdio: "inherit" });
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
