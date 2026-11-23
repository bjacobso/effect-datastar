/**
 * Load test for live views: many simulated tabs, each holding a live view
 * (`GET /users/view`, `/users/:id/view`, ...), while writers mutate rows
 * through the real HTTP endpoints. See `docs/load.md`.
 *
 *   npm run build
 *   node scripts/load/run.ts --streams 1000 --rate 5 --duration 30
 *   node scripts/load/run.ts --scenario burst --streams 1000 --burst 500
 *   node scripts/load/run.ts --scenario slow --streams 1000 --slow 0.2 --duration 60
 *   node scripts/load/run.ts --scenario storm --streams 5000
 *   node scripts/load/run.ts --servers 2 --streams 2000 --rate 50
 *
 * What it does (an Effect program; the SSE clients live in worker threads,
 * `clients.ts`, so the client side isn't the bottleneck):
 *
 * 1. A database: `.load/template.db` is seeded once with `SEED=load` (10
 *    organizations x 5000 users, 50 sign-ins each), then copied for every run.
 * 2. One or two servers (`node dist/server.js`, `METRICS=1`) on that copy.
 * 3. Sign in as many accounts as needed (each reused by several tabs).
 * 4. Open the tabs: a mix of default lists, other pages, sorts, filters,
 *    page sizes, detail pages, teams and tags lists, spread across the
 *    organizations; identical queries recur (every organization's default list).
 * 5. Writers: single updates (email or name), inserts, deletes, bulk updates and
 *    team renames, across organizations, at `--rate` per second (or a burst). Every
 *    written value carries a tag `ld<seq>o<org>x`, and after each response the
 *    coordinator tells the workers what was written, so each tab can check that it
 *    saw what it should (and nothing of other organizations).
 * 6. Server metrics (`GET /_metrics`) are sampled every second.
 *
 * The result is printed and written to `.load/results/<label>.json`.
 *
 * Runs on Node's type stripping (no build step): erasable TypeScript only.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Duration, Effect, Fiber, Schedule, Semaphore } from "effect"
import { type ChildProcess, spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { cpus, totalmem } from "node:os"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { Worker } from "node:worker_threads"
import type { ClientSpec, Descriptor, ToWorker, WorkerReport } from "./protocol.ts"

const root = fileURLToPath(new URL("../..", import.meta.url))
const dir = `${root}.load`
const now = () => performance.timeOrigin + performance.now()

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    scenario: { type: "string", default: "steady" },
    streams: { type: "string", default: "100" },
    rate: { type: "string", default: "5" },
    duration: { type: "string", default: "20" },
    burst: { type: "string", default: "500" },
    "burst-concurrency": { type: "string", default: "50" },
    slow: { type: "string", default: "0" },
    servers: { type: "string", default: "1" },
    workers: { type: "string", default: String(Math.max(2, Math.min(6, cpus().length - 4))) },
    port: { type: "string", default: "4300" },
    orgs: { type: "string", default: "10" },
    "open-concurrency": { type: "string", default: "100" },
    "poll-interval": { type: "string", default: "100 millis" },
    grace: { type: "string", default: "5" },
    label: { type: "string" },
    profile: { type: "boolean", default: false },
    /** The server bundle to run (a copy of `dist/` lets you compare builds). */
    server: { type: "string", default: "dist/server.js" },
    "keep-db": { type: "boolean", default: false }
  }
})
const scenario = args.scenario as "steady" | "burst" | "slow" | "storm"
const streams = Number(args.streams)
const rate = Number(args.rate)
const duration = Number(args.duration)
const burst = Number(args.burst)
const burstConcurrency = Number(args["burst-concurrency"])
const slowFraction = Number(args.slow)
const serverCount = Number(args.servers)
const workerCount = Number(args.workers)
const basePort = Number(args.port)
const orgCount = Number(args.orgs)
const openConcurrency = Number(args["open-concurrency"])
const grace = Number(args.grace)
const label = args.label ?? `${scenario}-${streams}s-${scenario === "burst" ? `b${burst}` : `r${rate}`}-${serverCount}p`
const ACCOUNTS_PER_ORG = 50
const PASSWORD = "load-password"

if (1234 >= basePort && 1234 < basePort + serverCount) throw new Error("port 1234 is reserved")

