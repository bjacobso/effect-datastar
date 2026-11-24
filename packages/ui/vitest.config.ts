import stylex from "@stylexjs/unplugin/vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [stylex({ devMode: "css-only" })],
  test: { name: "ui", include: ["test/**/*.test.{ts,tsx}"] }
})
