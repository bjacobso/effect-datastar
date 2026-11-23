/**
 * Tags (many-to-many) and dates through HTTP: the JSON API, the edit dialog's
 * draft, and live users views when a user's tags change or a tag is renamed
 * or deleted. Seeded in-memory app, signed in as Acme: its 52 users, teams 1-3 and tags 1-5
 * (see `tenant.test.ts` for tags across organizations).
 */
import { describe, expect, it } from "vitest"
import { type Event, makeApp, userDraft, usersQuery } from "./support.ts"

const app = makeApp()

const call = async (method: string, path: string, body?: unknown) => {
  const response = await app.handler(
    new Request(`http://test${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } })
    })
  )
  const text = await response.text()
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) }
}

const newUser = (overrides: Record<string, unknown> = {}) => ({
  name: "Tagged User",
  email: "tagged@example.com",
  role: "member",
  teamId: null,
  active: true,
  startDate: null,
  tags: [],
  ...overrides
})

type Patch = Extract<Event, { type: "patch-elements" }>
const patches = (events: Array<Event>) => events.filter((e): e is Patch => e.type === "patch-elements")
const tablePatch = (events: Array<Event>) => patches(events).find((e) => e.elements.includes(`id="users-table"`))
const rowPatches = (events: Array<Event>) => patches(events).filter((e) => e.elements.startsWith(`<tr id="users-`))
const replaced = (events: Array<Event>) => patches(events).filter((e) => e.mode === "replace").map((e) => e.selector)
const isTable = (events: Array<Event>) => tablePatch(events) !== undefined
const hasAny = (events: Array<Event>) => events.length > 0
/** The chip labels of each row of a rendered table or row. */
const chips = (html: string) => [...html.matchAll(/data-chip=""[^>]*>(?:<span[^>]*><\/span>)?([^<]*)</g)].map((m) => m[1])

const open = async (q: ReturnType<typeof usersQuery>) => {
  const s = await app.stream("/users/view", q)
  const first = await s.until(isTable)
  return { ...s, first: tablePatch(first)!.elements }
}

const draftOf = async (id: number): Promise<Record<string, unknown>> => {
  const { events } = await app.action("GET", `/users/${id}/edit`)
  return (events[0] as { signals: { users: { draft: Record<string, unknown> } } }).signals.users.draft
}

describe("JSON API with tags and dates", () => {
  it("reads and writes tags as an array of ids, and dates as ISO strings", async () => {
    const created = await call("POST", "/api/users", newUser({ tags: [3, 1], startDate: "2026-03-01" }))
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ tags: [1, 3], startDate: "2026-03-01" })
    const id = created.body.id

    expect((await call("GET", `/api/users/${id}`)).body).toMatchObject({ tags: [1, 3], startDate: "2026-03-01" })
    const updated = await call("PUT", `/api/users/${id}`, newUser({ tags: [2], startDate: null }))
    expect(updated.body).toMatchObject({ tags: [2], startDate: null })

    const tagged = await call("GET", "/api/users?tags=2&pageSize=50")
    expect(tagged.body.rows.every((r: { tags: Array<number> }) => r.tags.includes(2))).toBe(true)
    expect(tagged.body.rows.map((r: { id: number }) => r.id)).toContain(id)
    await call("DELETE", `/api/users/${id}`)
  })

  it("400s for bad tags or dates, 409s for a tag that doesn't exist", async () => {
    const bad = await call("POST", "/api/users", newUser({ tags: ["x"], startDate: "2026-02-30" }))
    expect(bad.status).toBe(400)
    expect(Object.keys(bad.body.fields).sort()).toEqual(["startDate", "tags"])
    const missing = await call("POST", "/api/users", newUser({ email: "ghost@example.com", tags: [999] }))
    expect(missing).toEqual({
      status: 409,
      body: { _tag: "Conflict", message: "That tag no longer exists", fields: { tags: "That tag no longer exists" } }
    })
    expect((await call("GET", "/api/users?email=ghost@example.com")).body.total).toBe(0)
  })

  it("filters by a created-at range, both ends inclusive", async () => {
    const all = (await call("GET", "/api/users?pageSize=50&sort=createdAt&dir=asc")).body
    const first = all.rows[0].createdAt.slice(0, 10)
    const day = (await call("GET", `/api/users?createdAtFrom=${first}&createdAtTo=${first}&pageSize=50`)).body
    expect(day.total).toBeGreaterThan(0)
    expect(day.rows.every((r: { createdAt: string }) => r.createdAt.startsWith(first))).toBe(true)
    expect((await call("GET", "/api/users?createdAtFrom=2999-01-01")).body.total).toBe(0)
    expect((await call("GET", "/api/users?createdAtTo=2026-13-01")).status).toBe(400)
  })

  it("serves tags as a resource of their own", async () => {
    const created = await call("POST", "/api/tags", { name: "Api Tag", color: "#123456" })
    expect(created).toMatchObject({ status: 201, body: { name: "Api Tag", color: "#123456" } })
    expect((await call("POST", "/api/tags", { name: "Bad", color: "red" })).status).toBe(400)
    expect((await call("DELETE", `/api/tags/${created.body.id}`)).status).toBe(204)
  })
})

describe("the edit dialog", () => {
  it("loads tags as strings (the multi-select's values) and saves them", async () => {
    const before = await call("GET", "/api/users/10")
    const draft = await draftOf(10)
    expect(draft["tags"]).toEqual(before.body.tags.map(String))
    const saved = await app.action("PUT", "/users/10", userDraft({ ...draft, tags: ["4", "2"], startDate: "2025-12-24" }))
    expect(saved.response.status).toBe(200)
    expect((await call("GET", "/api/users/10")).body).toMatchObject({ tags: [2, 4], startDate: "2025-12-24" })
  })

  it("shows a tag that no longer exists as a field error", async () => {
    const draft = await draftOf(11)
    const { events } = await app.action("PUT", "/users/11", userDraft({ ...draft, tags: ["999"] }))
    const errors = (events.find((e) => e.type === "patch-signals") as { signals: { users: { errors: Record<string, string> } } })
      .signals.users.errors
    expect(errors["tags"]).toBe("That tag no longer exists")
  })
})

describe("live users views and tags", () => {
  it("renders each user's tags as chips in their color", async () => {
    const s = await open(usersQuery())
    await s.close()
    const user87 = (await call("GET", "/api/users/87")).body
    const tagNames = new Map(
      ((await call("GET", "/api/tags?pageSize=50")).body.rows as Array<{ id: number; name: string }>).map((t) => [t.id, t.name])
    )
    const row = /<tr id="users-87".*?<\/tr>/.exec(s.first)![0]
    expect(chips(row).sort()).toEqual(user87.tags.map((t: number) => tagNames.get(t)).sort())
    expect(row).toMatch(/style="background-color:color-mix\(in srgb, #[0-9a-f]{6} 16%, transparent\)/)
  })

  it("a change to a visible user's tags is a single-row patch", async () => {
    const s = await open(usersQuery())
    const draft = await draftOf(87)
    await app.action("PUT", "/users/87", userDraft({ ...draft, tags: ["1"] }))
    const events = await s.until(hasAny)
    await s.close()
    expect(tablePatch(events)).toBeUndefined()
    const [row, ...others] = rowPatches(events)
    expect(others).toEqual([])
    expect(row!.elements).toMatch(/^<tr id="users-87"/)
    expect(chips(row!.elements)).toEqual(["Remote"])
  })

  it("a has-tag filter re-queries when tags change, since membership may change", async () => {
    const s = await open(usersQuery({}, { tags: "1" }))
    const draft = await draftOf(87)
    await app.action("PUT", "/users/87", userDraft({ ...draft, tags: ["2"] }))
    const events = await s.until(isTable)
    await s.close()
    expect(tablePatch(events)!.elements).not.toContain(`<tr id="users-87"`)
  })

  it("renaming or recoloring a tag re-renders the views that show it, and only re-sends selects elsewhere", async () => {
    // A fresh tag on user 5 only: on the tag-filtered view, not on the default first page.
    const tag = (await call("POST", "/api/tags", { name: "Rare", color: "#0ea5e9" })).body
    const user5 = (await call("GET", "/api/users/5")).body
    await call("PUT", "/api/users/5", { ...user5, id: undefined, createdAt: undefined, tags: [...user5.tags, tag.id] })

    const showing = await open(usersQuery({}, { tags: String(tag.id) }))
    const elsewhere = await open(usersQuery())
    expect(chips(showing.first)).toContain("Rare")
    expect(chips(elsewhere.first)).not.toContain("Rare")

    await app.action("PUT", `/tags/${tag.id}`, { tags: { draft: { id: tag.id, name: "Very Rare", color: "#f97316" } } })
    const shown = await showing.until(isTable)
    const other = await elsewhere.until(hasAny)
    expect(chips(tablePatch(shown)!.elements)).toContain("Very Rare")
    expect(tablePatch(shown)!.elements).toContain("#f97316")
    // The default page shows no "Rare" chip: its table is unchanged, so only the tag
    // selects (the filter and the dialog's multi-select) are re-sent, with the new name.
    expect(tablePatch(other)).toBeUndefined()
    expect(replaced(other)).toEqual(["#users-filter-tags", "#users-field-tags"])
    expect(patches(other).map((e) => e.elements).join()).toContain("Very Rare")

    // Deleting it removes its join rows (ON DELETE CASCADE): the filtered view re-queries, now empty.
    await call("DELETE", `/api/tags/${tag.id}`)
    const gone = await showing.until(isTable)
    await Promise.all([showing.close(), elsewhere.close()])
    expect(tablePatch(gone)!.elements).toContain("0 total")
    expect((await call("GET", "/api/users/5")).body.tags).toEqual(user5.tags)
  })
})
