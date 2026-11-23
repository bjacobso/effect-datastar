/**
 * React server rendering of Datastar markup: attribute names with `:`, `.` and `__` reach
 * the HTML unchanged, values survive React's escaping, and there are no hydration
 * markers for Datastar's morph to trip over.
 */
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ds from "@effect-datastar/datastar/Attrs.ts"
import { document, render } from "@effect-datastar/ui/Html.ts"
import * as Island from "@effect-datastar/ui/islands/Island.tsx"
import { Select } from "@effect-datastar/ui/islands/islands.tsx"
import { decode, makeApp } from "./support.ts"

/** The attributes of the first element in `html`, values decoded as a browser would. */
const attributes = (html: string): Record<string, string> => {
  const tag = /^<[^\s>]+([^>]*)>/.exec(html)![1]!
  return Object.fromEntries([...tag.matchAll(/\s([^\s=]+)="([^"]*)"/g)].map((m) => [m[1]!, decode(m[2]!)]))
}

const sig = ds.make(Schema.Struct({ users: Schema.Struct({ query: Schema.Struct({ page: Schema.Number }), name: Schema.String }) }))

describe("React SSR of Datastar attributes", () => {
  it("passes every helper's attribute through unchanged", () => {
    const attrs = ds.merge(
      ds.on("click", `$users.query.page > 1 && @get('/users/view', {filterSignals: {include: /^users\\.query/}})`),
      ds.on("input", "$users.query.page = 1", { debounce: "200ms", prevent: true }),
      ds.on("keydown", `evt.key === 'Escape' && ($users.dialog = false)`, { window: true }),
      ds.bind(sig.path("users.name")),
      sig.init({ users: { query: { page: 2 }, name: `O'Brien "<b>" & co` } }),
      ds.onSignalPatch("@get('/users/view')", { include: [sig.path("users.query")], debounce: "200ms" }),
      ds.attr("aria-invalid", "$users.name ? 'true' : 'false'"),
      ds.cls("active", "$users.query.page === 1"),
      ds.text("$users.name"),
      ds.effect("console.log($users.name)"),
      ds.indicator(sig.path("users.query")),
      ds.ignoreMorph()
    )
    const html = render(<div {...attrs} />)
    expect(attributes(html)).toEqual(attrs)
    expect(Object.keys(attributes(html))).toEqual(expect.arrayContaining([
      "data-on:click",
      "data-on:input__debounce.200ms__prevent",
      "data-on:keydown__window",
      "data-on-signal-patch__debounce.200ms",
      "data-on-signal-patch-filter",
      "data-attr:aria-invalid",
      "data-class:active"
    ]))
    expect(JSON.parse(attributes(html)["data-signals"]!).users.name).toBe(`O'Brien "<b>" & co`)
  })

  it("passes them through on components and custom elements too", () => {
    const attrs = ds.merge(ds.bind(sig.path("users.name")), ds.on("change", "$users.query.page = 1"))
    const html = render(<Island.Mount island={Select} props={{ options: [], label: "Team" }} attrs={attrs} />)
    expect(html).toMatch(/^<ds-island /)
    expect(attributes(html)).toMatchObject({ name: "select", props: `{"options":[],"label":"Team"}`, ...attrs })
  })

  it("emits no hydration markers between text nodes", () => {
    const page = 2
    expect(render(<span>Page {page} of {9}</span>)).toBe("<span>Page 2 of 9</span>")
    expect(document(<html><body>{page} total</body></html>)).toBe("<!doctype html><html><head></head><body>2 total</body></html>")
  })
})

describe("server-rendered pages", () => {
  const app = makeApp()

  it("have no comment nodes at all", async () => {
    for (const path of ["/users", "/teams", "/teams/2"]) expect(await app.page(path), path).not.toContain("<!--")
  })

  it("render the relation select as an island bound to the draft, with the lookup's options", async () => {
    const html = await app.page("/users")
    const host = /<ds-island[^>]*id="users-field-teamId"[^>]*>/.exec(html)![0]
    const attrs = attributes(host)
    expect(attrs).toMatchObject({ name: "select", "data-bind": "users.draft.teamId" })
    expect(attrs["data-attr:aria-invalid"]).toBe("$users.errors.teamId ? 'true' : 'false'")
    const props = JSON.parse(attrs["props"]!)
    expect(props.emptyLabel).toBe("No team")
    expect(props.options).toContainEqual({ value: "2", label: "Growth" })
  })

  it("render the dialog as an island driven by the dialog signal, with the form in its content holder", async () => {
    const html = await app.page("/users")
    const host = /<ds-island[^>]*id="users-dialog"[^>]*>/.exec(html)![0]
    expect(attributes(host)).toMatchObject({
      name: "dialog",
      "data-attr:open": "$users.dialog",
      "data-on:close": "$users.dialog = false"
    })
    // Live (hidden) markup, not a <template>: patches can reach the form before the island loads.
    const content = /<ds-island[^>]*id="users-dialog"[\s\S]*?<div data-island-content="" data-ignore-morph="" hidden="">([\s\S]*?)<\/form>/
      .exec(html)![1]!
    expect(content).toMatch(/^<form /)
    expect(content).toContain(`id="users-field-teamId"`)
  })
})

describe("island loaders", () => {
  it("has a browser loader for every island, loading that island", async () => {
    const { all } = await import("@effect-datastar/ui/islands/islands.tsx")
    const { loaders } = await import("@effect-datastar/ui/islands/loaders.ts")
    expect(Object.keys(loaders).sort()).toEqual(all.map((i) => i.name).sort())
    for (const island of all) expect(await loaders[island.name]!()).toBe(island)
  })
})
