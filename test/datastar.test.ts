import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as ds from "../src/datastar/Attrs.ts"
import * as Datastar from "../src/datastar/Datastar.ts"
import * as Endpoint from "../src/datastar/Endpoint.ts"

describe("SSE encoding", () => {
  it.effect("patch-elements: one data line per HTML line, default mode omitted", () =>
    Effect.gen(function*() {
      const out = yield* Datastar.encodeEvent(Datastar.patchElements(`<div id="a">\n  hi\n</div>`))
      expect(out).toBe(
        "event: datastar-patch-elements\n" +
          "data: elements <div id=\"a\">\n" +
          "data: elements   hi\n" +
          "data: elements </div>\n\n"
      )
    }))

  it.effect("patch-elements: selector and mode", () =>
    Effect.gen(function*() {
      const out = yield* Datastar.encodeEvent(
        Datastar.patchElements("<p>x</p>", { selector: "#t", mode: "replace" })
      )
      expect(out).toBe("event: datastar-patch-elements\ndata: selector #t\ndata: mode replace\ndata: elements <p>x</p>\n\n")
    }))

  it.effect("patch-signals", () =>
    Effect.gen(function*() {
      const out = yield* Datastar.encodeEvent(Datastar.patchSignals({ a: { b: 1 } }, { onlyIfMissing: true }))
      expect(out).toBe("event: datastar-patch-signals\ndata: onlyIfMissing true\ndata: signals {\"a\":{\"b\":1}}\n\n")
    }))
})

describe("Attrs", () => {
  const sig = ds.make(Schema.Struct({ users: Schema.Struct({ query: Schema.Struct({ page: Schema.Number }) }) }))

  it("builds typed signal paths and refs", () => {
    expect(sig.path("users.query.page")).toBe("users.query.page")
    expect(sig.$("users.query")).toBe("$users.query")
    // @ts-expect-error - not a path in the signals schema
    sig.path("users.query.pag")
  })

  it("encodes modifiers into attribute names", () => {
    expect(ds.on("input", "x()", { debounce: "200ms", prevent: true })).toEqual({ "data-on:input__debounce.200ms__prevent": "x()" })
  })

  it("include regex matches the path and everything under it, nothing else", () => {
    const re = new RegExp(ds.includeRegex([sig.path("users.query")]).slice(1, -1))
    expect(re.test("users.query")).toBe(true)
    expect(re.test("users.query.page")).toBe(true)
    expect(re.test("users.queryx")).toBe(false)
    expect(re.test("users.draft")).toBe(false)
  })
})

describe("Endpoint.call", () => {
  const remove = Endpoint.make("DELETE", "/users/:id", Effect.succeed([]))
  const view = Endpoint.make("GET", "/users/view", Effect.succeed([]), { include: [ds.make(Schema.Struct({ users: Schema.Struct({ query: Schema.String }) })).path("users.query")] })

  it("fills typed path params", () => {
    expect(remove.call({ id: 42 })).toBe("@delete('/users/42')")
    expect(remove.call({ id: "a b" })).toBe("@delete('/users/a%20b')")
    // @ts-expect-error - missing required param
    remove.call({})
  })

  it("accepts client-side expressions as params", () => {
    expect(remove.call({ id: Endpoint.js("$users.draft.id") })).toBe("@delete('/users/' + encodeURIComponent($users.draft.id) + '')")
  })

  it("adds signal filters", () => {
    expect(view.call()).toBe("@get('/users/view', {filterSignals: {include: /^(users\\.query)(\\.|$)/}})")
  })
})
