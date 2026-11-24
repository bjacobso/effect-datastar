import { NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { describe, expect, it } from "vitest"
import { makeBoardApp } from "../src/App.tsx"

const decodeEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")

const createTestHandler = () => {
  const { routes, infra, view } = makeBoardApp()
  const web = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provideMerge(infra),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(NodeServices.layer)
    ),
    { disableLogger: true }
  )
  return { ...web, view }
}

/** Open an SSE stream and read chunks until `predicate` matches the accumulated text. */
const openSse = async (handler: (req: Request) => Promise<Response>, path: string) => {
  const controller = new AbortController()
  const res = await handler(new Request(`http://localhost${path}`, { signal: controller.signal }))
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  const readUntil = async (predicate: (text: string) => boolean, timeoutMs = 2000): Promise<string> => {
    const deadline = Date.now() + timeoutMs
    while (!predicate(buffer)) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for SSE chunk. Buffer so far:\n${buffer}`)
      }
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`SSE read timeout. Buffer:\n${buffer}`)), Math.max(10, deadline - Date.now()))
        )
      ])
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
    }
    return buffer
  }

  const close = async () => {
    controller.abort()
    await reader.cancel().catch(() => {})
  }

  return { readUntil, close }
}

describe("Kanban Board app", () => {
  it("renders SSR HTML with compiled Datastar data-* attributes and initial cards", async () => {
    const { handler, dispose } = createTestHandler()
    try {
      const res = await handler(new Request("http://localhost/"))
      expect(res.status).toBe(200)
      const html = decodeEntities(await res.text())

      expect(html).toContain("<!doctype html>")
      expect(html).toContain("data-signals=")
      expect(html).toContain('"board":{"title":"","column":"todo","priority":"med"')
      expect(html).toMatch(/data-init="@get\('\/board\/live', \{openWhenHidden: true, retryInterval: \d+\}\)"/)
      expect(html).toContain('data-bind="board.title"')
      expect(html).toContain('data-bind="board.column"')
      expect(html).toContain('data-bind="board.priority"')
      expect(html).toContain('data-bind="board.filter"')
      expect(html).toContain('data-on:submit__prevent="@post(\'/board/cards\'')
      expect(html).toContain('data-indicator="board._busy"')
      expect(html).toContain('data-class:active="$board.filter.length > 0"')
      expect(html).toContain('data-attr:disabled="$board._busy || ($board.title.trim().length === 0)"')
      expect(html).toContain('data-show="$board.error.length > 0"')
      expect(html).toContain('data-text="$board.error"')

      // Seeded cards
      expect(html).toContain("Design typed signal AST")
      expect(html).toContain("Build custom Datastar JSX runtime")
      expect(html).toContain("Add Kanban live SSE board")
      expect(html).toContain("Document multi-app workspaces")
    } finally {
      await dispose()
    }
  })

  it("handles POST create with validation error and valid incremental card prepend", async () => {
    const { handler, dispose } = createTestHandler()
    try {
      // 1. Validation error on blank title
      const invalidRes = await handler(
        new Request("http://localhost/board/cards", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ board: { title: "   ", column: "todo", priority: "high" } })
        })
      )
      expect(invalidRes.status).toBe(200)
      const invalidBody = await invalidRes.text()
      expect(invalidBody).toContain('data: signals {"board":{"error":"Card title is required."}}')

      // 2. Valid create
      const okRes = await handler(
        new Request("http://localhost/board/cards", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ board: { title: "Write E2E docs", column: "todo", priority: "high" } })
        })
      )
      expect(okRes.status).toBe(200)
      const okBody = await okRes.text()
      expect(okBody).toContain('data: signals {"board":{"title":"","error":""}}')
      expect(okBody).toContain("data: selector #board-todo")
      expect(okBody).toContain("data: mode prepend")
      expect(okBody).toContain("Write E2E docs")
      expect(okBody).toContain("data: selector #board-todo-count")
      expect(okBody).toContain(">3</span>")
    } finally {
      await dispose()
    }
  })

  it("moves cards between columns and deletes cards with incremental slot patches", async () => {
    const { handler, dispose } = createTestHandler()
    try {
      // Seeded card #3 is "Add Kanban live SSE board" in "todo" (2 todo, 1 doing)
      const moveRes = await handler(
        new Request("http://localhost/board/cards/3/move/doing", { method: "POST" })
      )
      expect(moveRes.status).toBe(200)
      const moveBody = await moveRes.text()
      expect(moveBody).toContain("data: selector #board-todo-3")
      expect(moveBody).toContain("data: mode remove")
      expect(moveBody).toContain("data: selector #board-doing")
      expect(moveBody).toContain("data: mode prepend")
      expect(moveBody).toContain("Add Kanban live SSE board")
      expect(moveBody).toContain("data: selector #board-todo-count")
      expect(moveBody).toContain(">1</span>")
      expect(moveBody).toContain("data: selector #board-doing-count")
      expect(moveBody).toContain(">2</span>")

      // Delete card #3 from "doing"
      const delRes = await handler(
        new Request("http://localhost/board/cards/3", { method: "DELETE" })
      )
      expect(delRes.status).toBe(200)
      const delBody = await delRes.text()
      expect(delBody).toContain("data: selector #board-doing-3")
      expect(delBody).toContain("data: mode remove")
      expect(delBody).toContain("data: selector #board-doing-count")
      expect(delBody).toContain(">1</span>")
    } finally {
      await dispose()
    }
  })

  it("broadcasts live SSE updates across 2 concurrent subscribers when the board mutates", async () => {
    const { handler, dispose } = createTestHandler()
    const sub1 = await openSse(handler, "/board/live")
    const sub2 = await openSse(handler, "/board/live")

    try {
      // Both subscribers receive the initial snapshot
      const [init1, init2] = await Promise.all([
        sub1.readUntil((t) => t.includes("Design typed signal AST")),
        sub2.readUntil((t) => t.includes("Design typed signal AST"))
      ])
      expect(init1).toContain("data: selector #board-columns")
      expect(init2).toContain("data: selector #board-columns")

      // Mutate via POST /board/cards
      const createRes = await handler(
        new Request("http://localhost/board/cards", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ board: { title: "Broadcast check", column: "doing", priority: "med" } })
        })
      )
      expect(createRes.status).toBe(200)

      // Both subscribers receive the live update with the new card
      const [up1, up2] = await Promise.all([
        sub1.readUntil((t) => t.includes("Broadcast check")),
        sub2.readUntil((t) => t.includes("Broadcast check"))
      ])
      expect(up1).toContain("Broadcast check")
      expect(up2).toContain("Broadcast check")
    } finally {
      await sub1.close()
      await sub2.close()
      await dispose()
    }
  })
})
