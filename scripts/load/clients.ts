/**
 * A worker thread holding a share of the simulated tabs: lightweight SSE
 * clients (plain `node:http`, no browser) that open live views as Datastar
 * does (`GET <path>?datastar=<signals>` with `datastar-request: true`).
 *
 * Each client keeps what a tab would show, as far as the checks need it:
 * the row ids on its page (from every full table patch) and the first time it
 * saw each mutation tag (`ld<seq>o<org>x`, written into a name or email by the
 * writers in `run.ts`). From the mutation descriptors the coordinator sends
 * after each write's HTTP response, it decides whether it *should* see that
 * mutation, and reports latencies, misses and cross-organization leaks.
 *
 * Runs on Node's type stripping: erasable TypeScript only.
 */
import * as http from "node:http"
import { parentPort, workerData } from "node:worker_threads"
import type { ClientSpec, Descriptor, ToWorker, WorkerReport } from "./protocol.ts"

const now = () => performance.timeOrigin + performance.now()
const port = parentPort!
const { host } = workerData as { readonly host: string }

const TAG = /ld(\d+)o(\d+)x/g
const ROW = /<tr id="([a-z]+)-(\d+)"/g

interface Client {
  readonly spec: ClientSpec
  request?: http.ClientRequest | undefined
  response?: http.IncomingMessage | undefined
  buffer: string
  opening: number
  firstEvent: number | undefined
  failed: string | undefined
  closed: boolean
  /** Row ids on the page (list views), as of the last full table patch. */
  visible: Set<number>
  /** When a row id left the page (list views): deletes. */
  vanished: Map<number, number>
  /** Mutation seq -> first time a patch carried its tag. */
  seen: Map<number, number>
  /** Event times since the write phase started (detail views only: bulk latency). */
  eventTimes: Array<number>
  bytes: number
  events: number
  /** Stopped reading its socket (slow consumer). */
  slow: boolean
  /** Bumped on every (re)connect, so a stale socket's events are ignored. */
  generation: number
}

const clients: Array<Client> = []
let phase: "setup" | "write" | "after" = "setup"
let phaseBytes = 0
let phaseEvents = 0
let leaks = 0
const leakSamples: Array<string> = []
const descriptors: Array<Descriptor & { readonly arrived: number }> = []
/** Per descriptor seq, per client index: was it expected when the descriptor arrived. */
const expectations = new Map<number, Array<number>>()

const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity })

const handleEvent = (c: Client, block: string) => {
  const t = now()
  c.events++
  c.bytes += block.length
  if (phase === "write") {
    phaseBytes += block.length
    phaseEvents++
  }
  if (c.firstEvent === undefined) {
    c.firstEvent = t
    if (c.spec.slow) {
      // A slow consumer: stop reading after the first event. The socket's buffers fill and
      // the server's writes see backpressure.
      c.slow = true
      c.response?.pause()
    }
  }
  if (c.spec.kind === "detail" && phase !== "setup") c.eventTimes.push(t)
  for (const m of block.matchAll(TAG)) {
    const seq = Number(m[1])
    const org = Number(m[2])
    if (org !== c.spec.org) {
      leaks++
      if (leakSamples.length < 5) leakSamples.push(`client ${c.spec.index} (org ${c.spec.org}) saw ${m[0]}`)
      continue
    }
    if (!c.seen.has(seq)) c.seen.set(seq, t)
  }
  if (c.spec.kind === "list" && block.includes(`id="${c.spec.ns}-table"`)) {
    const next = new Set<number>()
    for (const m of block.matchAll(ROW)) if (m[1] === c.spec.ns) next.add(Number(m[2]))
    for (const id of c.visible) if (!next.has(id)) c.vanished.set(id, t)
    c.visible = next
  }
}

