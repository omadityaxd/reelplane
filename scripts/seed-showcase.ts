/**
 * `pnpm showcase:seed`: uploads the showcase clips (content/showcase) into the demo project
 * through the real upload path (upload session → presigned part PUTs → complete), marks them as
 * showcase videos (kept by the 7-day cleanup) and waits for the worker to publish them.
 *
 * `--bench` seeds a separate project with BENCH_COPIES copies of every clip instead (distinct
 * videos, distinct URLs) for the swipe-to-play benchmark at /bench.
 *
 * Idempotent: clips already uploaded are skipped. Writes the demo's publishable key and LAN
 * settings to apps/web/.env.local so `pnpm demo` can serve the feed to a phone.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  createApiKey,
  createPool,
  createProject,
  listProjectsForUser,
  resolveDatabaseUrl,
  resolvePepper,
  setAllowedOrigins,
  withTenant,
} from "@reelplane/db";
import { createStorage } from "@reelplane/storage";
import type { AppDeps } from "../apps/web/lib/server/deps.ts";
import { DEFAULT_UPLOAD_LIMITS } from "../apps/web/lib/server/uploads/limits.ts";
import {
  completeUploadSession,
  createUploadSession,
  signUploadParts,
} from "../apps/web/lib/server/uploads/service.ts";
import { lanAddress } from "./lan.ts";
import { loadRootEnv } from "./load-env.ts";

loadRootEnv();

const ROOT = join(import.meta.dirname, "..");
const SHOWCASE = join(ROOT, "content", "showcase");
const MANIFEST = join(SHOWCASE, "licenses.json");
const WEB_ENV = join(ROOT, "apps", "web", ".env.local");
const DEV_OWNER_ID = "00000000-0000-4000-8000-000000000001";
const BENCH = process.argv.includes("--bench");
const BENCH_COPIES = 5;
const PROJECT_NAME = BENCH ? "Reelplane bench" : "Reelplane demo";
const KEY_VAR = BENCH ? "NEXT_PUBLIC_BENCH_PUBLISHABLE_KEY" : "NEXT_PUBLIC_DEMO_PUBLISHABLE_KEY";
const PORT = Number(process.env.DEMO_PORT ?? 3000);
const MAX_DURATION_S = 60;
const READY_TIMEOUT_MS = 10 * 60_000;

interface ManifestEntry {
  file: string;
  title: string;
  creator: string;
  credit: string;
  license: string;
  licenseUrl?: string;
  source?: string;
  changes?: string;
}

function readEnvFile(path: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1]) entries.set(match[1], match[2] ?? "");
  }
  return entries;
}

function writeEnvFile(path: string, entries: Map<string, string>): void {
  const lines = [
    "# Written by `pnpm showcase:seed` (gitignored).",
    ...[...entries].map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
}

/** Adds manifest entries for phone videos that are not listed yet. */
function loadManifest(): ManifestEntry[] {
  const manifest: ManifestEntry[] = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, "utf8"))
    : [];
  const phoneDir = join(SHOWCASE, "phone");
  const known = new Set(manifest.map((entry) => entry.file));
  for (const name of existsSync(phoneDir) ? readdirSync(phoneDir).sort() : []) {
    if (![".mp4", ".mov", ".m4v"].includes(extname(name).toLowerCase())) continue;
    const file = `phone/${name}`;
    if (known.has(file)) continue;
    manifest.push({
      file,
      title: name.replace(/\.[^.]+$/, ""),
      creator: "Project author",
      credit: "Recorded by the project author",
      license: "Owned by the project author",
    });
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function durationSeconds(path: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    {
      encoding: "utf8",
    },
  );
  return Number.parseFloat(out.trim());
}

async function demoProject(
  deps: AppDeps,
  origins: string[],
  env: Map<string, string>,
): Promise<string> {
  const existing = (await listProjectsForUser(deps.pool, DEV_OWNER_ID)).find(
    (p) => p.name === PROJECT_NAME,
  );
  if (!existing) {
    const created = await createProject(
      deps.pool,
      { ownerId: DEV_OWNER_ID, name: PROJECT_NAME, allowedOrigins: origins, isDemo: true },
      deps.pepper,
    );
    env.set(KEY_VAR, created.publishableKey.key);
    return created.project.id;
  }
  // These dev projects belong to the seed: replace (not extend) their origins, so a stale
  // address from an earlier run (e.g. a virtual adapter) does not linger.
  await setAllowedOrigins(deps.pool, DEV_OWNER_ID, existing.id, origins);
  if (!env.get(KEY_VAR)) {
    const key = await createApiKey(
      deps.pool,
      { projectId: existing.id, kind: "publishable", name: "Demo site" },
      deps.pepper,
    );
    env.set(KEY_VAR, key.key);
  }
  return existing.id;
}

async function alreadyUploaded(deps: AppDeps, projectId: string, file: string): Promise<boolean> {
  return withTenant(deps.pool, { projectId }, async (client) => {
    const { rowCount } = await client.query(
      `select 1 from reelplane.videos where metadata->>'file' = $1 and status in ('queued', 'processing', 'ready')`,
      [file],
    );
    return (rowCount ?? 0) > 0;
  });
}

