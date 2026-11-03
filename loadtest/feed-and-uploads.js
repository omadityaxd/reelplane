// k6 load test: the feed and the upload-session endpoints (run via `pnpm loadtest`).
//
//   BASE_URL     app under test (default http://localhost:3000)
//   PK / ORIGIN  a publishable key and one of its project's allowed origins
//   SK           a secret key of the same project
//   FEED_RPS, UPLOAD_RPS, DURATION   load shape (defaults 100, 10, 60s)
import { check } from "k6";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const FEED_RPS = Number(__ENV.FEED_RPS || 100);
const UPLOAD_RPS = Number(__ENV.UPLOAD_RPS || 10);
const DURATION = __ENV.DURATION || "60s";

const feedMs = new Trend("feed_ms", true);
const feedCacheHit = new Rate("feed_cache_hit");
const createMs = new Trend("upload_create_ms", true);
const abortMs = new Trend("upload_abort_ms", true);
const limited = new Counter("rate_limited");

export const options = {
  discardResponseBodies: false,
  summaryTrendStats: ["med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: {
    feed: {
      executor: "constant-arrival-rate",
      rate: FEED_RPS,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
      exec: "feed",
    },
    uploads: {
      executor: "constant-arrival-rate",
      rate: UPLOAD_RPS,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 50,
      exec: "uploadSession",
    },
  },
  thresholds: {
    "http_req_failed{scenario:feed}": ["rate<0.01"],
    "http_req_failed{scenario:uploads}": ["rate<0.01"],
  },
};

// Viewers ask for different page sizes, so the 10 s per-instance feed cache sees a mix of hits
// and misses rather than one hot key.
const LIMITS = [5, 8, 10, 12, 15, 20, 25, 30];

export function feed() {
  const limit = LIMITS[Math.floor(Math.random() * LIMITS.length)];
  const res = http.get(`${BASE}/v1/feeds/latest?limit=${limit}`, {
    headers: { authorization: `Bearer ${__ENV.PK}`, origin: __ENV.ORIGIN },
    tags: { name: "GET /v1/feeds/latest" },
  });
  if (res.status === 429) limited.add(1);
  feedMs.add(res.timings.duration);
  feedCacheHit.add(res.headers["X-Cache"] === "hit");
  check(res, { "feed 200": (r) => r.status === 200 });
}

export function uploadSession() {
  const res = http.post(
    `${BASE}/v1/uploads`,
    JSON.stringify({
      contentType: "video/mp4",
      sizeBytes: 8 * 1024 * 1024 + Math.floor(Math.random() * 1e6),
    }),
    {
      headers: { authorization: `Bearer ${__ENV.SK}`, "content-type": "application/json" },
      tags: { name: "POST /v1/uploads" },
    },
  );
  if (res.status === 429) limited.add(1);
  createMs.add(res.timings.duration);
  if (!check(res, { "create 201": (r) => r.status === 201 })) return;
  // Abort right away, so the run leaves no open multipart uploads behind.
  const id = res.json("data.upload.videoId");
  const abort = http.del(`${BASE}/v1/uploads/${id}`, null, {
    headers: { authorization: `Bearer ${__ENV.SK}` },
    tags: { name: "DELETE /v1/uploads/:id" },
  });
  abortMs.add(abort.timings.duration);
  check(abort, { "abort 200": (r) => r.status === 200 });
}

export function handleSummary(data) {
  const out = __ENV.SUMMARY || "loadtest/summary.json";
  return { [out]: JSON.stringify(data, null, 2), stdout: "\n" };
}
