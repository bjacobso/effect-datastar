import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { name: "datastar", include: ["test/**/*.test.ts"] }
})