const open = (c: Client): Promise<void> =>
  new Promise((resolve) => {
    const generation = ++c.generation
    c.opening = now()
    c.firstEvent = undefined
    c.failed = undefined
    c.buffer = ""
    c.closed = false
    let settled = false
    const done = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    const request = http.request({
      host,
      port: c.spec.port,
      path: c.spec.path,
      agent,
      headers: { cookie: `session=${c.spec.cookie}`, "datastar-request": "true", accept: "text/event-stream" }
    }, (response) => {
      if (generation !== c.generation) return
      c.response = response
      if (response.statusCode !== 200) {
        c.failed = `status ${response.statusCode}`
        response.resume()
        done()
        return
      }
      response.setEncoding("utf8")
      response.on("data", (chunk: string) => {
        if (generation !== c.generation) return
        c.buffer += chunk
        let end = c.buffer.indexOf("\n\n")
        while (end !== -1) {
          handleEvent(c, c.buffer.slice(0, end))
          c.buffer = c.buffer.slice(end + 2)
          end = c.buffer.indexOf("\n\n")
        }
        if (c.firstEvent !== undefined) done()
      })
      response.on("end", () => {
        if (generation === c.generation) c.closed = true
        done()
      })
      response.on("error", () => done())
    })
    request.on("error", (e) => {
      if (generation === c.generation) c.failed = e.message
      done()
    })
    request.setTimeout(0)
    request.end()
    c.request = request
  })

/** Opens `list` with at most `concurrency` connects in flight. */
const openAll = async (list: ReadonlyArray<Client>, concurrency: number) => {
  let next = 0
  const lane = async () => {
    while (next < list.length) {
      const c = list[next++]!
      await open(c)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, lane))
}

const kill = (c: Client) => {
  c.generation++
  const socket = c.request?.socket
  // A reset, as a killed tab's OS would do: no TIME_WAIT on our side, so a reconnect
  // storm of thousands of sockets doesn't run out of ephemeral ports.
  if (socket && !socket.destroyed) socket.resetAndDestroy()
  else c.request?.destroy()
  c.request = undefined
  c.response = undefined
}

/** Whether a client should see `d`, judged from its state when `d` arrived. */
const expects = (c: Client, d: Descriptor): boolean => {
  if (c.spec.org !== d.org || c.slow || c.failed !== undefined) return false
  const s = c.spec
  switch (d.kind) {
    case "update": {
      const id = d.ids[0]!
      if (s.kind === "detail") return s.resource === "users" && s.recordId === id
      // A change to a column the view sorts or filters on may move the row off the page.
      return s.resource === "users" && c.visible.has(id) && !s.queryColumns.includes(d.column)
    }
    case "insert":
      return s.kind === "list" && s.resource === "users" && s.insertLandsOnPage === true
    case "delete": {
      const id = d.ids[0]!
      if (s.kind !== "list" || s.resource !== "users") return false
      const gone = c.vanished.get(id)
      return c.visible.has(id) || (gone !== undefined && gone >= d.sent)
    }
    case "bulk":
      return s.kind === "detail" && s.resource === "users" && d.ids.includes(s.recordId!)
    case "team":
      return false
  }
}

const onDescriptor = (d: Descriptor) => {
  const arrived = now()
  descriptors.push({ ...d, arrived })
  const expected: Array<number> = []
  for (let i = 0; i < clients.length; i++) if (expects(clients[i]!, d)) expected.push(i)
  expectations.set(d.seq, expected)
}

const percentileInput = (values: Array<number>) => values

