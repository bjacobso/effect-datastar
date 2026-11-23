/**
 * A markdown table of load results (`.load/results/*.json`, written by `run.ts`).
 *
 *   node scripts/load/table.ts base-1k-r5 fix1-1k-r5 ...     # by label
 *   node scripts/load/table.ts 'base-*'                       # a prefix glob
 */
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const dir = fileURLToPath(new URL("../../.load/results/", import.meta.url))
const all = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort()
const labels = process.argv.slice(2).flatMap((arg) =>
  arg.endsWith("*") ? all.filter((l) => l.startsWith(arg.slice(0, -1))) : [arg]
)

// deno-lint-ignore no-explicit-any
type Result = any
const rows = labels.map((label) => JSON.parse(readFileSync(`${dir}${label}.json`, "utf8")) as Result)
const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? String(Math.round(x * 10) / 10) : "–")
const header = [
  "run",
  "streams",
  "writes/s",
  "TTFE p50/p99 ms",
  "latency p50/p95/p99/max ms",
  "missed",
  "leaks",
  "CPU %",
  "ELD p99 ms",
  "RSS MB (open/peak)",
  "heap KB/stream",
  "SQL/write",
  "renders/write",
  "KB sent/write"
]
console.log(`| ${header.join(" | ")} |`)
console.log(`|${header.map(() => "---").join("|")}|`)
for (const r of rows) {
  const s = r.servers
  const sum = (f: (x: Result) => number) => s.reduce((a: number, x: Result) => a + f(x), 0)
  const l = r.latency.all
  console.log(`| ${[
    r.label,
    r.open.connected + (r.open.failed ? ` (${r.open.failed} failed)` : ""),
    n(r.writes.perSecond),
    `${n(r.open.ttfe.p50)} / ${n(r.open.ttfe.p99)}`,
    `${n(l.p50)} / ${n(l.p95)} / ${n(l.p99)} / ${n(l.max)}`,
    `${r.correctness.misses}/${r.correctness.expected}`,
    r.correctness.crossOrgLeaks,
    s.map((x: Result) => x.cpuPercent.writes).join(" + "),
    s.map((x: Result) => n(x.eventLoopDelay.p99)).join(" / "),
    s.map((x: Result) => `${n(x.rss.openedMB)}/${n(x.rss.peakMB)}`).join(" + "),
    s.map((x: Result) => n(x.perStreamKB?.heap)).join(" / "),
    n(sum((x) => x.perWrite.sql)),
    n(sum((x) => x.perWrite.renders)),
    n(sum((x) => x.perWrite.sseKB))
  ].join(" | ")} |`)
}
