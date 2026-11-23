/**
 * Test helpers: run the real app in-process (in-memory SQLite, no server) and
 * talk to it like Datastar does.
 */
import { NodeServices } from "@effect/platform-node"
import { type Duration, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { afterAll } from "vitest"
import { Infra, Routes } from "../src/app/App.tsx"

export type Event =
  | { readonly type: "patch-elements"; readonly elements: string; readonly selector?: string; readonly mode?: string }
  | { readonly type: "patch-signals"; readonly signals: any }

/** Parse a Datastar SSE body into events. */
export const parseEvents = (body: string): Array<Event> =>
  body.split("\n\n").filter((block) => block.trim() !== "").map((block) => {
    const lines = block.split("\n")
    const type = lines.find((l) => l.startsWith("event: "))!.slice("event: ".length)
    const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice("data: ".length))
    const field = (name: string) =>
      data.filter((d) => d.startsWith(name + " ")).map((d) => d.slice(name.length + 1))
    if (type === "datastar-patch-signals") {
      return { type: "patch-signals", signals: JSON.parse(field("signals").join("\n")) }
    }
    const selector = field("selector")[0]
    const mode = field("mode")[0]
    return {
      type: "patch-elements",
      elements: field("elements").join("\n"),
      ...(selector ? { selector } : {}),
      ...(mode ? { mode } : {})
    }
  })

/**
 * A fresh app with its own in-memory database (seeded unless `seed: false`).
 * Disposed after the test file.
 */
export const makeApp = (options?: {
  readonly seed?: boolean
  /** Defaults to a private in-memory database. Pass a file to run several apps ("servers") on one database. */
  readonly filename?: string
  readonly pollInterval?: Duration.Input
}) => {
  const { handler: anonymous, dispose } = HttpRouter.toWebHandler(
    Routes.pipe(
      // provideMerge: the routes' per-request requirements are satisfied from the layer's outputs.
      Layer.provideMerge(Infra({
        filename: options?.filename ?? ":memory:",
        seed: options?.seed ?? true,
        ...(options?.pollInterval === undefined ? {} : { pollInterval: options.pollInterval })
      })),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(NodeServices.layer)
    ),
    { disableLogger: true }
  )
  afterAll(() => dispose())

  /** The app as `email` (default: a member of Acme). The session is created on first use. */
  const as = (email: string = ACME, password: string = DEMO_PASSWORD) => {
    let cookie: Promise<string> | undefined
    return client(anonymous, (request) => {
      cookie ??= signIn(anonymous, email, password)
      return cookie.then((c) => withCookie(request, c))
    })
  }

  return { ...as(), as, anonymous: client(anonymous, (request) => Promise.resolve(request)) }
}

/** The demo accounts (seeded): Acme has teams 1-3, tags 1-5 and 52 users; Globex teams 4-5, tags 6-8 and 35 users. */
export const ACME = "ada@acme.test"
export const ACME_2 = "grace@acme.test"
export const GLOBEX = "linus@globex.test"
export const DEMO_PASSWORD = "demo-password"

/**
 * Sign in through `POST /login` (as the sign-in form does) and return the
 * session cookie's value. Fails if the credentials are rejected.
 */
export const signIn = async (handler: (request: Request) => Promise<Response>, email: string, password: string) => {
  const response = await handler(
    new Request("http://test/login", {
      method: "POST",
      headers: { "datastar-request": "true", "content-type": "application/json" },
      body: JSON.stringify({ login: { email, password, next: "/users", error: "" } })
    })
  )
  const match = /(?:^|,\s*)session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")
  if (!match) throw new Error(`sign-in as ${email} failed: ${await response.text()}`)
  return match[1]!
}

/** `request` with the session cookie (unless it already has a cookie header). */
export const withCookie = (request: Request, session: string) => {
  if (request.headers.has("cookie")) return request
  const headers = new Headers(request.headers)
  headers.set("cookie", `session=${session}`)
  return new Request(request, { headers })
}