const report = (): WorkerReport => {
  const latency: Record<string, Array<number>> = { update: [], insert: [], delete: [], bulk: [], team: [] }
  const crossLatency: Array<number> = []
  const sameLatency: Array<number> = []
  let expected = 0
  let delivered = 0
  let superseded = 0
  let moved = 0
  const missSamples: Array<string> = []
  let misses = 0
  // Updates per row, for "superseded": concurrent writes to one row may land in either order,
  // and a coalescing server may skip straight to the latest.
  const rowSeqs = new Map<number, Array<number>>()
  for (const d of descriptors) {
    if (d.kind !== "update") continue
    const id = d.ids[0]!
    const list = rowSeqs.get(id) ?? []
    list.push(d.seq)
    rowSeqs.set(id, list)
  }
  for (const d of descriptors) {
    const expectedClients = expectations.get(d.seq) ?? []
    for (const i of expectedClients) {
      const c = clients[i]!
      expected++
      let at: number | undefined
      if (d.kind === "update" || d.kind === "insert" || d.kind === "team") at = c.seen.get(d.seq)
      else if (d.kind === "delete") at = c.vanished.get(d.ids[0]!)
      else if (d.kind === "bulk") at = c.eventTimes.find((t) => t >= d.sent - 50)
      if (at !== undefined && (d.kind !== "delete" || at >= d.sent - 1000)) {
        delivered++
        const ms = at - d.sent
        latency[d.kind]!.push(ms)
        if (c.spec.server !== d.server) crossLatency.push(ms)
        else sameLatency.push(ms)
        continue
      }
      if (d.kind === "update" && (rowSeqs.get(d.ids[0]!) ?? []).some((s) => s !== d.seq && (c.seen.get(s) ?? -Infinity) >= d.sent - 50)) {
        superseded++
        continue
      }
      // A concurrent write moved the row off this page (an insert pushed it to the next
      // page, a bulk role change took it out of a role filter), or later inserts handled in
      // the same batch pushed a new row off page 1 before it was ever rendered: not a miss.
      if ((d.kind === "update" || d.kind === "insert") && c.spec.kind === "list" && !c.visible.has(d.ids[0]!)) {
        moved++
        continue
      }
      misses++
      if (missSamples.length < 10) {
        missSamples.push(`client ${c.spec.index} ${c.spec.path.split("?")[0]} ${JSON.stringify(c.spec.query ?? {})} missed ${d.kind} #${d.seq} ids=${d.ids.join(",")}`)
      }
    }
  }
  // Tags seen by clients that weren't expected to (row moved onto the page, name-sorted views...).
  const ttfe = clients.filter((c) => c.firstEvent !== undefined).map((c) => c.firstEvent! - c.opening)
  return {
    clients: clients.length,
    connected: clients.filter((c) => c.firstEvent !== undefined && c.failed === undefined).length,
    failed: clients.filter((c) => c.failed !== undefined).length,
    failures: [...new Set(clients.flatMap((c) => (c.failed === undefined ? [] : [c.failed])))].slice(0, 5),
    ttfe: percentileInput(ttfe),
    latency,
    crossLatency,
    sameLatency,
    expected,
    delivered,
    superseded,
    moved,
    misses,
    missSamples,
    leaks,
    leakSamples,
    phaseBytes,
    phaseEvents
  }
}

port.on("message", async (message: ToWorker) => {
  switch (message.type) {
    case "init": {
      for (const spec of message.specs) {
        clients.push({
          spec,
          buffer: "",
          opening: 0,
          firstEvent: undefined,
          failed: undefined,
          closed: false,
          visible: new Set(),
          vanished: new Map(),
          seen: new Map(),
          eventTimes: [],
          bytes: 0,
          events: 0,
          slow: false,
          generation: 0
        })
      }
      port.postMessage({ type: "ready" })
      break
    }
    case "open": {
      await openAll(clients, message.concurrency)
      port.postMessage({ type: "opened" })
      break
    }
    case "phase":
      phase = message.phase
      if (phase === "write") {
        phaseBytes = 0
        phaseEvents = 0
      }
      port.postMessage({ type: "phase" })
      break
    case "desc":
      for (const d of message.descriptors) onDescriptor(d)
      break
    case "storm": {
      // Every tab drops its connection at once, then all reconnect at once.
      for (const c of clients) kill(c)
      await openAll(clients, clients.length)
      port.postMessage({ type: "opened" })
      break
    }
    case "report":
      port.postMessage({ type: "report", report: report() })
      break
    case "close":
      for (const c of clients) kill(c)
      agent.destroy()
      port.postMessage({ type: "closed" })
      break
  }
})
