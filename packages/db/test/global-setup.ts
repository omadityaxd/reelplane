import type { TestProject } from "vitest/node";
import { createTestDatabase } from "../src/testing.ts";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  project.provide("databaseUrl", await createTestDatabase("reelplane_test_db"));
}
