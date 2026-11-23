/**
 * Process metrics for load tests (`scripts/load/`): open SSE streams, bytes
 * and events sent, SQL statements and the time spent in them, React renders
 * and their time, plus memory, CPU and event-loop delay.
 *
 * The counters are plain numbers, always updated (an increment is cheaper
 * than checking a flag). The parts that cost something, timing every SQL
 * statement and render and sampling the event loop, are switched on by
 * `install()`, which `App.tsx` calls only with `METRICS=1`, when it adds
 * the `GET /_metrics` route. Never enable it in production:
 * the endpoint is unauthenticated.
 */
import { monitorEventLoopDelay } from "node:perf_hooks"
import { StatementSync } from "node:sqlite"

export const counters = {
  /** SSE responses currently open (live views; one-shot actions open and close at once). */
  streamsOpen: 0,
  streamsOpened: 0,
  /** Bytes and Datastar events written to SSE responses. */
  sseBytes: 0,
  sseEvents: 0,
  /** SQL statements run, and milliseconds spent running them (timed with `install`). */
  sqlStatements: 0,
  sqlMs: 0,
  /** `Html.render` calls (patches; whole pages are `document`) and their milliseconds. */
  renders: 0,
  renderMs: 0,
  /** Live list work: page re-queries and row re-fetches. */
  requeries: 0,
  refetches: 0
}

/** Whether `install` ran: the timers are on. */
export let installed = false
let eld: ReturnType<typeof monitorEventLoopDelay> | undefined

/** Times every `node:sqlite` statement and samples the event loop. Idempotent. */
export const install = () => {
  if (installed) return
  installed = true
  eld = monitorEventLoopDelay({ resolution: 10 })
  eld.enable()
  type Exec = (this: StatementSync, ...params: Array<never>) => unknown
  for (const method of ["all", "run", "get", "iterate"] as const) {
    const original = StatementSync.prototype[method] as Exec
    ;(StatementSync.prototype as unknown as Record<string, Exec>)[method] = function(this: StatementSync, ...params) {
      const start = performance.now()
      try {
        return original.apply(this, params)
      } finally {
        counters.sqlStatements++
        counters.sqlMs += performance.now() - start
      }
    }
  }
}

/** Runs `f`, counted in `renders` (and timed into `renderMs` once installed). */
export const timeRender = <A>(f: () => A): A => {
  counters.renders++
  if (!installed) return f()
  const start = performance.now()
  try {
    return f()
  } finally {
    counters.renderMs += performance.now() - start
  }
}

const ms = (ns: number) => Math.round(ns / 1e4) / 100

/**
 * A snapshot: cumulative counters, memory, cumulative CPU (µs), and the
 * event-loop delay since the previous snapshot (the histogram is reset).
 */
export const snapshot = () => {
  const memory = process.memoryUsage()
  const cpu = process.cpuUsage()
  const delay = eld === undefined
    ? undefined
    : { p50: ms(eld.percentile(50)), p99: ms(eld.percentile(99)), max: ms(eld.max), mean: ms(eld.mean) }
  eld?.reset()
  return {
    time: Date.now(),
    pid: process.pid,
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers
    },
    cpu: { user: cpu.user, system: cpu.system },
    eventLoopDelay: delay,
    counters: { ...counters }
  }
}
