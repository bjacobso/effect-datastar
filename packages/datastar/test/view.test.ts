import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import * as Datastar from "../src/Datastar.ts"
import { Slot } from "../src/Slot.ts"
import { View } from "../src/View.ts"

const CounterSignals = Schema.Struct({
  count: Schema.Number,
  step: Schema.Number,
  label: Schema.String
})

const makeCounterView = () =>
  View.make("counter", {
    signals: CounterSignals,
    slots: {
      display: Slot.make("display", (n: number, id) => `<span id="${id}">${n}</span>`),
      log: Slot.keyed(
        "log",
        (entry: { readonly id: number; readonly msg: string }) => entry.id,
        (entry, itemId) => `<li id="${itemId}">${entry.msg}</li>`
      )
    },
    actions: ({ action, slots, patchSignals }) => ({
      inc: action("POST", "/counter/inc", {
        signals: ["count", "step"] as const,
        handle: ({ signals }) => {
          const next = signals.count + signals.step
          return Effect.succeed([
            patchSignals({ count: next }),
            slots.display.morph(next)
          ])
        }
      }),
      removeLog: action("DELETE", "/counter/log/:id", {
        handle: ({ params }) => Effect.succeed([slots.log.removeItem(Number(params.id))])
      })
    }),
    live: ({ slots }) =>
      View.live(
        "/counter/live",
        () => Stream.make([slots.display.morph(0)]),
        { jitter: { min: 1200, max: 1800 } }
      ),
    onSignalsError: (err) => [Datastar.patchSignals({ error: err._tag })]
  })

describe("View.make", () => {
  it("namespaces signals, scopes slots, and auto-derives filterSignals on actions", () => {
    const counter = makeCounterView()

    expect(counter.$.count.path).toBe("counter.count")
    expect(counter.$.count.toExpr()).toBe("$counter.count")
    expect(counter.$.init({ count: 0, step: 1, label: "A" })).toEqual({
      "data-signals": '{"counter":{"count":0,"step":1,"label":"A"}}'
    })

    expect(counter.slots.display.id).toBe("counter-display")
    expect(counter.slots.display.selector).toBe("#counter-display")
    expect(counter.slots.log.containerId).toBe("counter-log")
    expect(counter.slots.log.itemId(3)).toBe("counter-log-3")

    expect(counter.actions.inc.call().toExpr()).toBe(
      "@post('/counter/inc', {filterSignals: {include: /^(counter\\.count|counter\\.step)(\\.|$)/}})"
    )
    expect(counter.actions.removeLog.call({ id: 9 }).toExpr()).toBe(
      "@delete('/counter/log/9')"
    )
  })

  it("supports standalone View.action record syntax", () => {
    const simple = View.make("simple", {
      signals: Schema.Struct({ text: Schema.String }),
      actions: {
        save: View.action("POST", "/simple/save", {
          signals: ["text"] as const,
          handle: ({ signals }) => Effect.succeed([Datastar.patchSignals({ saved: signals.text })])
        })
      }
    })

    expect(simple.actions.save.call().toExpr()).toBe(
      "@post('/simple/save', {filterSignals: {include: /^(simple\\.text)(\\.|$)/}})"
    )
  })

  it("generates jittered retryInterval for View.live", () => {
    const counter = makeCounterView()
    const expr = counter.live.call().toExpr()
    expect(expr).toMatch(/^@get\('\/counter\/live', \{openWhenHidden: true, retryInterval: \d+\}\)$/)
    const interval = Number(/retryInterval: (\d+)/.exec(expr)![1])
    expect(interval).toBeGreaterThanOrEqual(1200)
    expect(interval).toBeLessThanOrEqual(1800)
  })

  it("serves actions, path params, signal errors, and live streams via Effect HttpRouter", async () => {
    const counter = makeCounterView()
    const { handler, dispose } = HttpRouter.toWebHandler(
      counter.layer.pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true }
    )

    try {
      // 1. POST action with valid namespaced signals
      const incRes = await handler(
        new Request("http://localhost/counter/inc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ counter: { count: 10, step: 5 } })
        })
      )
      expect(incRes.status).toBe(200)
      expect(incRes.headers.get("content-type")).toContain("text/event-stream")
      const incBody = await incRes.text()
      expect(incBody).toContain('data: signals {"counter":{"count":15}}')
      expect(incBody).toContain('data: selector #counter-display')
      expect(incBody).toContain('data: elements <span id="counter-display">15</span>')

      // 2. DELETE action with path param
      const delRes = await handler(
        new Request("http://localhost/counter/log/42", { method: "DELETE" })
      )
      expect(delRes.status).toBe(200)
      const delBody = await delRes.text()
      expect(delBody).toContain("data: selector #counter-log-42")
      expect(delBody).toContain("data: mode remove")

      // 3. Invalid signals trigger onSignalsError instead of 500
      const badRes = await handler(
        new Request("http://localhost/counter/inc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ counter: { count: "not-a-number", step: 1 } })
        })
      )
      expect(badRes.status).toBe(200)
      const badBody = await badRes.text()
      expect(badBody).toContain('data: signals {"error":"SignalsError"}')

      // 4. Live stream endpoint
      const liveRes = await handler(new Request("http://localhost/counter/live"))
      expect(liveRes.status).toBe(200)
      const liveBody = await liveRes.text()
      expect(liveBody).toContain('data: elements <span id="counter-display">0</span>')
    } finally {
      await dispose()
    }
  })

  it("mounts multiple scoped instances on the same HttpRouter without collisions", async () => {
    const base = makeCounterView()
    const left = base.scope("left")
    const right = base.scope("right")

    expect(left.$.count.path).toBe("left.counter.count")
    expect(right.$.count.path).toBe("right.counter.count")
    expect(left.slots.display.id).toBe("left-counter-display")
    expect(right.slots.display.id).toBe("right-counter-display")
    expect(left.actions.inc.path).toBe("/left/counter/inc")
    expect(right.actions.inc.path).toBe("/right/counter/inc")
    expect(left.actions.inc.call().toExpr()).toBe(
      "@post('/left/counter/inc', {filterSignals: {include: /^(left\\.counter\\.count|left\\.counter\\.step)(\\.|$)/}})"
    )

    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.mergeAll(left.layer, right.layer).pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true }
    )

    try {
      const leftRes = await handler(
        new Request("http://localhost/left/counter/inc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ left: { counter: { count: 1, step: 2 } } })
        })
      )
      const leftBody = await leftRes.text()
      expect(leftBody).toContain('data: signals {"left":{"counter":{"count":3}}}')
      expect(leftBody).toContain('data: elements <span id="left-counter-display">3</span>')

      const rightRes = await handler(
        new Request("http://localhost/right/counter/inc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ right: { counter: { count: 100, step: 10 } } })
        })
      )
      const rightBody = await rightRes.text()
      expect(rightBody).toContain('data: signals {"right":{"counter":{"count":110}}}')
      expect(rightBody).toContain('data: elements <span id="right-counter-display">110</span>')
    } finally {
      await dispose()
    }
  })
})
