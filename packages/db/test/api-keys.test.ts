import { describe, expect, it } from "vitest";
import {
  authenticateApiKey,
  createApiKey,
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  withTenant,
} from "../src/index.ts";
import { newProject, TEST_PEPPER, useTestPool } from "./helpers.ts";

const pool = useTestPool();

describe("API keys", () => {
  it("creates a project with one publishable and one secret key that authenticate", async () => {
    const { project, publishableKey, secretKey } = await newProject(pool, {
      allowedOrigins: ["https://app.example.com/some/path"],
    });

    const secret = await authenticateApiKey(pool, secretKey.key, TEST_PEPPER);
    const publishable = await authenticateApiKey(pool, publishableKey.key, TEST_PEPPER);

    expect(secret).toMatchObject({ projectId: project.id, kind: "secret" });
    expect(publishable).toMatchObject({
      projectId: project.id,
      kind: "publishable",
      allowedOrigins: ["https://app.example.com"],
    });
  });

  it("stores only a hash and a short prefix, never the key", async () => {
    const { project, secretKey } = await newProject(pool);
    const stored = await withTenant(pool, { projectId: project.id }, async (client) => {
      const { rows } = await client.query<{ prefix: string; key_hash: Buffer }>(
        "select prefix, key_hash from reelplane.api_keys where id = $1",
        [secretKey.record.id],
      );
      return rows[0];
    });
    expect(stored?.prefix).toBe(secretKey.key.slice(0, 12));
    expect(stored?.key_hash.toString("utf8")).not.toContain(secretKey.key);
    expect(stored?.key_hash.byteLength).toBe(32);
  });

  it("rejects unknown, malformed and wrong-pepper keys", async () => {
    const { secretKey } = await newProject(pool);
    expect(await authenticateApiKey(pool, generateApiKey("secret"), TEST_PEPPER)).toBeNull();
    expect(await authenticateApiKey(pool, "rp_sk_nope", TEST_PEPPER)).toBeNull();
    expect(await authenticateApiKey(pool, secretKey.key, "x".repeat(40))).toBeNull();
  });

  it("revokes a key immediately", async () => {
    const { project, secretKey } = await newProject(pool);
    expect(await revokeApiKey(pool, project.id, secretKey.record.id)).toBe(true);
    expect(await authenticateApiKey(pool, secretKey.key, TEST_PEPPER)).toBeNull();
    expect(await revokeApiKey(pool, project.id, secretKey.record.id)).toBe(false);
  });

  it("rotates with a grace period: both keys work until the old one expires", async () => {
    const { project, secretKey } = await newProject(pool);
    const rotated = await rotateApiKey(pool, project.id, secretKey.record.id, TEST_PEPPER, 3600);

    expect(rotated?.record.kind).toBe("secret");
    expect(await authenticateApiKey(pool, secretKey.key, TEST_PEPPER)).not.toBeNull();
    expect(await authenticateApiKey(pool, rotated?.key ?? "", TEST_PEPPER)).not.toBeNull();
  });

  it("rotates with no grace period: the old key stops working at once", async () => {
    const { project, secretKey } = await newProject(pool);
    const rotated = await rotateApiKey(pool, project.id, secretKey.record.id, TEST_PEPPER, 0);

    expect(await authenticateApiKey(pool, secretKey.key, TEST_PEPPER)).toBeNull();
    expect(await authenticateApiKey(pool, rotated?.key ?? "", TEST_PEPPER)).not.toBeNull();
    // An already-expired key cannot be rotated again.
    expect(await rotateApiKey(pool, project.id, secretKey.record.id, TEST_PEPPER)).toBeNull();
  });

  it("records last use", async () => {
    const { project, secretKey } = await newProject(pool);
    await authenticateApiKey(pool, secretKey.key, TEST_PEPPER);
    const keys = await listApiKeys(pool, project.id);
    expect(keys.find((key) => key.id === secretKey.record.id)?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("cannot manage another project's keys", async () => {
    const a = await newProject(pool);
    const b = await newProject(pool);

    expect(await revokeApiKey(pool, a.project.id, b.secretKey.record.id)).toBe(false);
    expect(await rotateApiKey(pool, a.project.id, b.secretKey.record.id, TEST_PEPPER)).toBeNull();
    expect((await listApiKeys(pool, a.project.id)).map((key) => key.projectId)).toEqual([
      a.project.id,
      a.project.id,
    ]);
    // Minting a key for project B while scoped to project A is refused by RLS.
    await expect(
      withTenant(pool, { projectId: a.project.id }, (client) =>
        client.query(
          "insert into reelplane.api_keys (project_id, kind, prefix, key_hash) values ($1, 'secret', 'x', $2)",
          [b.project.id, Buffer.alloc(32, 7)],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await authenticateApiKey(pool, b.secretKey.key, TEST_PEPPER)).not.toBeNull();
  });

  it("creates additional named keys", async () => {
    const { project } = await newProject(pool);
    const extra = await createApiKey(
      pool,
      { projectId: project.id, kind: "publishable", name: "iOS app" },
      TEST_PEPPER,
    );
    expect(extra.record).toMatchObject({
      projectId: project.id,
      kind: "publishable",
      name: "iOS app",
    });
    expect(await listApiKeys(pool, project.id)).toHaveLength(3);
  });
});
