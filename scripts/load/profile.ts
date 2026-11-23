/**
 * Summarizes a `.cpuprofile` (from `run.ts --profile`, i.e. `node --cpu-prof`):
 * self time by package or source file, and inclusive time of a few markers.
 *
 *   node scripts/load/profile.ts .load/prof/CPU.*.cpuprofile
 */
import { readFileSync } from "node:fs"

interface Node {
  readonly id: number
  readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number }
  readonly children?: ReadonlyArray<number>
}
interface Profile {
  readonly nodes: ReadonlyArray<Node>
  readonly samples: ReadonlyArray<number>
  readonly timeDeltas: ReadonlyArray<number>
}

const file = process.argv[2]
if (file === undefined) throw new Error("usage: node scripts/load/profile.ts <file.cpuprofile>")
const profile = JSON.parse(readFileSync(file, "utf8")) as Profile
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const parent = new Map<number, number>()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)

const self = new Map<number, number>()
profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)))
const total = [...self.values()].reduce((a, b) => a + b, 0)

/** A bucket for a call frame: the npm package, or the source file. */
const bucket = (n: Node) => {
  const url = n.callFrame.url
  if (url === "") return n.callFrame.functionName === "" ? "(native)" : `(${n.callFrame.functionName})`
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(url)
  if (pkg) return pkg[1]!
  if (url.startsWith("node:")) return url
  return url.replace(/^.*\/(dist|src)\//, "$1/")
}

const groups = new Map<string, number>()
const fns = new Map<string, number>()
for (const [id, t] of self) {
  const n = byId.get(id)!
  groups.set(bucket(n), (groups.get(bucket(n)) ?? 0) + t)
  const fn = `${n.callFrame.functionName || "(anonymous)"} ${bucket(n)}:${n.callFrame.lineNumber}`
  fns.set(fn, (fns.get(fn) ?? 0) + t)
}

/** Inclusive time of samples under a frame whose function name matches. */
const inclusive = (pattern: RegExp) => {
  let t = 0
  for (const [id, time] of self) {
    let cur: number | undefined = id
    while (cur !== undefined) {
      if (pattern.test(byId.get(cur)!.callFrame.functionName)) {
        t += time
        break
      }
      cur = parent.get(cur)
    }
  }
  return t
}

const pct = (t: number) => `${((t / total) * 100).toFixed(1)}%`
const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n)
console.log(`total ${(total / 1e6).toFixed(1)}s sampled`)
console.log("\nself time by package / file")
for (const [k, t] of top(groups, 20)) console.log(`  ${pct(t).padStart(6)}  ${k}`)
console.log("\nself time by function")
for (const [k, t] of top(fns, 25)) console.log(`  ${pct(t).padStart(6)}  ${k}`)
console.log("\ninclusive")
for (const [name, re] of [
  ["React render (renderToStaticMarkup)", /renderToStaticMarkup|renderToString/],
  ["SQLite statements (StatementSync, timed by Metrics)", /StatementSync/],
  ["SSE encoding (encodeEvent)", /^encodeEvent$|^dataLines$/],
  ["garbage collection", /^\(garbage collector\)$/],
  ["idle", /^\(idle\)$/]
] as const) console.log(`  ${pct(inclusive(re)).padStart(6)}  ${name}`)