/** Helpers that send every request through `prepare` (e.g. adding a session cookie). */
type Handler = (request: Request) => Promise<Response>
const client = (raw: Handler, prepare: (request: Request) => Promise<Request>) => {
  const handler = async (request: Request) => raw(await prepare(request))
  const url = (path: string) => `http://test${path}`

  /** Send a Datastar action and collect the (finite) response events. */
  const action = async (method: string, path: string, signals: unknown = {}) => {
    const init: RequestInit = { method, headers: { "datastar-request": "true" } }
    let target = url(path)
    if (method === "GET" || method === "DELETE") {
      target += `${path.includes("?") ? "&" : "?"}datastar=${encodeURIComponent(JSON.stringify(signals))}`
    } else {
      init.body = JSON.stringify(signals)
      init.headers = { ...init.headers, "content-type": "application/json" }
    }
    const response = await handler(new Request(target, init))
    return { response, events: parseEvents(await response.text()) }
  }

  /**
   * Open a long-lived stream (e.g. a live view). `until(done)` collects events
   * until `done` holds; `close()` aborts the request.
   */
  const stream = async (path: string, signals: unknown) => {
    const controller = new AbortController()
    const response = await handler(
      new Request(`${url(path)}${path.includes("?") ? "&" : "?"}datastar=${encodeURIComponent(JSON.stringify(signals))}`, {
        signal: controller.signal
      })
    )
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
    // A read that times out stays pending for the next call, which gets its chunk: it is
    // only cleared once a caller has received it (clearing it when it resolves would drop
    // a chunk that arrives between two calls).
    const read = async (ms: number) => {
      pending ??= reader.read()
      const r = await Promise.race([
        pending,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))
      ])
      if (r !== "timeout") pending = undefined
      return r
    }
    const drain = (): Array<Event> => {
      const end = buffer.lastIndexOf("\n\n") + 2
      if (end < 2) return []
      const complete = buffer.slice(0, end)
      buffer = buffer.slice(end)
      return parseEvents(complete)
    }
    /**
     * Read messages until `done(events)` holds, then keep reading for `settle` ms
     * so every message of the same emission is included.
     */
    const until = async (done: (events: Array<Event>) => boolean, options?: { timeout?: number; settle?: number }) => {
      const events: Array<Event> = []
      const deadline = Date.now() + (options?.timeout ?? 2000)
      while (!done(events)) {
        const r = await read(Math.max(1, deadline - Date.now()))
        if (r === "timeout") throw new Error(`timed out; got ${JSON.stringify(events).slice(0, 300)}`)
        if (r.done) throw new Error("stream ended")
        buffer += decoder.decode(r.value, { stream: true })
        events.push(...drain())
      }
      const settleUntil = Date.now() + (options?.settle ?? 50)
      while (Date.now() < settleUntil) {
        const r = await read(Math.max(1, settleUntil - Date.now()))
        if (r === "timeout" || r.done) break
        buffer += decoder.decode(r.value, { stream: true })
        events.push(...drain())
      }
      return events
    }
    /** Every message that arrives within `ms` (possibly none). */
    const collect = async (ms: number) => {
      const events: Array<Event> = []
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const r = await read(Math.max(1, deadline - Date.now()))
        if (r === "timeout" || r.done) break
        buffer += decoder.decode(r.value, { stream: true })
        events.push(...drain())
      }
      return events
    }
    const close = () => {
      controller.abort()
      return reader.cancel().catch(() => {})
    }
    return { response, until, collect, close }
  }

  const page = async (path: string) => (await handler(new Request(url(path)))).text()

  return { handler, action, stream, page }
}

/** Signals for a users list query, with defaults. */
export const usersQuery = (overrides: Record<string, unknown> = {}, filters: Record<string, string> = {}) => ({
  users: {
    query: {
      page: 1,
      pageSize: 10,
      sort: "createdAt",
      dir: "desc",
      filters: { name: "", email: "", role: "", teamId: "", active: "", tags: "", createdAtFrom: "", createdAtTo: "", ...filters },
      ...overrides
    }
  }
})

export const userDraft = (draft: Record<string, unknown>) => ({
  users: { draft: { id: "", name: "", email: "", role: "member", teamId: "", active: true, startDate: "", tags: [], ...draft } }
})

/**
 * Text of the first data cell of each row in a rendered table (after the selection
 * checkbox; rows and cells carry StyleX classes). Works on decoded HTML too, where the
 * checkbox's attributes may contain `>` (`(x) => ...`).
 */
export const rowNames = (html: string) =>
  [
    ...html.matchAll(
      /<tr id="(?:users|teams|tags|members)-\d+"[^>]*>(?:<td[^>]*><input(?:[^>"]|"[^"]*")*\/?><\/td>)?<td[^>]*>(?:<span[^>]*>|<a [^>]*>)?([^<]*)/g
    )
  ].map((m) => m[1])

/** Decodes the entities React's server renderer writes in text and attribute values. */
export const decode = (html: string) =>
  html.replace(/&#x27;/g, "'").replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

/** The initial `data-signals` of a page (the first one). */
export const initialSignals = (html: string) => JSON.parse(decode(/data-signals="([^"]*)"/.exec(html)![1]!))