// A deterministic PRNG, so runs are comparable.
let seed = 42
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}
const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(random() * xs.length)]!

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${message}`)

const waitFor = (url: string, timeoutMs = 60_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url)
        if (response.ok) return
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`${url} did not come up`)
  })

/** `node dist/server.js` on `port`, killed (by PID) when the scope closes. */
const server = (port: number, db: string, extra: Record<string, string> = {}) =>
  Effect.acquireRelease(
    Effect.gen(function*() {
      mkdirSync(`${dir}/logs`, { recursive: true })
      const flags = ["--expose-gc", ...(args.profile ? ["--cpu-prof", `--cpu-prof-dir=${dir}/prof`] : [])]
      const child = spawn(process.execPath, [...flags, args.server!], {
        cwd: root,
        env: {
          // React's production build, as `npm run serve` (override with NODE_ENV=development).
          NODE_ENV: "production",
          ...process.env,
          PORT: String(port),
          DB: db,
          METRICS: "1",
          INVALIDATION_POLL_INTERVAL: args["poll-interval"]!,
          ...extra
        },
        stdio: ["ignore", "ignore", "pipe"]
      })
      child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server ${port}] ${d}`))
      yield* waitFor(`http://127.0.0.1:${port}/_metrics`)
      log(`server ${port} up (pid ${child.pid})`)
      return child
    }),
    (child: ChildProcess) =>
      Effect.promise(() =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve()
          const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
          child.once("exit", () => {
            clearTimeout(timer)
            resolve()
          })
          // SIGINT: a clean shutdown, so `--cpu-prof` writes its profile.
          child.kill("SIGINT")
        })
      )
  )

