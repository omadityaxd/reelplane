import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // e2e/ holds Playwright specs (pnpm e2e); they need a browser and the running app.
    exclude: ["e2e/**", "node_modules/**"],
    testTimeout: 15_000,
  },
});
