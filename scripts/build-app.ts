/**
 * Shared esbuild + StyleX + islands build helper for workspace apps.
 *
 * Produces:
 * - `<outDir>/server.js`: the server bundle (third-party dependencies stay external;
 *   `@effect-datastar/*` workspace packages are bundled so their TS/StyleX is compiled).
 * - `<publicDir>/build/islands.js`: the browser islands loader, plus
 *   `<publicDir>/build/chunks/` for on-demand React and island chunks.
 * - `<publicDir>/build/app.css`: global CSS plus every StyleX rule collected across
 *   both the server and browser builds (both run in one process so StyleX's unplugin
 *   shares a single rule store).
 * - `<publicDir>/datastar.js`: copied from `@effect-datastar/datastar/client/datastar.js`.
 */
import stylex from "@stylexjs/unplugin/esbuild"
import { type ChildProcess, spawn } from "node:child_process"
import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

export interface AppBuildOptions {
  /** Absolute path to the app directory (e.g. `fileURLToPath(new URL("..", import.meta.url))`). */
  readonly root: string
  /** Server entry point relative to `root` (e.g. `"src/main.tsx"`). */
  readonly serverEntry: string
  /** Server output directory relative to `root`. Defaults to `"dist"`. */
  readonly outDir?: string
  /** Public static assets directory relative to `root`. Defaults to `"public"`. */
  readonly publicDir?: string
  /** Browser islands entry point. Defaults to `@effect-datastar/ui/islands/client.tsx`. */
  readonly clientEntry?: string
  /** Global CSS entry point. Defaults to `@effect-datastar/ui/theme/global.css`. */
  readonly cssEntry?: string
}

export interface AppBuild {
  /** One production build of the server, the islands bundle, the CSS, and `datastar.js`. */
  readonly build: () => Promise<void>
  /** Watch mode: rebuild on change and (re)start the server (`npm run dev`). */
  readonly watch: () => Promise<void>
  /** Run `build()` or `watch()` (with `--watch`) when the calling script is executed directly. */
  readonly runFromCli: (scriptUrl: string, argv?: ReadonlyArray<string>) => Promise<void>
}

/** Leaves third-party packages external, but bundles workspace packages (TypeScript sources, StyleX to compile). */
const externalDependencies: esbuild.Plugin = {
  name: "external-dependencies",
  setup: (b) =>
    b.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith("@effect-datastar/") ? undefined : { path: args.path, external: true })
}

export const createAppBuild = (config: AppBuildOptions): AppBuild => {
  const root = path.resolve(config.root)
  const outDir = config.outDir ?? "dist"
  const publicDir = config.publicDir ?? "public"
  const resolveFromApp = createRequire(path.join(root, "package.json")).resolve

  const clientEntry = config.clientEntry ?? resolveFromApp("@effect-datastar/ui/islands/client.tsx")
  const cssEntry = config.cssEntry ?? resolveFromApp("@effect-datastar/ui/theme/global.css")
  const datastarClient = resolveFromApp("@effect-datastar/datastar/client/datastar.js")

  const absOutDir = path.join(root, outDir)
  const absPublicDir = path.join(root, publicDir)
  const absPublicBuildDir = path.join(absPublicDir, "build")

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
      entryPoints: { server: config.serverEntry },
      outdir: outDir,
      platform: "node",
      format: "esm",
      target: "node24",
      plugins: [externalDependencies, ...plugins()]
    }

    const client: esbuild.BuildOptions = {
      ...common,
      entryPoints: {
        islands: clientEntry,
        app: cssEntry
      },
      outdir: path.join(publicDir, "build"),
      platform: "browser",
      format: "esm",
      // `islands.js` is a small loader; each island (and React, shared) is a chunk it
      // imports on demand (`packages/ui/src/islands/loaders.ts`).
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

  /** The unplugin also writes the rules next to the server bundle; only `<publicDir>/build/app.css` is served. */
  const dropServerCss = () => rmSync(path.join(absOutDir, "stylex.css"), { force: true })

  /** The Datastar client, served as `/datastar.js`. */
  const copyDatastar = () => {
    mkdirSync(absPublicDir, { recursive: true })
    copyFileSync(datastarClient, path.join(absPublicDir, "datastar.js"))
  }

  const build = async () => {
    rmSync(absOutDir, { recursive: true, force: true })
    rmSync(absPublicBuildDir, { recursive: true, force: true })
    const { server, client } = options(false)
    // Server first: the browser build writes app.css, with every rule collected so far.
    await esbuild.build(server)
    await esbuild.build(client)
    dropServerCss()
    copyDatastar()
  }

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
      child = spawn(process.execPath, ["--enable-source-maps", path.join(outDir, "server.js")], {
        cwd: root,
        stdio: "inherit"
      })
    }
    copyDatastar()
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

  const runFromCli = async (scriptUrl: string, argv: ReadonlyArray<string> = process.argv) => {
    const entry = argv[1]
    if (!entry || path.resolve(entry) !== fileURLToPath(scriptUrl)) return
    if (argv.includes("--watch")) await watch()
    else await build()
  }

  return { build, watch, runFromCli }
}
