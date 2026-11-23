/**
 * The real routes, in-process, against a seeded in-memory database
 * (87 users, 5 teams, every 6th user without a team).
 */
import { describe, expect, it } from "vitest"
import { makeApp, rowNames, userDraft, usersQuery, type Event } from "./support.ts"

const app = makeApp()

const toasts = (events: Array<Event>) =>
  events.flatMap((e) => (e.type === "patch-elements" && e.selector === "#toast" ? [e.elements.replace(/<[^>]+>/g, "")] : []))
const signals = (events: Array<Event>) => events.flatMap((e) => (e.type === "patch-signals" ? [e.signals] : []))
const table = (events: Array<Event>) =>
  events.find((e): e is Extract<Event, { type: "patch-elements" }> =>
    e.type === "patch-elements" && e.elements.includes(`id="users-table"`)
  )?.elements ?? ""
const total = (html: string) => Number(/(\d+) total/.exec(html)?.[1])

const hasTable = (events: Array<Event>) => table(events) !== ""
const hasAny = (events: Array<Event>) => events.length > 0

/** Open a users live view and return its first emission. */
const view = async (q: ReturnType<typeof usersQuery>, firstDone = hasTable) => {
  const s = await app.stream("/users/view", q)
  const first = await s.until(firstDone)
  return { ...s, first, next: () => s.until(hasTable) }
}

const decodeEntities = (s: string) => s.replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&")
const initialSignals = (html: string) => JSON.parse(decodeEntities(/data-signals="([^"]*)"/.exec(html)![1]!))

describe("pages", () => {
  it("server-renders the first page with team names and options", async () => {
    const html = await app.page("/users")
    expect(html).toContain("<!doctype html>")
    expect(html).toContain(`data-init="@get('/users/view'`)
    expect(total(html)).toBe(87)
    expect(rowNames(html)).toHaveLength(10)
    expect(html).toContain(`<option value="2">Growth</option>`)
    expect(initialSignals(html).users.query).toEqual(usersQuery().users.query)
  })

  it("renders the query from the URL into the table and the signals", async () => {
    const html = await app.page("/users?teamId=null&sort=name&dir=asc&pageSize=25")
    expect(total(html)).toBe(14)
    const names = rowNames(html)
    expect([...names].sort((a, b) => a!.localeCompare(b!))).toEqual(names)
    expect(initialSignals(html).users.query).toEqual(
      usersQuery({ sort: "name", dir: "asc", pageSize: 25 }, { teamId: "null" }).users.query
    )
  })

  it("clamps an out-of-range page from the URL", async () => {
    const html = await app.page("/users?page=99")
    expect(html).toContain("Page 9 of 9")
    expect(initialSignals(html).users.query.page).toBe(9)
  })

  it("falls back to defaults for invalid URL params", async () => {
    const html = await app.page("/users?sort=password&role=root")
    expect(total(html)).toBe(87)
    expect(initialSignals(html).users.query).toEqual(usersQuery().users.query)
  })

  it.each(["1.5", "abc"])("ignores a teamId filter the column's schema rejects (%s)", async (teamId) => {
    const html = await app.page(`/users?teamId=${teamId}`)
    expect(total(html)).toBe(87)
    expect(initialSignals(html).users.query).toEqual(usersQuery().users.query)
  })
})

describe("users live view", () => {
  it("renders the first page with team names and populates relation selects", async () => {
    const s = await view(usersQuery())
    await s.close()
    const html = table(s.first)
    expect(total(html)).toBe(87)
    expect(rowNames(html)).toHaveLength(10)
    expect(html).toContain("Page 1 of 9")
    const selects = s.first.filter((e) => e.type === "patch-elements" && e.mode === "replace" && e.selector !== "#toast")
    expect(selects.map((e) => (e as any).selector)).toEqual(["#users-filter-teamId", "#users-field-teamId"])
    expect((selects[0] as any).elements).toContain(">Growth</option>")
  })

  it("filters by relation, including IS NULL", async () => {
    const none = await view(usersQuery({}, { teamId: "null" }))
    await none.close()
    expect(total(table(none.first))).toBe(14)
    expect(table(none.first)).not.toContain("Growth")
  })

  it("sorts and pages", async () => {
    const s = await view(usersQuery({ sort: "name", dir: "asc", pageSize: 25, page: 2 }))
    await s.close()
    const names = rowNames(table(s.first))
    expect(names).toHaveLength(25)
    expect([...names].sort((a, b) => a!.localeCompare(b!))).toEqual(names)
    expect(table(s.first)).toContain("Page 2 of 4")
  })

  it("sends the canonical URL once per stream", async () => {
    const s = await view(usersQuery({ sort: "name", dir: "asc" }, { role: "admin" }))
    await s.close()
    expect(signals(s.first)).toEqual([{ users: { _url: "/users?role=admin&sort=name&dir=asc" } }])
  })

  it("clamps an out-of-range page by patching the query signal", async () => {
    const s = await view(usersQuery({ page: 99 }), hasAny)
    await s.close()
    expect(signals(s.first)).toEqual([{ users: { query: { page: 9 } } }])
  })

  it("rejects an invalid query with an error toast", async () => {
    const s = await view(usersQuery({ sort: "password" }), hasAny)
    await s.close()
    expect(toasts(s.first)).toEqual(["Something went wrong (SignalsError)"])
  })

  it.each(["1.5", "abc"])("rejects a teamId filter signal the column's schema rejects (%s)", async (teamId) => {
    const s = await view(usersQuery({}, { teamId }), hasAny)
    await s.close()
    expect(toasts(s.first)).toEqual(["Something went wrong (SignalsError)"])
  })

  it("re-renders when a user is created elsewhere", async () => {
    const s = await view(usersQuery({}, { name: "Zelda" }))
    expect(total(table(s.first))).toBe(0)
    await app.action("POST", "/users", userDraft({ name: "Zelda Live", email: "zelda.live@example.com" }))
    const next = await s.next()
    await s.close()
    expect(total(table(next))).toBe(1)
    expect(rowNames(table(next))).toEqual(["Zelda Live"])
    // Team options unchanged -> selects are not re-sent.
    expect(next.filter((e) => e.type === "patch-elements" && e.mode === "replace")).toEqual([])
  })

  it("re-renders team names and selects when a team is renamed", async () => {
    const s = await view(usersQuery({}, { teamId: "2" }))
    expect(table(s.first)).toContain("Growth")
    await app.action("PUT", "/teams/2", { teams: { draft: { id: 2, name: "Growth Eng" } } })
    const next = await s.next()
    await s.close()
    expect(table(next)).toContain("Growth Eng")
    const selects = next.filter((e) => e.type === "patch-elements" && e.mode === "replace")
    expect(selects).toHaveLength(2)
    await app.action("PUT", "/teams/2", { teams: { draft: { id: 2, name: "Growth" } } })
  })
})

