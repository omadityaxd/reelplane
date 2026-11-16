import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectionConfig, LOCAL_DATABASE_URL } from "./pool.ts";
import { SUPABASE_ROOT_CA } from "./supabase-ca.ts";

const POOLER = "postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres";

describe("connectionConfig", () => {
  it("connects to a local database as given", () => {
    expect(connectionConfig(LOCAL_DATABASE_URL)).toEqual({ connectionString: LOCAL_DATABASE_URL });
    const loopback = "postgres://u:p@127.0.0.1:5432/db";
    expect(connectionConfig(loopback)).toEqual({ connectionString: loopback });
  });

  it("verifies a Supabase host against Supabase's root CA", () => {
    for (const url of [POOLER, "postgresql://postgres:pw@db.ref.supabase.co:5432/postgres"]) {
      expect(connectionConfig(url).ssl).toEqual({ ca: SUPABASE_ROOT_CA });
    }
  });

  it("verifies any other remote host against the system's CAs", () => {
    expect(connectionConfig("postgres://u:p@db.example.com/app").ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("drops sslmode and friends from the URL, which would override the verified TLS", () => {
    const config = connectionConfig(
      `${POOLER}?sslmode=require&sslrootcert=x.crt&uselibpqcompat=true`,
    );
    expect(config.connectionString).toBe(POOLER);
    expect(config.ssl).toEqual({ ca: SUPABASE_ROOT_CA });
  });

  it("keeps an explicit sslmode=disable (e.g. a container reached by its service name)", () => {
    const url = "postgres://u:p@postgres:5432/app?sslmode=disable";
    expect(connectionConfig(url)).toEqual({ connectionString: url });
  });

  it("matches the CA the worker embeds", () => {
    const worker = readFileSync(
      new URL("../../../services/worker/internal/queue/supabase-ca.pem", import.meta.url),
      "utf8",
    );
    expect(worker).toBe(SUPABASE_ROOT_CA);
    expect(SUPABASE_ROOT_CA).toMatch(
      /^-----BEGIN CERTIFICATE-----\n[\s\S]+-----END CERTIFICATE-----\n$/,
    );
  });
});
