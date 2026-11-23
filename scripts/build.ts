/**
 * Builds the app with esbuild and the StyleX unplugin:
 *
 * - `dist/server.js`: the server, bundled (dependencies stay external).
 * - `public/build/islands.js`: the browser entry, a small loader for `<ds-island>`, plus
 *   `public/build/chunks/`: React and each island, split out and loaded on demand.
 * - `public/build/app.css`: the global stylesheet and fonts (`src/ui/theme/global.css`),
 *   then every StyleX rule from both bundles.
 *
 * StyleX has to be compiled (`stylex.create` throws at runtime), and the server renders
 * almost every component, so the server is bundled too: both builds run in one process
 * and the unplugin keeps one rule store per process, so the CSS written by the browser
 * build (which runs second) has the server's rules as well.
 *
 *   tsx scripts/build.ts            production build
 *   tsx scripts/build.ts --watch    rebuild on change and (re)start the server (`npm run dev`)
 */
import stylex from "@stylexjs/unplugin/esbuild"
import { type ChildProcess, spawn } from "node:child_process"
import { rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const root = fileURLToPath(new URL("..", import.meta.url))

const options = (dev: boolean) => {
  // `dev` adds readable class names. `treeshakeCompensation` keeps a bare import of each
  // `*.stylex.ts` file whose vars were inlined; without it esbuild never loads
  // tokens.stylex.ts, so its `defineVars` rules (the `--dw-*` values) never reach the CSS.
  const plugins = () => [stylex({ dev, useCSSLayers: false, treeshakeCompensation: true })]
  const common = {
    absWorkingDir: root,
    bundle: true,
    jsx: "automatic",
    sourcemap: true,
    logLevel: "warning",
    metafile: true
  } satisfies esbuild.BuildOptions
  const server: esbuild.BuildOptions = {
    ...common,
    entryPoints: { server: "src/main.tsx" },
    outdir: "dist",
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    plugins: plugins()
  }
  const client: esbuild.BuildOptions = {
    ...common,
    entryPoints: { islands: "src/islands/client.tsx", app: "src/ui/theme/global.css" },
    outdir: "public/build",
    platform: "browser",
    format: "esm",
    // `islands.js` is a small loader; each island (and React, shared) is a chunk it
    // imports on demand (`src/islands/loaders.ts`).
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    target: "es2023",
    minify: !dev,
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    loader: { ".woff": "file", ".woff2": "file" },
    assetNames: "fonts/[name]-[hash]",
    // ui-sdk marks modules "use client" for React Server Components; meaningless here.
    logOverride: { "unsupported-directive": "silent" },
    plugins: plugins()
  }
  return { server, client }
}

/** One production build of the server, the islands bundle and the CSS. */
export const build = async () => {
  rmSync(`${root}/dist`, { recursive: true, force: true })
  rmSync(`${root}/public/build`, { recursive: true, force: true })
  const { server, client } = options(false)
  // Server first: the browser build writes app.css, with every rule collected so far.
  await esbuild.build(server)
  await esbuild.build(client)
  dropServerCss()
}

/** The unplugin also writes the rules next to the server bundle; only public/build/app.css is served. */
const dropServerCss = () => rmSync(`${root}/dist/stylex.css`, { force: true })

const watch = async () => {
  const { server, client } = options(true)
  let child: ChildProcess | undefined
  const restart = async () => {
    const old = child
    if (old && old.exitCode === null) {
      // Let it release the port first.
      const exited = new Promise((resolve) => old.once("exit", resolve))
      old.kill()
      await exited
    }
    child = spawn(process.execPath, ["--enable-source-maps", "dist/server.js"], { cwd: root, stdio: "inherit" })
  }
  const clientCtx = await esbuild.context(client)
  const serverCtx = await esbuild.context({
    ...server,
    plugins: [
      ...server.plugins!,
      {
        name: "restart",
        setup: (b) =>
          b.onEnd(async (result) => {
            if (result.errors.length > 0) return
            // Regenerate app.css with the server's (possibly changed) rules, then restart.
            await clientCtx.rebuild().catch(() => {})
            dropServerCss()
            await restart()
          })
      }
    ]
  })
  await clientCtx.watch()
  await serverCtx.watch()
  process.on("SIGINT", () => {
    child?.kill()
    process.exit(0)
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--watch")) await watch()
  else await build()
}
