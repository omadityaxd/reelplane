/**
 * `pnpm services`: reports which backing service each component will use (cloud or the
 * local fallback) and whether it is reachable. Nothing here needs an account to pass.
 */
import { connectionConfig } from "@reelplane/db";
import { createStorage, loadStorageConfig } from "@reelplane/storage";
import pg from "pg";
import { LOCAL_DATABASE_URL, loadRootEnv } from "./load-env.ts";

loadRootEnv();

type Status = "ok" | "fail" | "skip";
interface CheckResult {
  service: string;
  target: string;
  status: Status;
  detail: string;
}

const TIMEOUT_MS = 5000;

function describeError(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(describeError).join("; ");
  return error instanceof Error ? error.message || error.name : String(error);
}

async function checkPostgres(): Promise<CheckResult> {
  const url = process.env.DATABASE_URL || LOCAL_DATABASE_URL;
  const target = url === LOCAL_DATABASE_URL ? "local docker postgres" : new URL(url).host;
  const client = new pg.Client({ ...connectionConfig(url), connectionTimeoutMillis: TIMEOUT_MS });
  try {
    await client.connect();
    const result = await client.query<{ version: string }>(
      "select current_setting('server_version') as version",
    );
    return {
      service: "postgres",
      target,
      status: "ok",
      detail: `server ${result.rows[0]?.version}`,
    };
  } catch (error) {
    return { service: "postgres", target, status: "fail", detail: describeError(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkStorage(): Promise<CheckResult> {
  try {
    const config = loadStorageConfig();
    const target = `${config.provider} ${config.endpoint}/${config.bucket}`;
    try {
      await createStorage(config).listObjects("__doctor__/");
      return { service: "storage", target, status: "ok", detail: "bucket reachable" };
    } catch (error) {
      return {
        service: "storage",
        target,
        status: "fail",
        detail: `${describeError(error)} (run pnpm infra:init?)`,
      };
    }
  } catch (error) {
    return { service: "storage", target: "?", status: "fail", detail: describeError(error) };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return {
      service: "redis",
      target: "not configured",
      status: "skip",
      detail: "optional: Postgres rate limiting is used",
    };
  }
  try {
    const response = await fetch(`${url}/ping`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ok = response.ok;
    return {
      service: "redis",
      target: new URL(url).host,
      status: ok ? "ok" : "fail",
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      service: "redis",
      target: new URL(url).host,
      status: "fail",
      detail: describeError(error),
    };
  }
}

async function checkSupabaseAuth(): Promise<CheckResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return {
      service: "auth",
      target: "not configured",
      status: "skip",
      detail: "local dev sign-in is used",
    };
  }
  try {
    const response = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return {
      service: "auth",
      target: new URL(url).host,
      status: response.ok ? "ok" : "fail",
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      service: "auth",
      target: new URL(url).host,
      status: "fail",
      detail: describeError(error),
    };
  }
}

const results = await Promise.all([
  checkPostgres(),
  checkStorage(),
  checkRedis(),
  checkSupabaseAuth(),
]);
const icon: Record<Status, string> = { ok: "OK  ", fail: "FAIL", skip: "SKIP" };
for (const result of results) {
  process.stdout.write(
    `${icon[result.status]}  ${result.service.padEnd(9)} ${result.target.padEnd(44)} ${result.detail}\n`,
  );
}
if (results.some((result) => result.status === "fail")) process.exitCode = 1;
