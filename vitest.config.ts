import { defineConfig } from "vitest/config"

/** Every package's and app's unit tests (`npm test`). Browser tests: `npm run test:e2e`. */
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"]
  }
})
