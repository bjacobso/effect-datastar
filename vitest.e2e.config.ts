import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.{ts,tsx}"],
    // Builds once; the tests spawn the built server (`node dist/server.js`).
    globalSetup: ["test/e2e/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
