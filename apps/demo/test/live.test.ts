/**
 * Fine-grained live updates: which mutations patch a single row, which re-render
 * the whole table, and which are skipped. Seeded in-memory database: 87 users
 * (user 87 is the newest, so the first row of the default list), 5 teams, signed
 * in as Acme (52 of the users, teams 1-3).
 */
import { describe, expect, it } from "vitest"
import * as Repo from "@effect-datastar/crud/Repo.ts"
import { sqlLog } from "./sqlCounter.ts"
import { decode, type Event, makeApp, rowNames, userDraft, usersQuery } from "./support.ts"

const app = makeApp()

type Patch = Extract<Event, { type: "patch-elements" }>
const patches = (events: Array<Event>) => events.filter((e): e is Patch => e.type === "patch-elements")
const tablePatch = (events: Array<Event>) => patches(events).find((e) => e.elements.includes(`id="users-table"`))
const rowPatches = (events: Array<Event>) => patches(events).filter((e) => e.elements.startsWith(`<tr id="users-`))
const total = (html: string) => Number(/(\d+) total/.exec(html)?.[1])
const isTable = (events: Array<Event>) => tablePatch(events) !== undefined
const hasAny = (events: Array<Event>) => events.length > 0

const open = async (q: ReturnType<typeof usersQuery>) => {
  const s = await app.stream("/users/view", q)
  const first = await s.until(isTable)
  return { ...s, first: tablePatch(first)!.elements }
}

/** The user's current draft (as the edit dialog loads it). */
const draftOf = async (id: number): Promise<Record<string, unknown>> => {
  const { events } = await app.action("GET", `/users/${id}/edit`)
  return (events[0] as { signals: { users: { draft: Record<string, unknown> } } }).signals.users.draft
}
const save = async (id: number, changes: Record<string, unknown>) =>
  app.action("PUT", `/users/${id}`, userDraft({ ...(await draftOf(id)), ...changes }))

describe("Repo.plan", () => {
  const visible = new Set([1, 2])
  const columns = new Set(["createdAt", "role"])
  const update = (id: number, ...cols: Array<string>): Repo.Signal<number> => ({
    _tag: "Change",
    change: { _tag: "Update", id, columns: cols }
  })

  it("re-fetches visible rows whose changes can't move them", () => {
    expect(Repo.plan([update(1, "name"), update(2, "email"), update(1, "active")], visible, columns))
      .toEqual({ _tag: "Rows", ids: [1, 2] })
  })

  it("skips rows that aren't visible and can't become visible, and no-op updates", () => {
    expect(Repo.plan([update(9, "name"), update(1)], visible, columns)).toEqual({ _tag: "Skip" })
  })

  it("re-queries for sorted or filtered columns, inserts, deletes and foreign invalidations", () => {
    const requery = { _tag: "Requery", reason: "table" }
    expect(Repo.plan([update(1, "name"), update(9, "role")], visible, columns)).toEqual(requery)
    expect(Repo.plan([update(1, "createdAt")], visible, columns)).toEqual(requery)
    expect(Repo.plan([{ _tag: "Change", change: { _tag: "Insert", id: 3 } }], visible, columns)).toEqual(requery)
    expect(Repo.plan([{ _tag: "Change", change: { _tag: "Delete", id: 9 } }], visible, columns)).toEqual(requery)
    expect(Repo.plan([{ _tag: "Table" }], visible, columns)).toEqual(requery)
    expect(Repo.plan([update(1, "name"), { _tag: "Dependency" }], visible, columns))
      .toEqual({ _tag: "Requery", reason: "dependency" })
  })
})

