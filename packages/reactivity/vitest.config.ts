import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { name: "reactivity", include: ["test/**/*.test.ts"] }
})