/** The real upload path: session, presigned part PUTs straight to storage, complete. */
async function upload(
  deps: AppDeps,
  projectId: string,
  entry: ManifestEntry,
  path: string,
  fileId: string,
): Promise<string> {
  const bytes = readFileSync(path);
  const contentType = extname(path).toLowerCase() === ".mov" ? "video/quicktime" : "video/mp4";
  const session = await createUploadSession(deps, projectId, {
    contentType,
    sizeBytes: bytes.byteLength,
    durationMs: Math.round(durationSeconds(path) * 1000),
    filename: entry.file.split("/").pop(),
    title: entry.title,
    creatorId: entry.creator,
    metadata: {
      file: fileId,
      credit: entry.credit,
      license: entry.license,
      ...(entry.licenseUrl ? { licenseUrl: entry.licenseUrl } : {}),
    },
  });
  const videoId = session.upload.videoId;
  const signed = await signUploadParts(deps, projectId, videoId, undefined);
  for (const part of signed.urls) {
    const start = (part.partNumber - 1) * signed.partSize;
    const response = await fetch(part.url, {
      method: "PUT",
      body: bytes.subarray(start, start + part.size),
    });
    if (!response.ok)
      throw new Error(`part ${part.partNumber} upload failed: HTTP ${response.status}`);
  }
  await completeUploadSession(deps, projectId, videoId, {});
  await withTenant(deps.pool, { projectId }, (client) =>
    client.query("update reelplane.videos set is_showcase = true where id = $1", [videoId]),
  );
  return videoId;
}

async function uploadAll(
  deps: AppDeps,
  projectId: string,
  entries: ManifestEntry[],
): Promise<void> {
  const copies = BENCH ? BENCH_COPIES : 1;
  for (const entry of entries) {
    const path = join(SHOWCASE, entry.file);
    if (!existsSync(path)) {
      process.stdout.write(`skip ${entry.file}: file missing (run pnpm showcase:clips?)\n`);
      continue;
    }
    if (
      durationSeconds(path) > MAX_DURATION_S + 0.5 ||
      statSync(path).size > DEFAULT_UPLOAD_LIMITS.maxBytes
    ) {
      process.stdout.write(`skip ${entry.file}: over the 60 s / 100 MB demo limits\n`);
      continue;
    }
    for (let copy = 1; copy <= copies; copy += 1) {
      const fileId = BENCH ? `${entry.file}#${copy}` : entry.file;
      if (await alreadyUploaded(deps, projectId, fileId)) {
        process.stdout.write(`skip ${fileId}: already uploaded\n`);
        continue;
      }
      const videoId = await upload(deps, projectId, entry, path, fileId);
      process.stdout.write(`upload ${fileId} (${entry.license}) → ${videoId}\n`);
    }
  }
}

async function waitForWorker(deps: AppDeps, projectId: string): Promise<void> {
  const started = Date.now();
  let hinted = false;
  for (;;) {
    const counts = await withTenant(deps.pool, { projectId }, async (client) => {
      const { rows } = await client.query<{ status: string; n: number }>(
        "select status, count(*)::int as n from reelplane.videos where is_showcase group by status",
      );
      return Object.fromEntries(rows.map((row) => [row.status, row.n]));
    });
    const pending = (counts.queued ?? 0) + (counts.processing ?? 0);
    if (pending === 0) {
      process.stdout.write(`showcase: ${counts.ready ?? 0} ready, ${counts.failed ?? 0} failed\n`);
      return;
    }
    if (!hinted && Date.now() - started > 15_000 && !counts.processing) {
      process.stdout.write(
        "waiting for the worker… start it with `pnpm worker:dev` (or `pnpm worker:up`)\n",
      );
      hinted = true;
    }
    if (Date.now() - started > READY_TIMEOUT_MS)
      throw new Error("timed out waiting for the worker");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Keys only verify under the pepper they were hashed with, and `next start` (production) refuses
 * the dev default. Generate one real pepper and share it between scripts (.env) and Next
 * (apps/web/.env.local), so seeded keys work in dev and production builds alike.
 */
function ensurePepper(webEnv: Map<string, string>): void {
  const rootEnvPath = join(ROOT, ".env");
  const rootEnv = readEnvFile(rootEnvPath);
  const pepper =
    process.env.API_KEY_PEPPER ||
    rootEnv.get("API_KEY_PEPPER") ||
    randomBytes(32).toString("base64url");
  if (!rootEnv.get("API_KEY_PEPPER")) {
    rootEnv.set("API_KEY_PEPPER", pepper);
    writeEnvFile(rootEnvPath, rootEnv);
  }
  process.env.API_KEY_PEPPER = pepper;
  webEnv.set("API_KEY_PEPPER", pepper);
}

const lan = process.env.DEMO_LAN_IP ?? lanAddress();
const origins = [`http://localhost:${PORT}`, ...(lan ? [`http://${lan}:${PORT}`] : [])];
const env = readEnvFile(WEB_ENV);
ensurePepper(env);
if (lan) {
  // The phone must reach media via the laptop's LAN address, not "localhost".
  env.set("STORAGE_PUBLIC_BASE_URL", `http://${lan}:9000/reelplane`);
  env.set("NEXT_DEV_ALLOWED_HOSTS", lan);
}
const pool = createPool(resolveDatabaseUrl(), { max: 2, applicationName: "reelplane-showcase" });
const deps: AppDeps = {
  pool,
  pepper: resolvePepper(),
  storage: createStorage(),
  limits: DEFAULT_UPLOAD_LIMITS,
};

try {
  const projectId = await demoProject(deps, origins, env);
  writeEnvFile(WEB_ENV, env);
  process.stdout.write(`demo project ${projectId}; allowed origins: ${origins.join(", ")}\n`);
  // The `latest` feed shows the most recently published first. So the licensed clips are
  // published first (and fully), then the phone videos: phone videos lead the feed, the
  // Blender clips come last. (The bench project uses only the licensed clips.)
  const manifest = loadManifest();
  const licensed = manifest.filter((entry) => !entry.file.startsWith("phone/"));
  const phone = BENCH ? [] : manifest.filter((entry) => entry.file.startsWith("phone/"));
  for (const group of [licensed, phone]) {
    await uploadAll(deps, projectId, group);
    await waitForWorker(deps, projectId);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