describe("users mutations", () => {
  it("returns per-field errors for an invalid draft", async () => {
    const { events } = await app.action("POST", "/users", userDraft({ name: " ", email: "nope", role: "root" }))
    const [patch] = signals(events)
    expect(patch.users.errors).toMatchObject({ name: "Name is required", email: "Enter a valid email", teamId: "" })
    expect(patch.users.errors.role).not.toBe("")
  })

  it("creates, edits, updates and deletes", async () => {
    const created = await app.action("POST", "/users", userDraft({ name: "  Crud Person ", email: "crud@example.com", teamId: "3" }))
    expect(toasts(created.events)).toEqual(["Created Crud Person"])
    expect(signals(created.events)[0].users).toMatchObject({ dialog: false, draft: { id: "", name: "" } })

    const id = 88 + 1 // after the seeded 87 and Zelda
    const edit = await app.action("GET", `/users/${id}/edit`)
    expect(signals(edit.events)[0].users).toMatchObject({
      dialog: true,
      draft: { id, name: "Crud Person", email: "crud@example.com", teamId: "3", role: "member" }
    })

    const updated = await app.action("PUT", `/users/${id}`, userDraft({ name: "Crud Renamed", email: "crud@example.com", teamId: "" }))
    expect(toasts(updated.events)).toEqual(["Saved Crud Renamed"])
    const after = await app.action("GET", `/users/${id}/edit`)
    expect(signals(after.events)[0].users.draft).toMatchObject({ name: "Crud Renamed", teamId: "" })

    const removed = await app.action("DELETE", `/users/${id}`)
    expect(toasts(removed.events)).toEqual(["Deleted"])
    const gone = await app.action("GET", `/users/${id}/edit`)
    expect(toasts(gone.events)).toEqual(["That user no longer exists"])
  })

  it("maps a unique violation to the email field", async () => {
    const { events } = await app.action("POST", "/users", userDraft({ name: "Dup", email: "ada.lovelace0@example.com" }))
    expect(signals(events)[0].users.errors.email).toBe("Email is already taken")
  })

  it("maps a foreign key violation to the team field", async () => {
    const { events } = await app.action("POST", "/users", userDraft({ name: "Ghost", email: "ghost@example.com", teamId: "999" }))
    expect(signals(events)[0].users.errors.teamId).toBe("That team no longer exists")
  })

  it("rejects a malformed id", async () => {
    const { events } = await app.action("DELETE", "/users/abc")
    expect(toasts(events)).toEqual(["Something went wrong (SchemaError)"])
  })
})

describe("teams", () => {
  it("refuses to delete a team that has members", async () => {
    const { events } = await app.action("DELETE", "/teams/1")
    expect(toasts(events)).toEqual(["This team still has members. Move them first."])
  })

  it("maps a duplicate team name to the name field", async () => {
    const { events } = await app.action("POST", "/teams", { teams: { draft: { id: "", name: "Design" } } })
    expect(signals(events)[0].teams.errors.name).toBe("A team with that name already exists")
  })

  it("creates and deletes an empty team", async () => {
    const created = await app.action("POST", "/teams", { teams: { draft: { id: "", name: "Temp" } } })
    expect(toasts(created.events)).toEqual(["Created Temp"])
    const removed = await app.action("DELETE", "/teams/6")
    expect(toasts(removed.events)).toEqual(["Deleted"])
  })
})
