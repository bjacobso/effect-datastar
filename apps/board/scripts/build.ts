import { fileURLToPath } from "node:url"
import { createAppBuild } from "../../../scripts/build-app.ts"

const app = createAppBuild({
  root: fileURLToPath(new URL("..", import.meta.url)),
  serverEntry: "src/main.tsx"
})

export const { build, watch } = app

await app.runFromCli(import.meta.url)
