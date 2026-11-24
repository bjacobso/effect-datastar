/**
 * Automated monorepo package boundary enforcement.
 *
 * Scans every `.ts`/`.tsx` file under `packages/*\/src/` and `packages/*\/test/` and verifies:
 * 1. No file in `packages/` imports from `apps/` (via relative path or workspace package name).
 * 2. No file in `packages/<pkg>/src/` escapes its own package via relative imports.
 * 3. Any `@effect-datastar/<other>` import in `packages/<pkg>/src/` is declared in
 *    `packages/<pkg>/package.json`'s `dependencies` (or `devDependencies` for `test/`).
 * 4. The workspace package dependency graph has no cycles.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const PACKAGES_DIR = path.join(REPO_ROOT, "packages")
const APPS_DIR = path.join(REPO_ROOT, "apps")
const WORKSPACE_SCOPE = "@effect-datastar/"

interface PackageJson {
  readonly name: string
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

interface WorkspacePackage {
  readonly dirName: string
  readonly dir: string
  readonly name: string
  readonly dependencies: ReadonlySet<string>
  readonly devDependencies: ReadonlySet<string>
}

const readPackageJson = (dir: string): PackageJson =>
  JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson

const listWorkspacePackages = (parentDir: string): ReadonlyArray<WorkspacePackage> => {
  if (!existsSync(parentDir)) return []
  return readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(parentDir, entry.name, "package.json")))
    .map((entry) => {
      const dir = path.join(parentDir, entry.name)
      const pkg = readPackageJson(dir)
      return {
        dirName: entry.name,
        dir,
        name: pkg.name,
        dependencies: new Set(Object.keys(pkg.dependencies ?? {})),
        devDependencies: new Set(Object.keys(pkg.devDependencies ?? {}))
      }
    })
}

const collectSourceFiles = (dir: string): ReadonlyArray<string> => {
  if (!existsSync(dir)) return []
  const files: Array<string> = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue
        walk(fullPath)
      } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(fullPath)
      }
    }
  }
  walk(dir)
  return files
}

/**
 * Strips block comments (`/* ... *\/`) and line comments (`// ...`, preserving URLs like `https://`)
 * so commented-out imports are ignored while keeping line structure intact.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1")

/** Extracts module specifiers from static imports/exports, side-effect imports, dynamic `import()`, and `require()`. */
const extractImportSpecifiers = (source: string): ReadonlyArray<string> => {
  const cleaned = stripComments(source)
  const specifiers: Array<string> = []

  // Static `import ... from "spec"` and `export ... from "spec"` (including multi-line and `type`).
  const fromRe =
    /(?:^|[;\n])\s*(?:import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\*\s+as\s+[\w$]+|\{[^}]*\}))?)\s+from\s+["']([^"']+)["']/g
  for (const match of cleaned.matchAll(fromRe)) {
    const spec = match[1]
    if (spec) specifiers.push(spec)
  }

  // Side-effect `import "spec"`.
  const sideEffectRe = /(?:^|[;\n])\s*import\s+["']([^"']+)["']/g
  for (const match of cleaned.matchAll(sideEffectRe)) {
    const spec = match[1]
    if (spec) specifiers.push(spec)
  }

  // Dynamic `import("spec")` and `require("spec")`.
  const callRe = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g
  for (const match of cleaned.matchAll(callRe)) {
    const spec = match[1]
    if (spec) specifiers.push(spec)
  }

  return specifiers
}

/** Extracts the package name from a bare specifier (e.g. `@effect-datastar/ui/Html.ts` -> `@effect-datastar/ui`). */
const packageNameFromSpecifier = (specifier: string): string => {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/")
    return name ? `${scope}/${name}` : specifier
  }
  return specifier.split("/")[0] ?? specifier
}

