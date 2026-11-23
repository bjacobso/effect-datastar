/**
 * Global setup for the browser tests: one production build (server bundle, islands
 * bundle, CSS), which every test file then runs with `node dist/server.js`.
 */
import { build } from "../../scripts/build.ts"

export default async function setup() {
  await build()
}
