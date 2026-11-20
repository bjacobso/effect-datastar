import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.{ts,tsx}"],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
