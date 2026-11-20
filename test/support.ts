/**
 * Test helpers: run the real app in-process (in-memory SQLite, no server) and
 * talk to it like Datastar does.
 */
import { NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
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
export const makeApp = (options?: { readonly seed?: boolean }) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    Routes.pipe(
      // provideMerge: the routes' per-request requirements are satisfied from the layer's outputs.
      Layer.provideMerge(Infra({ filename: ":memory:", seed: options?.seed ?? true })),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(NodeServices.layer)
    ),
    { disableLogger: true }
  )
  afterAll(() => dispose())

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
      new Request(`${url(path)}?datastar=${encodeURIComponent(JSON.stringify(signals))}`, {
        signal: controller.signal
      })
    )
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
    const read = (ms: number) => {
      pending ??= reader.read()
      return Promise.race([
        pending.then((r) => {
          pending = undefined
          return r
        }),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))
      ])
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
    const close = () => {
      controller.abort()
      return reader.cancel().catch(() => {})
    }
    return { response, until, close }
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
      filters: { name: "", email: "", role: "", teamId: "", active: "", ...filters },
      ...overrides
    }
  }
})

export const userDraft = (draft: Record<string, unknown>) => ({
  users: { draft: { id: "", name: "", email: "", role: "member", teamId: "", active: true, ...draft } }
})

/** Text of the rows in a rendered table. */
export const rowNames = (html: string) =>
  [...html.matchAll(/<tr id="(?:user|team)-\d+"><td>(?:<span>)?([^<]*)/g)].map((m) => m[1])
