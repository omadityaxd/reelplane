/**
 * `pnpm bench:transcode`: uploads every clip in content/showcase (licensed + phone) through the
 * real API (needs the web app on BENCH_API_URL, default http://localhost:3000) into a fresh
 * project, waits for whichever worker is running, and prints each job's transcode metrics.
 * Run ONE worker, sized like the host you want to measure, e.g. 2 vCPUs:
 *
 *   docker run --rm --cpus=2 --network reelplane_default -e ... reelplane-worker
 *
 * The videos are deleted afterwards (their files are swept by the worker).
 */
import { openAsBlob, readdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  createPool,
  createProject,
  deleteVideo,
  resolveDatabaseUrl,
  resolvePepper,
} from "@reelplane/db";
import { fetchTransport, uploadVideo } from "@reelplane/sdk-core";
import { loadRootEnv } from "./load-env.ts";

loadRootEnv();

const API = process.env.BENCH_API_URL ?? "http://localhost:3000";
const DEV_OWNER_ID = "00000000-0000-4000-8000-000000000001";
const SHOWCASE = join(import.meta.dirname, "..", "content", "showcase");
const TIMEOUT_MS = 15 * 60_000;
const OUT = process.argv[2];

interface Metrics {
  mediaDurationMs: number;
  encodeMs: number;
  totalMs: number;
  speedRealtime: number;
  renditions: number;
  source: string;
  outputFps: string;
}

const clips = ["licensed", "phone"].flatMap((dir) =>
  readdirSync(join(SHOWCASE, dir))
    .filter((name) => [".mp4", ".mov"].includes(extname(name).toLowerCase()))
    .map((name) => join(SHOWCASE, dir, name)),
);

const pool = createPool(resolveDatabaseUrl(), { max: 2, applicationName: "reelplane-bench" });
try {
  const { project, secretKey } = await createProject(
    pool,
    { ownerId: DEV_OWNER_ID, name: `Transcode bench ${new Date().toISOString()}` },
    resolvePepper(),
  );
  const ids = new Map<string, string>();
  for (const path of clips) {
    const file = await openAsBlob(path);
    const response = await fetch(`${API}/v1/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${secretKey.key}`, "content-type": "application/json" },
      body: JSON.stringify({ contentType: "video/mp4", sizeBytes: file.size, title: path }),
    });
    const { data } = (await response.json()) as {
      data: { upload: { videoId: string; token: string } };
    };
    await uploadVideo({ apiBaseUrl: API, file, session: data.upload, transport: fetchTransport });
    ids.set(data.upload.videoId, path);
  }
  process.stdout.write(`uploaded ${ids.size} clips; waiting for the worker…\n`);

  const deadline = Date.now() + TIMEOUT_MS;
  let rows: { video_id: string; state: string; metrics: Metrics | null }[] = [];
  while (Date.now() < deadline) {
    ({ rows } = await pool.query(
      "select video_id, state, metrics from reelplane.jobs where project_id = $1",
      [project.id],
    ));
    if (
      rows.length === ids.size &&
      rows.every((r) => r.state === "succeeded" || r.state === "dead")
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const results = rows.map((row) => ({
    clip: ids.get(row.video_id)?.split(/[\\/]/).at(-1),
    state: row.state,
    ...row.metrics,
  }));
  for (const r of results) {
    process.stdout.write(
      `${String(r.clip).padEnd(44)} ${r.state.padEnd(9)} ${r.source ?? ""} → ${r.outputFps ?? ""} fps  ` +
        `media ${((r.mediaDurationMs ?? 0) / 1000).toFixed(1)} s  encode ${((r.encodeMs ?? 0) / 1000).toFixed(1)} s  ` +
        `${r.speedRealtime?.toFixed(2)}× realtime\n`,
    );
  }
  const ok = results.filter((r) => r.state === "succeeded" && r.mediaDurationMs && r.encodeMs);
  const media = ok.reduce((sum, r) => sum + (r.mediaDurationMs ?? 0), 0);
  const encode = ok.reduce((sum, r) => sum + (r.encodeMs ?? 0), 0);
  process.stdout.write(
    `\n${ok.length} jobs: ${(media / 1000).toFixed(1)} s of video in ${(encode / 1000).toFixed(1)} s of encoding = ${(media / encode).toFixed(2)}× realtime overall\n`,
  );
  if (OUT)
    writeFileSync(
      OUT,
      `${JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2)}\n`,
    );

  for (const id of ids.keys()) await deleteVideo(pool, project.id, id);
} finally {
  await pool.end();
}
