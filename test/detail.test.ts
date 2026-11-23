/**
 * `GET /teams/:id`: the team's live record plus the users resource embedded as
 * "members", locked to `teamId = :id`. Seeded: team 2 (Growth) has 15 members.
 */
import { describe, expect, it } from "vitest"
import { type Event, makeApp, rowNames, usersQuery } from "./support.ts"

const app = makeApp()

const elements = (events: Array<Event>, id: string) =>
  events.find((e): e is Extract<Event, { type: "patch-elements" }> =>
    e.type === "patch-elements" && e.elements.includes(`id="${id}"`)
  )?.elements ?? ""
const toasts = (events: Array<Event>) =>
  events.flatMap((e) => (e.type === "patch-elements" && e.selector === "#toast" ? [e.elements.replace(/<[^>]+>/g, "")] : []))
const signals = (events: Array<Event>) => events.flatMap((e) => (e.type === "patch-signals" ? [e.signals] : []))
const total = (html: string) => Number(/(\d+) total/.exec(html)?.[1])
const decodeEntities = (s: string) => s.replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&")

/** Signals for the embedded members table (no `teamId` filter: it's locked). */
const membersQuery = (overrides: Record<string, unknown> = {}, filters: Record<string, string> = {}) => ({
  members: {
    query: {
      page: 1,
      pageSize: 10,
      sort: "createdAt",
      dir: "desc",
      filters: { name: "", email: "", role: "", active: "", ...filters },
      ...overrides
    }
  }
})
const memberDraft = (draft: Record<string, unknown>) => ({
  members: { draft: { id: "", name: "", email: "", role: "member", active: true, ...draft } }
})

const membersTable = (events: Array<Event>) => elements(events, "members-table")
const hasMembers = (events: Array<Event>) => membersTable(events) !== ""

const members = async (teamId: number | string, q: unknown, done: (e: Array<Event>) => boolean = hasMembers) => {
  const s = await app.stream(`/users/embed/members/${teamId}/view`, q)
  const first = await s.until(done)
  return { ...s, first, next: () => s.until(hasMembers) }
}

describe("team detail page", () => {
  it("renders the team and exactly its members", async () => {
    const html = await app.page("/teams/2")
    expect(html).toContain(`<h1>Growth</h1>`)
    expect(html).toContain(`data-init="@get('/teams/2/view'`)
    expect(html).toContain(`data-init="@get('/users/embed/members/2/view'`)
    expect(total(html)).toBe(15)

    // Same members as the users list filtered by team.
    const all = await app.page("/teams/2")
    const embedded = await members(2, membersQuery({ pageSize: 25, sort: "name", dir: "asc" }))
    await embedded.close()
    const users = await app.stream("/users/view", usersQuery({ pageSize: 25, sort: "name", dir: "asc" }, { teamId: "2" }))
    const usersFirst = await users.until((e) => elements(e, "users-table") !== "")
    await users.close()
    expect(rowNames(membersTable(embedded.first))).toEqual(rowNames(elements(usersFirst, "users-table")))
    expect(rowNames(all)).toHaveLength(10)
  })

  it("hides the locked column, filter and form field, and namespaces its signals", async () => {
    const html = await app.page("/teams/2")
    expect(html).not.toContain(`members-filter-teamId`)
    expect(html).not.toContain(`members-field-teamId`)
    expect(html).not.toContain(`>Team</`)
    const init = JSON.parse(decodeEntities(/data-signals="([^"]*)"/.exec(html)![1]!))
    expect(Object.keys(init)).toEqual(["members"])
    expect(init.members.query).toEqual(membersQuery().members.query)
  })

  it("does not touch the URL", async () => {
    const html = await app.page("/teams/2")
    expect(html).not.toContain("history.replaceState")
    const s = await members(2, membersQuery({ sort: "name", dir: "asc" }))
    await s.close()
    expect(signals(s.first)).toEqual([])
  })

  it("returns 404 for unknown and malformed ids", async () => {
    for (const path of ["/teams/999", "/teams/abc", "/teams/1.5"]) {
      const response = await app.handler(new Request(`http://test${path}`))
      expect(response.status, path).toBe(404)
      expect(await response.text()).toContain("There is no such team.")
    }
  })

  it("links team names to their detail pages, from teams and from users", async () => {
    expect(await app.page("/teams")).toContain(`<a href="/teams/2">Growth</a>`)
    expect(await app.page("/users?teamId=2")).toContain(`<a href="/teams/2">Growth</a>`)
  })
})