describe("users live view, per change", () => {
  it("patches only the row when a visible user is renamed", async () => {
    const s = await open(usersQuery())
    expect(s.first).toContain(`<tr id="users-87"`)
    sqlLog.reset()
    await save(87, { name: "Renamed Live" })
    const events = await s.until(hasAny)
    const statements = sqlLog.statements
    await s.close()

    expect(tablePatch(events)).toBeUndefined()
    const [row, ...others] = rowPatches(events)
    expect(others).toEqual([])
    expect(patches(events)).toHaveLength(1)
    expect(row!.elements).toMatch(/^<tr id="users-87"[^>]*>(<td[^>]*><input[^>]*\/?><\/td>)<td[^>]*>(<span[^>]*>|<a [^>]*>)?Renamed Live</)
    // Patched by its id (default `outer` mode, no selector).
    expect(row!.selector).toBeUndefined()
    expect(row!.mode).toBeUndefined()
    // Team label and actions are rendered like in the full table.
    expect(row!.elements).toContain("Design")
    expect(decode(row!.elements)).toContain("@delete('/users/87'")
    // No page query, no COUNT: just the row.
    expect(statements.filter((q) => /COUNT\(\*\)/.test(q))).toEqual([])
  })

  it("re-renders the table when a sorted column changes", async () => {
    const s = await open(usersQuery({ sort: "name", dir: "asc" }))
    const [first] = rowNames(s.first)
    await save(87, { name: "Aaaa First" })
    const events = await s.until(isTable)
    await s.close()
    expect(rowNames(tablePatch(events)!.elements)[0]).toBe("Aaaa First")
    expect(rowNames(tablePatch(events)!.elements)[1]).toBe(first)
    expect(rowPatches(events)).toEqual([])
  })

  it("re-renders the table when a filtered column changes, moving a row out", async () => {
    const s = await open(usersQuery({}, { role: "member" }))
    const before = total(s.first)
    const target = Number(/<tr id="users-(\d+)"/.exec(s.first)![1])
    await save(target, { role: "guest" })
    const events = await s.until(isTable)
    await s.close()
    expect(total(tablePatch(events)!.elements)).toBe(before - 1)
    expect(tablePatch(events)!.elements).not.toContain(`<tr id="users-${target}"`)
  })

  it("re-renders the table when an off-page row moves into the filter", async () => {
    const s = await open(usersQuery({}, { role: "admin" }))
    const before = total(s.first)
    expect(s.first).not.toContain(`<tr id="users-2"`)
    expect((await draftOf(2)).role).not.toBe("admin")
    await save(2, { role: "admin" })
    // User 2 is old: it joins a later page, so this page's rows are the same and only
    // the pagination (the total) is sent.
    const events = await s.until((e) => patches(e).some((p) => p.elements.startsWith(`<nav id="users-pagination"`)))
    await s.close()
    expect(isTable(events)).toBe(false)
    expect(total(patches(events)[0]!.elements)).toBe(before + 1)
  })

  it("skips updates to off-page rows that can't enter the page", async () => {
    const s = await open(usersQuery())
    expect(s.first).not.toContain(`<tr id="users-1"`)
    await save(1, { name: "Not Shown", active: false })
    const events = await s.collect(200)
    await s.close()
    expect(events).toEqual([])
  })

  it("sends nothing for an update that changes nothing", async () => {
    const s = await open(usersQuery())
    await save(87, {})
    const events = await s.collect(200)
    await s.close()
    expect(events).toEqual([])
  })

  it("re-renders the table, with the new count, on insert", async () => {
    const s = await open(usersQuery())
    const before = total(s.first)
    await app.action("POST", "/users", userDraft({ name: "Inserted Live", email: "inserted.live@example.com" }))
    const events = await s.until(isTable)
    await s.close()
    const html = tablePatch(events)!.elements
    expect(total(html)).toBe(before + 1)
    expect(rowNames(html)[0]).toBe("Inserted Live")
    expect(rowPatches(events)).toEqual([])
  })

  it("re-renders the table, with the new count, on delete", async () => {
    const s = await open(usersQuery({ page: 6 }))
    const before = total(s.first)
    const target = Number(/<tr id="users-(\d+)"/.exec(s.first)![1])
    await app.action("DELETE", `/users/${target}`)
    const events = await s.until(isTable)
    await s.close()
    expect(total(tablePatch(events)!.elements)).toBe(before - 1)
    expect(tablePatch(events)!.elements).not.toContain(`<tr id="users-${target}"`)
  })

  it("re-renders users streams when a related team is renamed", async () => {
    const s = await open(usersQuery())
    expect(s.first).toContain("Design")
    await app.action("PUT", "/teams/3", { teams: { draft: { id: 3, name: "Design Ops", description: "" } } })
    const events = await s.until(isTable)
    await s.close()
    expect(tablePatch(events)!.elements).toContain("Design Ops")
    // Team options changed: relation selects are re-sent too.
    expect(patches(events).filter((e) => e.mode === "replace").map((e) => e.selector))
      .toEqual(["#users-filter-teamId", "#users-field-teamId"])
  })
})