/** The seeded template, created on first use. */
const template = Effect.gen(function*() {
  const path = `${dir}/template.db`
  if (existsSync(path)) return path
  log("seeding .load/template.db (SEED=load)")
  yield* Effect.scoped(server(basePort, path, { SEED: "load" }))
  return path
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const signIn = (port: number, email: string) =>
  Effect.promise(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/login`, {
      method: "POST",
      headers: { "datastar-request": "true", "content-type": "application/json" },
      body: JSON.stringify({ login: { email, password: PASSWORD, next: "/users", error: "" } })
    })
    await response.text()
    const match = /(?:^|,\s*)session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")
    if (!match) throw new Error(`sign-in as ${email} failed (${response.status})`)
    return match[1]!
  })

const api = <A>(port: number, cookie: string, method: string, path: string, body?: unknown) =>
  Effect.promise(async () => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        cookie: `session=${cookie}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(path.startsWith("/api") ? {} : { "datastar-request": "true" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await response.text()
    if (response.status >= 400) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`)
    return { status: response.status, json: (text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text) as A }
  })

const metrics = (port: number, gc = false) =>
  Effect.promise(async () => (await fetch(`http://127.0.0.1:${port}/_metrics${gc ? "?gc=1" : ""}`)).json() as Promise<Snapshot>)

interface Snapshot {
  readonly time: number
  readonly memory: { readonly rss: number; readonly heapUsed: number; readonly heapTotal: number; readonly external: number }
  readonly cpu: { readonly user: number; readonly system: number }
  readonly eventLoopDelay?: { readonly p50: number; readonly p99: number; readonly max: number; readonly mean: number }
  readonly counters: Record<string, number>
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

interface ClientWorker {
  readonly send: (message: ToWorker) => void
  readonly request: <A = unknown>(message: ToWorker, reply: string) => Effect.Effect<A>
}

const worker = Effect.acquireRelease(
  Effect.sync((): ClientWorker & { readonly raw: Worker } => {
    const raw = new Worker(new URL("./clients.ts", import.meta.url), { workerData: { host: "127.0.0.1" } })
    raw.on("error", (e) => console.error("worker error", e))
    return {
      raw,
      send: (message) => raw.postMessage(message),
      request: <A,>(message: ToWorker, reply: string) =>
        Effect.promise(() =>
          new Promise<A>((resolve) => {
            const onMessage = (m: { type: string } & Record<string, unknown>) => {
              if (m.type !== reply) return
              raw.off("message", onMessage)
              resolve(m as A)
            }
            raw.on("message", onMessage)
            raw.postMessage(message)
          })
        )
    }
  }),
  (w) => Effect.promise(() => w.raw.terminate())
)

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const percentiles = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return { n: 0, p50: NaN, p95: NaN, p99: NaN, max: NaN }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
  const round = (x: number) => Math.round(x * 10) / 10
  return { n: sorted.length, p50: round(at(50)), p95: round(at(95)), p99: round(at(99)), max: round(sorted.at(-1)!) }
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 102.4) / 10

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Org {
  readonly index: number
  readonly id: number
  readonly cookies: Array<string>
  /** Newest users first (the default list's order); updates and detail pages pick from these. */
  readonly hot: Array<Record<string, unknown>>
  /** Rows the writers inserted and haven't deleted, oldest first. */
  readonly inserted: Array<Record<string, unknown>>
  readonly teams: Array<{ id: number; name: string }>
  readonly tags: Array<number>
}

const program = Effect.gen(function*() {
  mkdirSync(`${dir}/results`, { recursive: true })
  const source = yield* template
  const db = `${dir}/run-${label}.db`
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${db}${suffix}`, { force: true })
  copyFileSync(source, db)

  const ports = Array.from({ length: serverCount }, (_, i) => basePort + 1 + i)
  yield* Effect.forEach(ports, (port) => server(port, db), { concurrency: "unbounded", discard: true })

  // --- accounts and organizations -----------------------------------------

  const perOrg = Math.min(ACCOUNTS_PER_ORG, Math.max(1, Math.ceil(streams / orgCount / 4)))
  log(`signing in ${perOrg * orgCount} accounts`)
  const orgs: Array<Org> = yield* Effect.forEach(Array.from({ length: orgCount }, (_, i) => i), (index) =>
    Effect.gen(function*() {
      // Sessions are per database, so one cookie works on every server.
      const cookies = yield* Effect.forEach(
        Array.from({ length: perOrg }, (_, k) => `load${index + 1}-${k}@load.test`),
        (email) => signIn(ports[0]!, email),
        { concurrency: 4 }
      )
      const users = yield* api<{ rows: Array<Record<string, unknown>> }>(ports[0]!, cookies[0]!, "GET", "/api/users?sort=createdAt&dir=desc&pageSize=50")
      const teams = yield* api<{ rows: Array<{ id: number; name: string }> }>(ports[0]!, cookies[0]!, "GET", "/api/teams?pageSize=50")
      const tags = yield* api<{ rows: Array<{ id: number }> }>(ports[0]!, cookies[0]!, "GET", "/api/tags?pageSize=50")
      return {
        index,
        id: users.json.rows[0]!["orgId"] as number,
        cookies,
        hot: users.json.rows,
        inserted: [],
        teams: teams.json.rows,
        tags: tags.json.rows.map((t) => t.id)
      }
    }), { concurrency: 4 })

  // --- the tabs ---------------------------------------------------------------

  const usersFilters = { name: "", email: "", role: "", teamId: "", active: "", tags: "", createdAtFrom: "", createdAtTo: "" }
  const listPath = (resource: string, query: Record<string, unknown>) =>
    `/${resource}/view?datastar=${encodeURIComponent(JSON.stringify({ [resource]: { query } }))}`
  type View = Omit<ClientSpec, "index" | "org" | "server" | "port" | "cookie" | "slow">
  const usersList = (q: { page?: number; pageSize?: number; sort?: string; dir?: string; filters?: Record<string, string> }): View => {
    const query = {
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 10,
      sort: q.sort ?? "createdAt",
      dir: q.dir ?? "desc",
      filters: { ...usersFilters, ...q.filters }
    }
    const active = Object.entries(query.filters).filter(([, v]) => v !== "").map(([k]) => k.replace(/From$|To$/, ""))
    const landsOnPage = query.sort === "createdAt" && query.dir === "desc" && query.page === 1 &&
      Object.entries(query.filters).every(([k, v]) => v === "" || (k === "role" && v === "member") || (k === "active" && v === "true"))
    return {
      kind: "list",
      resource: "users",
      ns: "users",
      path: listPath("users", query),
      query,
      queryColumns: [query.sort, ...active],
      insertLandsOnPage: landsOnPage
    }
  }
  const simpleList = (resource: "teams" | "tags"): View => ({
    kind: "list",
    resource,
    ns: resource,
    path: listPath(resource, { page: 1, pageSize: 10, sort: "name", dir: "asc", filters: { name: "" } }),
    queryColumns: ["name"]
  })
  /** The view mix: [weight, view for an organization]. */
  const mix: ReadonlyArray<readonly [number, (org: Org) => View]> = [
    [35, () => usersList({})],
    [10, () => usersList({ page: 2 + Math.floor(random() * 4) })],
    [6, () => usersList({ sort: "name", dir: "asc" })],
    [3, () => usersList({ sort: "email", dir: "asc" })],
    [2, () => usersList({ sort: "startDate", dir: "desc" })],
    [4, () => usersList({ filters: { role: "admin" } })],
    [3, () => usersList({ filters: { role: "member" } })],
    [4, () => usersList({ filters: { active: "true" } })],
    [4, (org) => usersList({ filters: { teamId: String(pick(org.teams.slice(0, 3)).id) } })],
    [2, () => usersList({ filters: { name: "ada" } })],
    [2, (org) => usersList({ filters: { tags: String(pick(org.tags.slice(0, 2))) } })],
    [5, () => usersList({ pageSize: 50 })],
    [15, (org) => {
      const id = pick(org.hot.slice(0, 20))["id"] as number
      return { kind: "detail", resource: "users", ns: "users", path: `/users/${id}/view?datastar=%7B%7D`, queryColumns: [], recordId: id }
    }],
    [3, () => simpleList("teams")],
    [2, () => simpleList("tags")]
  ]
  const totalWeight = mix.reduce((n, [w]) => n + w, 0)
  const chooseView = (org: Org) => {
    let r = random() * totalWeight
    for (const [w, make] of mix) {
      if ((r -= w) < 0) return make(org)
    }
    return mix[0]![1](org)
  }
  const specs: Array<ClientSpec> = Array.from({ length: streams }, (_, index) => {
    const org = orgs[index % orgCount]!
    const server = index % serverCount
    return {
      ...chooseView(org),
      index,
      org: org.index,
      server,
      port: ports[server]!,
      cookie: org.cookies[Math.floor(index / orgCount) % org.cookies.length]!,
      slow: slowFraction > 0 && random() < slowFraction
    }
  })
  const distinct = new Set(specs.map((s) => `${s.org}|${s.path}`)).size
  log(`${streams} tabs, ${distinct} distinct (organization, view) pairs, ${specs.filter((s) => s.slow).length} slow`)

  // --- workers ------------------------------------------------------------------

  const workers = yield* Effect.forEach(Array.from({ length: Math.min(workerCount, streams) }), () => worker)
  yield* Effect.forEach(workers, (w, i) =>
    w.request({ type: "init", specs: specs.filter((_, k) => k % workers.length === i) }, "ready"), { concurrency: "unbounded" })
  const all = <A = unknown>(message: ToWorker, reply: string) =>
    Effect.forEach(workers, (w) => w.request<A>(message, reply), { concurrency: "unbounded" })
  const broadcast = (descriptors: ReadonlyArray<Descriptor>) => {
    for (const w of workers) w.send({ type: "desc", descriptors })
  }

  // --- metrics sampling -----------------------------------------------------------

  const samples: Array<Array<Snapshot & { readonly phase: string }>> = ports.map(() => [])
  let currentPhase = "baseline"
  const sample = Effect.forEach(ports, (port, i) =>
    Effect.map(metrics(port), (s) => {
      samples[i]!.push({ ...s, phase: currentPhase })
    }), { concurrency: "unbounded", discard: true })
  // Before any tab: a GC'd baseline, so memory per stream is the difference.
  const baseline = yield* Effect.forEach(ports, (port) => metrics(port, true))
  // Idle: what the server does on its own (the invalidation poll), over 3 seconds.
  yield* Effect.sleep(Duration.seconds(3))
  const idle = yield* Effect.forEach(ports, (port) => metrics(port))
  const sampler = yield* sample.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(1))), Effect.forkChild)

  // --- open ---------------------------------------------------------------------------

  currentPhase = "open"
  log(`opening ${streams} streams (${openConcurrency} connects in flight per worker)`)
  const openStart = now()
  yield* all({ type: "open", concurrency: Math.max(1, Math.ceil(openConcurrency / workers.length)) }, "opened")
  const openSeconds = (now() - openStart) / 1000
  log(`opened in ${openSeconds.toFixed(1)}s`)
  yield* Effect.sleep(Duration.seconds(2))
  const opened = yield* Effect.forEach(ports, (port) => metrics(port, true))

  // --- writes ------------------------------------------------------------------------

  let seq = 0
  let writeErrors = 0
  const errorSamples: Array<string> = []
  const writes: Record<string, number> = {}
  const tag = (s: number, org: Org) => `ld${s}o${org.index}x`
  const editable = (row: Record<string, unknown>) => ({
    name: row["name"],
    email: row["email"],
    role: row["role"],
    teamId: row["teamId"],
    active: row["active"],
    startDate: row["startDate"],
    tags: row["tags"]
  })

  /** One write in a random organization, on a server chosen round-robin. */
  const write = Effect.gen(function*() {
    const s = ++seq
    const org = pick(orgs)
    const server = s % serverCount
    const port = ports[server]!
    const cookie = org.cookies[0]!
    const r = random()
    let kind: Descriptor["kind"] = r < 0.45 ? "update" : r < 0.55 ? "update" : r < 0.70 ? "insert" : r < 0.85 ? "delete" : r < 0.95 ? "bulk" : "team"
    if (kind === "delete" && org.inserted.length === 0) kind = "insert"
    const t = tag(s, org)
    let ids: Array<number> = []
    let column = ""
    const known = [...org.hot.slice(0, 20), ...org.inserted]
    switch (kind) {
      case "update": {
        const row = pick(known)
        column = r < 0.45 ? "email" : "name"
        const next = column === "email"
          ? { ...row, email: `${t}@hot.load.test` }
          : { ...row, name: `Hot ${t}` }
        Object.assign(row, next)
        ids = [row["id"] as number]
        yield* api(port, cookie, "PUT", `/api/users/${ids[0]}`, editable(next))
        break
      }
      case "insert": {
        const { json } = yield* api<Record<string, unknown>>(port, cookie, "POST", "/api/users", {
          name: `New ${t}`,
          email: `${t}@new.load.test`,
          role: "member",
          teamId: null,
          active: true,
          startDate: null,
          tags: []
        })
        org.inserted.push(json)
        ids = [json["id"] as number]
        break
      }
      case "delete": {
        const row = org.inserted.shift()!
        ids = [row["id"] as number]
        yield* api(port, cookie, "DELETE", `/api/users/${ids[0]}`)
        break
      }
      case "bulk": {
        const rows = Array.from({ length: 5 }, () => pick(org.hot.slice(0, 20)))
        ids = [...new Set(rows.map((row) => row["id"] as number))]
        const role = s % 2 === 0 ? "admin" : "member"
        for (const row of rows) row["role"] = role
        column = "role"
        yield* api(port, cookie, "POST", "/users/bulk/update", { users: { selection: ids, bulk: { field: "role", value: role } } })
        break
      }
      case "team": {
        const team = pick(org.teams)
        team.name = `Team ${t}`
        ids = [team.id]
        column = "name"
        yield* api(port, cookie, "PUT", `/api/teams/${team.id}`, { name: team.name, description: "" })
        break
      }
    }
    writes[kind] = (writes[kind] ?? 0) + 1
    broadcast([{ seq: s, kind, org: org.index, server, ids, column, sent: now() }])
  }).pipe(
    Effect.catchDefect((e) =>
      Effect.sync(() => {
        writeErrors++
        if (errorSamples.length < 5) errorSamples.push(String(e))
      })
    )
  )

  const steadyWrites = (seconds: number) =>
    Effect.gen(function*() {
      if (rate <= 0) return yield* Effect.sleep(Duration.seconds(seconds))
      const inFlight = yield* Semaphore.make(200)
      const interval = 1000 / rate
      const start = now()
      const fibers: Array<Fiber.Fiber<unknown>> = []
      for (let i = 0; now() - start < seconds * 1000; i++) {
        const due = start + i * interval
        const wait = due - now()
        if (wait > 0) yield* Effect.sleep(Duration.millis(wait))
        fibers.push(yield* Effect.forkChild(inFlight.withPermit(write)))
      }
      yield* Fiber.joinAll(fibers)
    })

  /** Waits until the servers stop sending (no new SSE events for `quiet` ms), up to `max` ms. */
  const settle = (quiet: number, max: number) =>
    Effect.gen(function*() {
      const start = now()
      let last = -1
      let lastChange = now()
      while (now() - start < max) {
        const snaps = yield* Effect.forEach(ports, (port) => metrics(port))
        const events = snaps.reduce((n, s) => n + s.counters["sseEvents"]!, 0)
        if (events !== last) {
          last = events
          lastChange = now()
        } else if (now() - lastChange >= quiet) break
        yield* Effect.sleep(Duration.millis(100))
      }
      return lastChange
    })

  yield* all({ type: "phase", phase: "write" }, "phase")
  currentPhase = "write"
  const writeStart = now()
  const beforeWrites = yield* Effect.forEach(ports, (port) => metrics(port))
  let burstInfo: Record<string, unknown> | undefined
  let stormInfo: Record<string, unknown> | undefined

  if (scenario === "burst") {
    log(`burst: ${burst} writes, ${burstConcurrency} in flight`)
    const inFlight = yield* Semaphore.make(burstConcurrency)
    yield* Effect.forEach(Array.from({ length: burst }), () => inFlight.withPermit(write), { concurrency: "unbounded", discard: true })
    const writesDone = now()
    const quietAt = yield* settle(1000, 300_000)
    burstInfo = {
      writes: burst,
      writeSeconds: (writesDone - writeStart) / 1000,
      writesPerSecond: Math.round(burst / ((writesDone - writeStart) / 1000)),
      catchUpSeconds: (quietAt - writeStart) / 1000
    }
    log(`burst written in ${(burstInfo["writeSeconds"] as number).toFixed(1)}s, streams caught up after ${(burstInfo["catchUpSeconds"] as number).toFixed(1)}s`)
  } else if (scenario === "storm") {
    log(`steady writes for ${duration / 2}s, then every tab reconnects at once`)
    yield* steadyWrites(duration / 2)
    const stormStart = now()
    const writer = yield* Effect.forkChild(steadyWrites(duration / 2))
    // Each worker drops all its tabs and reconnects them all at once.
    const reports = yield* all({ type: "storm" }, "opened")
    const reconnected = now()
    yield* Fiber.join(writer)
    stormInfo = { reconnectSeconds: (reconnected - stormStart) / 1000, workers: reports.length }
    log(`all ${streams} reconnected in ${((reconnected - stormStart) / 1000).toFixed(1)}s`)
  } else {
    log(`writing at ${rate}/s for ${duration}s`)
    yield* steadyWrites(duration)
  }
  const writeEnd = now()
  const afterWrites = yield* Effect.forEach(ports, (port) => metrics(port))
  currentPhase = "grace"
  const quietAt = yield* settle(1000, grace * 1000 + 120_000)
  yield* Effect.sleep(Duration.seconds(Math.max(0, grace - (now() - quietAt) / 1000)))
  yield* all({ type: "phase", phase: "after" }, "phase")
  const end = yield* Effect.forEach(ports, (port) => metrics(port, true))
  yield* Fiber.interrupt(sampler)

  // --- results ----------------------------------------------------------------------

  const reports = (yield* all<{ report: WorkerReport }>({ type: "report" }, "report")).map((r) => r.report)
  yield* all({ type: "close" }, "closed")
  const merge = (f: (r: WorkerReport) => ReadonlyArray<number>) => reports.flatMap((r) => [...f(r)])
  const sum = (f: (r: WorkerReport) => number) => reports.reduce((n, r) => n + f(r), 0)
  const totalWrites = seq - writeErrors
  const writeSeconds = (writeEnd - writeStart) / 1000

  const serverStats = ports.map((port, i) => {
    const b = baseline[i]!
    const o = opened[i]!
    const w0 = beforeWrites[i]!
    const w1 = afterWrites[i]!
    const e = end[i]!
    const during = samples[i]!.filter((s) => s.phase === "write" || s.phase === "grace")
    const delta = (k: string) => e.counters[k]! - w0.counters[k]!
    const seconds = (e.time - w0.time) / 1000
    const cpu = (a: Snapshot, z: Snapshot) => Math.round(((z.cpu.user + z.cpu.system - a.cpu.user - a.cpu.system) / 1e3 / (z.time - a.time)) * 100)
    const open = o.counters["streamsOpen"]!
    return {
      port,
      streamsOpen: open,
      rss: { baselineMB: mb(b.memory.rss), openedMB: mb(o.memory.rss), peakMB: mb(Math.max(...samples[i]!.map((s) => s.memory.rss))), endMB: mb(e.memory.rss) },
      heap: { baselineMB: mb(b.memory.heapUsed), openedMB: mb(o.memory.heapUsed), endMB: mb(e.memory.heapUsed) },
      perStreamKB: open > 0
        ? { rss: Math.round((o.memory.rss - b.memory.rss) / open / 102.4) / 10, heap: Math.round((o.memory.heapUsed - b.memory.heapUsed) / open / 102.4) / 10 }
        : undefined,
      cpuPercent: { open: cpu(b, o), writes: cpu(w0, w1) },
      eventLoopDelay: {
        p50: Math.max(0, ...during.map((s) => s.eventLoopDelay?.p50 ?? 0)),
        p99: Math.max(0, ...during.map((s) => s.eventLoopDelay?.p99 ?? 0)),
        max: Math.max(0, ...during.map((s) => s.eventLoopDelay?.max ?? 0))
      },
      perSecond: {
        sql: Math.round(delta("sqlStatements") / seconds),
        sqlMs: Math.round(delta("sqlMs") / seconds),
        renders: Math.round(delta("renders") / seconds),
        renderMs: Math.round(delta("renderMs") / seconds),
        requeries: Math.round(delta("requeries") / seconds)
      },
      perWrite: {
        sql: Math.round(delta("sqlStatements") / Math.max(1, totalWrites)),
        renders: Math.round(delta("renders") / Math.max(1, totalWrites)),
        requeries: Math.round(delta("requeries") / Math.max(1, totalWrites)),
        sseKB: Math.round(delta("sseBytes") / Math.max(1, totalWrites) / 102.4) / 10
      },
      idle: {
        // Before the first tab: what the server does on its own (the invalidation poll).
        sqlPerSecond: Math.round((idle[i]!.counters["sqlStatements"]! - b.counters["sqlStatements"]!) / ((idle[i]!.time - b.time) / 1000))
      },
      timeline: samples[i]!.map((s) => ({
        t: Math.round((s.time - b.time) / 100) / 10,
        phase: s.phase,
        rssMB: mb(s.memory.rss),
        heapMB: mb(s.memory.heapUsed),
        eldP99: s.eventLoopDelay?.p99,
        streams: s.counters["streamsOpen"]
      }))
    }
  })

  const latency = Object.fromEntries(Object.entries({
    all: merge((r) => Object.values(r.latency).flat()),
    update: merge((r) => r.latency["update"] ?? []),
    insert: merge((r) => r.latency["insert"] ?? []),
    delete: merge((r) => r.latency["delete"] ?? []),
    bulk: merge((r) => r.latency["bulk"] ?? []),
    ...(serverCount > 1 ? { sameProcess: merge((r) => r.sameLatency), crossProcess: merge((r) => r.crossLatency) } : {})
  }).map(([k, v]) => [k, percentiles(v)]))

  const result = {
    label,
    scenario,
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), node: process.version },
    options: { streams, rate, duration, burst, burstConcurrency, slow: slowFraction, servers: serverCount, workers: workers.length, orgs: orgCount },
    tabs: { total: streams, distinctViews: distinct, slow: specs.filter((s) => s.slow).length },
    open: { seconds: openSeconds, connected: sum((r) => r.connected), failed: sum((r) => r.failed), failures: [...new Set(reports.flatMap((r) => r.failures))], ttfe: percentiles(merge((r) => r.ttfe)) },
    writes: { total: totalWrites, errors: writeErrors, errorSamples, byKind: writes, seconds: writeSeconds, perSecond: Math.round((totalWrites / writeSeconds) * 10) / 10 },
    burst: burstInfo,
    storm: stormInfo,
    latency,
    correctness: {
      expected: sum((r) => r.expected),
      delivered: sum((r) => r.delivered),
      superseded: sum((r) => r.superseded),
      misses: sum((r) => r.misses),
      missSamples: reports.flatMap((r) => r.missSamples).slice(0, 10),
      crossOrgLeaks: sum((r) => r.leaks),
      leakSamples: reports.flatMap((r) => r.leakSamples).slice(0, 5)
    },
    clientBytesPerWriteKB: Math.round(sum((r) => r.phaseBytes) / Math.max(1, totalWrites) / 102.4) / 10,
    servers: serverStats
  }
  writeFileSync(`${dir}/results/${label}.json`, JSON.stringify(result, null, 2))
  if (!args["keep-db"]) for (const suffix of ["", "-wal", "-shm"]) rmSync(`${db}${suffix}`, { force: true })

  const { servers: _, ...summary } = result
  console.log(JSON.stringify({
    ...summary,
    servers: serverStats.map(({ timeline: _t, ...s }) => s)
  }, null, 2))
  log(`written .load/results/${label}.json`)
})

NodeRuntime.runMain(Effect.scoped(program))
