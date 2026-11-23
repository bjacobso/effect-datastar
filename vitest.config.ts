import stylex from "@stylexjs/unplugin/vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  // Compiles StyleX in the code under test: `stylex.create` throws if it runs uncompiled.
  // Only class names matter here; the CSS comes from `npm run build`.
  plugins: [stylex({ devMode: "css-only" })],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["test/e2e/**"]
  }
})