describe("locked filter", () => {
  it("rejects signals that try to override it", async () => {
    const s = await members(2, { members: { query: { ...membersQuery().members.query, filters: { ...membersQuery().members.query.filters, teamId: "3" } } } }, (e) => e.length > 0)
    await s.close()
    expect(toasts(s.first)).toEqual(["Something went wrong (SignalsError)"])
    expect(membersTable(s.first)).toBe("")
  })

  it("rejects a malformed scope", async () => {
    for (const scope of ["abc", "null", "1.5"]) {
      const s = await members(scope, membersQuery(), (e) => e.length > 0)
      await s.close()
      expect(toasts(s.first), scope).toEqual(["Something went wrong (ScopeError)"])
    }
  })

  it("other filters, sorting and paging still apply within the lock", async () => {
    const s = await members(2, membersQuery({ pageSize: 10, page: 2, sort: "name", dir: "asc" }))
    await s.close()
    expect(total(membersTable(s.first))).toBe(15)
    expect(membersTable(s.first)).toContain("Page 2 of 2")
    const names = rowNames(membersTable(s.first))
    expect(names).toHaveLength(5)
    expect([...names].sort((a, b) => a!.localeCompare(b!))).toEqual(names)
  })

  it("ignores a teamId in the draft and can't reach rows outside the lock", async () => {
    const created = await app.action("POST", "/users/embed/members/2", memberDraft({ name: "Sneaky", email: "sneaky@example.com", teamId: "3" }))
    expect(toasts(created.events)).toEqual(["Created Sneaky"])
    const s = await members(2, membersQuery({}, { name: "Sneaky" }))
    await s.close()
    expect(rowNames(membersTable(s.first))).toEqual(["Sneaky"])

    // User 2 is in team 3, not team 2.
    const edit = await app.action("GET", "/users/embed/members/2/2/edit")
    expect(toasts(edit.events)).toEqual(["That user no longer exists"])
    const update = await app.action("PUT", "/users/embed/members/2/2", memberDraft({ name: "Hijacked", email: "x@example.com" }))
    expect(toasts(update.events)).toEqual(["That user no longer exists"])
    const remove = await app.action("DELETE", "/users/embed/members/2/2")
    expect(toasts(remove.events)).toEqual(["That user no longer exists"])
    const user2 = await app.action("GET", "/users/2/edit")
    expect(signals(user2.events)[0].users.draft).toMatchObject({ teamId: "3" })
  })
})

describe("embedded mutations", () => {
  it("creating a member in the embedded view makes it appear, in that team", async () => {
    const s = await members(3, membersQuery())
    const before = total(membersTable(s.first))
    const created = await app.action("POST", "/users/embed/members/3", memberDraft({ name: "New Member", email: "new.member@example.com" }))
    expect(toasts(created.events)).toEqual(["Created New Member"])
    expect(signals(created.events)[0].members).toMatchObject({ dialog: false })
    const next = await s.next()
    await s.close()
    expect(total(membersTable(next))).toBe(before + 1)
    expect(rowNames(membersTable(next))[0]).toBe("New Member")

    const page = await app.page("/users?name=New+Member")
    expect(page).toContain(`<a href="/teams/3">Design</a>`)
  })

  it("edits within the lock keep the member in the team", async () => {
    const s = await members(3, membersQuery({}, { name: "New Member" }))
    await s.close()
    const id = /<tr id="members-(\d+)">/.exec(membersTable(s.first))![1]
    const edit = await app.action("GET", `/users/embed/members/3/${id}/edit`)
    expect(signals(edit.events)[0].members).toMatchObject({ dialog: true, draft: { id: Number(id), name: "New Member" } })
    const saved = await app.action("PUT", `/users/embed/members/3/${id}`, memberDraft({ name: "Renamed Member", email: "new.member@example.com" }))
    expect(toasts(saved.events)).toEqual(["Saved Renamed Member"])
    const user = await app.action("GET", `/users/${id}/edit`)
    expect(signals(user.events)[0].users.draft).toMatchObject({ name: "Renamed Member", teamId: "3" })
  })

  it("field errors are patched into the embed's namespace", async () => {
    const { events } = await app.action("POST", "/users/embed/members/3", memberDraft({ name: " ", email: "nope" }))
    expect(signals(events)[0].members.errors).toMatchObject({ name: "Name is required", email: "Enter a valid email" })
  })
})

describe("live record", () => {
  it("renaming the team updates the detail page", async () => {
    const s = await app.stream("/teams/2/view", {})
    const first = await s.until((e) => elements(e, "teams-record") !== "")
    expect(elements(first, "teams-record")).toContain("<h1>Growth</h1>")
    await app.action("PUT", "/teams/2", { teams: { draft: { id: 2, name: "Growth Eng" } } })
    const next = await s.until((e) => elements(e, "teams-record") !== "")
    await s.close()
    expect(elements(next, "teams-record")).toContain("<h1>Growth Eng</h1>")
    expect(await app.page("/teams/2")).toContain("<title>Growth Eng</title>")
    await app.action("PUT", "/teams/2", { teams: { draft: { id: 2, name: "Growth" } } })
  })

  it("shows a notice once the team is deleted", async () => {
    await app.action("POST", "/teams", { teams: { draft: { id: "", name: "Doomed" } } })
    const s = await app.stream("/teams/6/view", {})
    await s.until((e) => elements(e, "teams-record").includes("Doomed"))
    await app.action("DELETE", "/teams/6")
    const next = await s.until((e) => elements(e, "teams-record") !== "")
    await s.close()
    expect(elements(next, "teams-record")).toContain("This team no longer exists.")
  })
})
