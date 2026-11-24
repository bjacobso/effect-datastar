import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Datastar from "../src/Datastar.ts"
import { Slot } from "../src/Slot.ts"

describe("Slot.make", () => {
  const banner = Slot.make("banner", (msg: string, id) => `<div id="${id}">${msg}</div>`)

  it("exposes id, selector, render, morph, inner, and remove", () => {
    expect(banner.id).toBe("banner")
    expect(banner.selector).toBe("#banner")
    expect(banner.render("hello")).toBe('<div id="banner">hello</div>')

    expect(banner.morph("hello")).toEqual(
      new Datastar.PatchElements({
        elements: '<div id="banner">hello</div>',
        selector: "#banner",
        mode: "outer"
      })
    )

    expect(banner.inner("hello")).toEqual(
      new Datastar.PatchElements({
        elements: '<div id="banner">hello</div>',
        selector: "#banner",
        mode: "inner"
      })
    )

    expect(banner.remove()).toEqual(
      new Datastar.PatchElements({
        elements: "",
        selector: "#banner",
        mode: "remove"
      })
    )
  })

  it("scopes id, selector, and rendered id without mutating original", () => {
    const scoped = banner.scope("dashboard")
    expect(scoped.id).toBe("dashboard-banner")
    expect(scoped.selector).toBe("#dashboard-banner")
    expect(scoped.render("hi")).toBe('<div id="dashboard-banner">hi</div>')
    expect(scoped.morph("hi").selector).toBe("#dashboard-banner")
    expect(banner.id).toBe("banner")
  })

  it.effect("encodes to valid Datastar SSE wire format", () =>
    Effect.gen(function*() {
      const morphSse = yield* Datastar.encodeEvent(banner.morph("ok"))
      expect(morphSse).toBe(
        'event: datastar-patch-elements\ndata: selector #banner\ndata: elements <div id="banner">ok</div>\n\n'
      )

      const removeSse = yield* Datastar.encodeEvent(banner.remove())
      expect(removeSse).toBe(
        "event: datastar-patch-elements\ndata: selector #banner\ndata: mode remove\n\n"
      )
    }))
})

describe("Slot.keyed", () => {
  interface Todo {
    readonly id: number
    readonly title: string
  }

  const todos = Slot.keyed(
    "todos",
    (t: Todo) => t.id,
    (t, itemId) => `<li id="${itemId}">${t.title}</li>`
  )

  it("exposes containerId, containerSelector, itemId, and item/container patch helpers", () => {
    expect(todos.containerId).toBe("todos")
    expect(todos.containerSelector).toBe("#todos")
    expect(todos.itemId(5)).toBe("todos-5")
    expect(todos.render({ id: 5, title: "Ship" })).toBe('<li id="todos-5">Ship</li>')

    expect(todos.morphItem({ id: 5, title: "Ship" })).toEqual(
      new Datastar.PatchElements({
        elements: '<li id="todos-5">Ship</li>',
        selector: "#todos-5",
        mode: "outer"
      })
    )

    expect(todos.prepend({ id: 5, title: "Ship" })).toEqual(
      new Datastar.PatchElements({
        elements: '<li id="todos-5">Ship</li>',
        selector: "#todos",
        mode: "prepend"
      })
    )

    expect(todos.append({ id: 5, title: "Ship" })).toEqual(
      new Datastar.PatchElements({
        elements: '<li id="todos-5">Ship</li>',
        selector: "#todos",
        mode: "append"
      })
    )

    expect(todos.removeItem(5)).toEqual(
      new Datastar.PatchElements({
        elements: "",
        selector: "#todos-5",
        mode: "remove"
      })
    )
  })

  it("scopes container and item ids cleanly", () => {
    const scoped = todos.scope("sidebar")
    expect(scoped.containerId).toBe("sidebar-todos")
    expect(scoped.containerSelector).toBe("#sidebar-todos")
    expect(scoped.itemId(5)).toBe("sidebar-todos-5")
    expect(scoped.morphItem({ id: 5, title: "Ship" })).toEqual(
      new Datastar.PatchElements({
        elements: '<li id="sidebar-todos-5">Ship</li>',
        selector: "#sidebar-todos-5",
        mode: "outer"
      })
    )
  })

  it("enforces prop and key types", () => {
    // @ts-expect-error - missing title
    void (() => todos.morphItem({ id: 1 }))
    // @ts-expect-error - key must be number
    void (() => todos.removeItem("wrong"))
    expect(true).toBe(true)
  })
})
