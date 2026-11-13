/**
 * Writes docs/openapi.json from the route registry (lib/server/openapi/spec.ts).
 * test/openapi.test.ts fails until the committed file matches: run this after changing the API.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOpenApi } from "../lib/server/openapi/spec.ts";

const target = join(import.meta.dirname, "..", "..", "..", "docs", "openapi.json");
writeFileSync(target, `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
process.stdout.write(`Wrote ${target}\n`);
