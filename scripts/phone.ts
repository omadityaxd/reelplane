/**
 * `pnpm phone`: starts everything needed to test the demo feed on a phone, then prints the URL.
 *
 *   1. Docker infra (Postgres + S3 storage), bucket/CORS for the LAN origin, DB migrations.
 *   2. The Go worker (built fresh), running in the background of this command.
 *   3. The demo and bench projects (`showcase:seed`, `bench:seed`): idempotent, only uploads
 *      what is new, and points allowed origins and media URLs at the current Wi-Fi address.
 *   4. A production build of the web app (`--skip-build` reuses the last one), served on
 *      0.0.0.0:3000 so the phone can reach it.
 *
 * Ctrl+C stops the worker and the web app; the Docker containers keep running
 * (`pnpm infra:down` stops them).
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { lanAddress } from "./lan.ts";
import { loadRootEnv } from "./load-env.ts";

loadRootEnv();

const ROOT = join(import.meta.dirname, "..");
const WEB = join(ROOT, "apps", "web");
const PORT = Number(process.env.DEMO_PORT ?? 3000);
const READY_TIMEOUT_MS = 60_000;
const SKIP_BUILD = process.argv.includes("--skip-build");
const WORKER_BIN = join(
  ROOT,
  "services",
  "worker",
  "bin",
  process.platform === "win32" ? "worker.exe" : "worker",
);

const children: ChildProcess[] = [];

function step(message: string): void {
  process.stdout.write(`\n▶ ${message}\n`);
}

/** Runs a command in the foreground; throws if it fails. */
function run(command: string, env: NodeJS.ProcessEnv = {}): void {
  execSync(command, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
}

/** Starts a long-running process directly (not via pnpm), so stopping it stops it for real. */
function background(name: string, command: string, args: string[], cwd: string): ChildProcess {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${name}] ${line}\n`)
      .join("");
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(prefix(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(prefix(chunk)));
  child.on("exit", (code) => {
    if (!stopping) {
      process.stderr.write(`\n${name} exited (code ${code}); stopping.\n`);
      stop(1);
    }
  });
  children.push(child);
  return child;
}

let stopping = false;
function stop(code = 0): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => server.close(() => resolve(true)))
      .listen(port, "0.0.0.0");
  });
}

async function waitForOk(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not answer 200 within ${READY_TIMEOUT_MS / 1000} s`);
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

try {
  if (!(await portFree(PORT))) {
    throw new Error(
      `Port ${PORT} is already in use (an earlier \`pnpm phone\` or dev server?). Stop it first.`,
    );
  }
  const lan = lanAddress();
  if (!lan) throw new Error("No Wi-Fi/Ethernet IPv4 address found. Is the laptop on Wi-Fi?");
  const origins = [`http://localhost:${PORT}`, `http://${lan}:${PORT}`];

  step("Docker infra (Postgres + storage)");
  run("pnpm infra:up");
  run("pnpm infra:init", { ALLOWED_UPLOAD_ORIGINS: origins.join(",") });

  step("Worker");
  run("pnpm worker:build");
  background("worker", WORKER_BIN, [], join(ROOT, "services", "worker"));

  step(`Demo + bench videos (origins: ${origins.join(", ")})`);
  run("pnpm showcase:seed", { DEMO_LAN_IP: lan });
  run("pnpm bench:seed", { DEMO_LAN_IP: lan });

  // The publishable keys are NEXT_PUBLIC_*, inlined at build time, so build after seeding.
  if (SKIP_BUILD && existsSync(join(WEB, ".next", "BUILD_ID"))) {
    step("Web app (reusing the last production build)");
  } else {
    step("Web app (production build)");
    run("pnpm --filter @reelplane/web build");
  }
  const nextBin = join(WEB, "node_modules", "next", "dist", "bin", "next");
  background("web", process.execPath, [nextBin, "start", "-H", "0.0.0.0", "-p", String(PORT)], WEB);
  await waitForOk(`http://localhost:${PORT}/`);
  await waitForOk(`http://${lan}:${PORT}/`);

  process.stdout.write(
    [
      "",
      "Ready. On your phone (same Wi-Fi as this laptop):",
      `  Feed:          http://${lan}:${PORT}/?debug=1`,
      `  Bench:         http://${lan}:${PORT}/bench?preload=1  and  ?preload=0`,
      `  Laptop:        http://localhost:${PORT}/`,
      "Ctrl+C stops the worker and web app (Docker keeps running; `pnpm infra:down` stops it).",
      "",
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  stop(1);
}