const isInsideDir = (targetPath: string, containerDir: string): boolean => {
  const rel = path.relative(containerDir, targetPath)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

const findDependencyCycles = (
  packages: ReadonlyArray<WorkspacePackage>
): ReadonlyArray<ReadonlyArray<string>> => {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const state = new Map<string, "visiting" | "visited">()
  const stack: Array<string> = []
  const cycles: Array<ReadonlyArray<string>> = []

  const visit = (name: string) => {
    state.set(name, "visiting")
    stack.push(name)
    const pkg = byName.get(name)
    if (pkg) {
      for (const dep of pkg.dependencies) {
        if (!byName.has(dep)) continue
        const depState = state.get(dep)
        if (depState === "visiting") {
          const cycleStart = stack.indexOf(dep)
          cycles.push([...stack.slice(cycleStart), dep])
        } else if (!depState) {
          visit(dep)
        }
      }
    }
    stack.pop()
    state.set(name, "visited")
  }

  for (const pkg of packages) {
    if (!state.has(pkg.name)) visit(pkg.name)
  }
  return cycles
}

describe("monorepo package boundaries", () => {
  const packages = listWorkspacePackages(PACKAGES_DIR)
  const apps = listWorkspacePackages(APPS_DIR)
  const appPackageNames = new Set(apps.map((app) => app.name))

  it("discovers workspace packages and apps", () => {
    expect(packages.length).toBeGreaterThan(0)
    expect(apps.length).toBeGreaterThan(0)
  })

  it("no file in packages/ imports from apps/", () => {
    const violations: Array<string> = []

    for (const pkg of packages) {
      const files = [
        ...collectSourceFiles(path.join(pkg.dir, "src")),
        ...collectSourceFiles(path.join(pkg.dir, "test"))
      ]
      for (const file of files) {
        const relFile = path.relative(REPO_ROOT, file)
        const specifiers = extractImportSpecifiers(readFileSync(file, "utf8"))
        for (const spec of specifiers) {
          if (spec.startsWith(".")) {
            const resolved = path.resolve(path.dirname(file), spec)
            if (isInsideDir(resolved, APPS_DIR)) {
              violations.push(`${relFile} imports from apps/ via "${spec}"`)
            }
          } else {
            const importedPkg = packageNameFromSpecifier(spec)
            if (appPackageNames.has(importedPkg) || spec.startsWith("apps/")) {
              violations.push(`${relFile} imports app package "${spec}"`)
            }
          }
        }
      }
    }

    expect(violations).toEqual([])
  })

  it("no file in packages/<pkg>/src/ escapes its own package via relative imports", () => {
    const violations: Array<string> = []

    for (const pkg of packages) {
      const files = collectSourceFiles(path.join(pkg.dir, "src"))
      for (const file of files) {
        const relFile = path.relative(REPO_ROOT, file)
        const specifiers = extractImportSpecifiers(readFileSync(file, "utf8"))
        for (const spec of specifiers) {
          if (!spec.startsWith(".")) continue
          const resolved = path.resolve(path.dirname(file), spec)
          if (!isInsideDir(resolved, pkg.dir)) {
            violations.push(`${relFile} escapes ${pkg.name} via relative import "${spec}"`)
          }
        }
      }
    }

    expect(violations).toEqual([])
  })

  it("all @effect-datastar/* imports in packages/<pkg> are declared in package.json", () => {
    const violations: Array<string> = []

    for (const pkg of packages) {
      const checkDir = (subdir: "src" | "test") => {
        const files = collectSourceFiles(path.join(pkg.dir, subdir))
        for (const file of files) {
          const relFile = path.relative(REPO_ROOT, file)
          const specifiers = extractImportSpecifiers(readFileSync(file, "utf8"))
          for (const spec of specifiers) {
            if (!spec.startsWith(WORKSPACE_SCOPE)) continue
            const targetPkg = packageNameFromSpecifier(spec)
            if (targetPkg === pkg.name) continue
            const allowed =
              subdir === "src"
                ? pkg.dependencies.has(targetPkg)
                : pkg.dependencies.has(targetPkg) || pkg.devDependencies.has(targetPkg)
            if (!allowed) {
              const field = subdir === "src" ? "dependencies" : "dependencies or devDependencies"
              violations.push(
                `${relFile} imports "${spec}" (${targetPkg}), which is missing from ${pkg.name} ${field}`
              )
            }
          }
        }
      }

      checkDir("src")
      checkDir("test")
    }

    expect(violations).toEqual([])
  })

  it("workspace package dependency graph has no cycles", () => {
    const cycles = findDependencyCycles(packages)
    expect(cycles).toEqual([])
  })

  it("extractImportSpecifiers handles static, type, dynamic, and ignores commented imports", () => {
    const sample = `
      // import { bad } from "../../../apps/demo/src/main.tsx"
      /* export * from "@effect-datastar/demo" */
      import { a } from "@effect-datastar/datastar/Attrs.ts"
      import type {
        B
      } from "@effect-datastar/ui/Html.ts"
      import "./side-effect.ts"
      export { c } from "../local.ts"
      const mod = await import("@effect-datastar/reactivity/Broadcast.ts")
      const url = "https://example.com" // trailing comment
    `
    expect(new Set(extractImportSpecifiers(sample))).toEqual(
      new Set([
        "@effect-datastar/datastar/Attrs.ts",
        "@effect-datastar/ui/Html.ts",
        "./side-effect.ts",
        "../local.ts",
        "@effect-datastar/reactivity/Broadcast.ts"
      ])
    )
  })

  it("findDependencyCycles detects circular dependencies", () => {
    const cyclic: ReadonlyArray<WorkspacePackage> = [
      { dirName: "a", dir: "/a", name: "@effect-datastar/a", dependencies: new Set(["@effect-datastar/b"]), devDependencies: new Set() },
      { dirName: "b", dir: "/b", name: "@effect-datastar/b", dependencies: new Set(["@effect-datastar/a"]), devDependencies: new Set() }
    ]
    expect(findDependencyCycles(cyclic)).toEqual([
      ["@effect-datastar/a", "@effect-datastar/b", "@effect-datastar/a"]
    ])
  })
})
