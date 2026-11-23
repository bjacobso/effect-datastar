/**
 * `GET /teams/:id`: the team's live record plus the users resource embedded as
 * "members", locked to `teamId = :id`. Seeded: team 2 (Growth) has 15 members.
 */
import { describe, expect, it } from "vitest"
import { decode, type Event, initialSignals, makeApp, rowNames, usersQuery } from "./support.ts"

const app = makeApp()

const elements = (events: Array<Event>, id: string) =>
  events.find((e): e is Extract<Event, { type: "patch-elements" }> =>
    e.type === "patch-elements" && e.elements.includes(`id="${id}"`)
  )?.elements ?? ""
const toasts = (events: Array<Event>) =>
  events.flatMap((e) => (e.type === "patch-elements" && e.selector === "#toast" ? [e.elements.replace(/<[^>]+>/g, "")] : []))
const signals = (events: Array<Event>) => events.flatMap((e) => (e.type === "patch-signals" ? [e.signals] : []))
const total = (html: string) => Number(/(\d+) total/.exec(html)?.[1])

/** Signals for the embedded members table (no `teamId` filter: it's locked). */
const membersQuery = (overrides: Record<string, unknown> = {}, filters: Record<string, string> = {}) => ({
  members: {
    query: {
      page: 1,
      pageSize: 10,
      sort: "createdAt",
      dir: "desc",
      filters: { name: "", email: "", role: "", active: "", tags: "", createdAtFrom: "", createdAtTo: "", ...filters },
      ...overrides
    }
  }
})
const memberDraft = (draft: Record<string, unknown>) => ({
  members: { draft: { id: "", name: "", email: "", role: "member", active: true, startDate: "", tags: [], ...draft } }
})

const membersTable = (events: Array<Event>) => elements(events, "members-table")
const hasMembers = (events: Array<Event>) => membersTable(events) !== ""

const members = async (teamId: number | string, q: unknown, done: (e: Array<Event>) => boolean = hasMembers) => {
  const s = await app.stream(`/users/view?embed=members&scope=${teamId}`, q)
  const first = await s.until(done)
  return { ...s, first, next: () => s.until(hasMembers) }
}

describe("team detail page", () => {
  it("renders the team and exactly its members", async () => {
    const html = await app.page("/teams/2")
    expect(html).toMatch(/<h1[^>]*>Growth<\/h1>/)
    expect(decode(html)).toContain(`data-init="@get('/teams/2/view'`)
    expect(decode(html)).toContain(`data-init="@get('/users/view?embed=members&scope=2'`)
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
    const init = initialSignals(html)
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
    expect(await app.page("/teams")).toMatch(/<a href="\/teams\/2"[^>]*>Growth<\/a>/)
    expect(await app.page("/users?teamId=2")).toMatch(/<a href="\/teams\/2"[^>]*>Growth<\/a>/)
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
    const created = await app.action("POST", "/users?embed=members&scope=2", memberDraft({ name: "Sneaky", email: "sneaky@example.com", teamId: "3" }))
    expect(toasts(created.events)).toEqual(["Created Sneaky"])
    const s = await members(2, membersQuery({}, { name: "Sneaky" }))
    await s.close()
    expect(rowNames(membersTable(s.first))).toEqual(["Sneaky"])

    // User 2 is in team 3, not team 2.
    const edit = await app.action("GET", "/users/2/edit?embed=members&scope=2")
    expect(toasts(edit.events)).toEqual(["That user no longer exists"])
    const update = await app.action("PUT", "/users/2?embed=members&scope=2", memberDraft({ name: "Hijacked", email: "x@example.com" }))
    expect(toasts(update.events)).toEqual(["That user no longer exists"])
    const remove = await app.action("DELETE", "/users/2?embed=members&scope=2")
    expect(toasts(remove.events)).toEqual(["That user no longer exists"])
    const user2 = await app.action("GET", "/users/2/edit")
    expect(signals(user2.events)[0].users.draft).toMatchObject({ teamId: "3" })
  })
})

describe("embedded mutations", () => {
  it("creating a member in the embedded view makes it appear, in that team", async () => {
    const s = await members(3, membersQuery())
    const before = total(membersTable(s.first))
    const created = await app.action("POST", "/users?embed=members&scope=3", memberDraft({ name: "New Member", email: "new.member@example.com" }))
    expect(toasts(created.events)).toEqual(["Created New Member"])
    expect(signals(created.events)[0].members).toMatchObject({ dialog: false })
    const next = await s.next()
    await s.close()
    expect(total(membersTable(next))).toBe(before + 1)
    expect(rowNames(membersTable(next))[0]).toBe("New Member")

    const page = await app.page("/users?name=New+Member")
    expect(page).toMatch(/<a href="\/teams\/3"[^>]*>Design<\/a>/)
  })

  it("edits within the lock keep the member in the team", async () => {
    const s = await members(3, membersQuery({}, { name: "New Member" }))
    await s.close()
    const id = /<tr id="members-(\d+)"/.exec(membersTable(s.first))![1]
    const edit = await app.action("GET", `/users/${id}/edit?embed=members&scope=3`)
    expect(signals(edit.events)[0].members).toMatchObject({ dialog: true, draft: { id: Number(id), name: "New Member" } })
    const saved = await app.action("PUT", `/users/${id}?embed=members&scope=3`, memberDraft({ name: "Renamed Member", email: "new.member@example.com" }))
    expect(toasts(saved.events)).toEqual(["Saved Renamed Member"])
    const user = await app.action("GET", `/users/${id}/edit`)
    expect(signals(user.events)[0].users.draft).toMatchObject({ name: "Renamed Member", teamId: "3" })
  })

  it("field errors are patched into the embed's namespace", async () => {
    const { events } = await app.action("POST", "/users?embed=members&scope=3", memberDraft({ name: " ", email: "nope" }))
    expect(signals(events)[0].members.errors).toMatchObject({ name: "Name is required", email: "Enter a valid email" })
  })
})

describe("live record", () => {
  it("renaming the team updates the detail page", async () => {
    const s = await app.stream("/teams/2/view", {})
    const first = await s.until((e) => elements(e, "teams-record") !== "")
    expect(elements(first, "teams-record")).toMatch(/<h1[^>]*>Growth<\/h1>/)
    await app.action("PUT", "/teams/2", { teams: { draft: { id: 2, name: "Growth Eng", description: "" } } })
    const next = await s.until((e) => elements(e, "teams-record") !== "")
    await s.close()
    expect(elements(next, "teams-record")).toMatch(/<h1[^>]*>Growth Eng<\/h1>/)
    expect(await app.page("/teams/2")).toContain("<title>Growth Eng</title>")
    await app.action("PUT", "/teams/2", { teams: { draft: { id: 2, name: "Growth", description: "" } } })
  })

  it("shows a notice once the team is deleted", async () => {
    await app.action("POST", "/teams", { teams: { draft: { id: "", name: "Doomed", description: "" } } })
    const s = await app.stream("/teams/6/view", {})
    await s.until((e) => elements(e, "teams-record").includes("Doomed"))
    await app.action("DELETE", "/teams/6")
    const next = await s.until((e) => elements(e, "teams-record") !== "")
    await s.close()
    expect(elements(next, "teams-record")).toContain("This team no longer exists.")
  })
})

describe("editing on the detail page", () => {
  it("has Edit and Delete for the record, and the resource's own dialog", async () => {
    const raw = await app.page("/teams/2")
    const html = decode(raw)
    expect(html).toContain(`data-on:click="@get('/teams/2/edit'`)
    expect(html).toContain(`@delete('/teams/2?from=detail'`)
    expect(html).toContain(`id="teams-dialog"`)
    // The dialog's signals, without a query: there is no teams table on this page.
    const all = [...raw.matchAll(/data-signals="([^"]*)"/g)].map((m) => JSON.parse(decode(m[1]!)))
    expect(all.find((s) => "teams" in s)).toEqual({ teams: { draft: { id: "", name: "", description: "" }, errors: { name: "", description: "" }, dialog: false } })
  })

  it("edits through the dialog, with validation, and the live record follows", async () => {
    const s = await app.stream("/teams/4/view", {})
    await s.until((e) => elements(e, "teams-record") !== "")
    const edit = await app.action("GET", "/teams/4/edit")
    expect(signals(edit.events)[0].teams).toMatchObject({ dialog: true, draft: { id: 4 } })
    const name = signals(edit.events)[0].teams.draft.name

    const invalid = await app.action("PUT", "/teams/4", { teams: { draft: { id: 4, name: " ", description: "" } } })
    expect(signals(invalid.events)[0].teams.errors).toEqual({ name: "Name is required", description: "" })
    const taken = await app.action("PUT", "/teams/4", { teams: { draft: { id: 4, name: "Growth", description: "" } } })
    expect(signals(taken.events)[0].teams.errors).toEqual({ name: "A team with that name already exists", description: "" })

    const saved = await app.action("PUT", "/teams/4", { teams: { draft: { id: 4, name: "Renamed Here", description: "" } } })
    expect(toasts(saved.events)).toEqual(["Saved Renamed Here"])
    expect(signals(saved.events)[0].teams).toMatchObject({ dialog: false })
    const next = await s.until((e) => elements(e, "teams-record").includes("Renamed Here"))
    await s.close()
    expect(decode(elements(next, "teams-record"))).toContain(`@delete('/teams/4?from=detail'`)
    await app.action("PUT", "/teams/4", { teams: { draft: { id: 4, name, description: "" } } })
  })

  it("delete goes back to the list; a restricted delete stays, with a toast", async () => {
    await app.action("POST", "/teams", { teams: { draft: { id: "", name: "Short Lived", description: "" } } })
    const id = /\/teams\/(\d+)"[^>]*>Short Lived</.exec(await app.page("/teams?name=Short"))![1]
    const deleted = await app.action("DELETE", `/teams/${id}?from=detail`)
    expect(deleted.events).toEqual([{
      type: "patch-elements",
      selector: "body",
      mode: "append",
      elements: `<script data-effect="el.remove()">window.location.assign("/teams")</script>`
    }])
    expect((await app.handler(new Request(`http://test/teams/${id}`))).status).toBe(404)

    const restricted = await app.action("DELETE", "/teams/2?from=detail")
    expect(toasts(restricted.events)).toEqual(["This team still has members. Move them first."])
    expect(restricted.events.some((e) => e.type === "patch-elements" && e.selector === "body")).toBe(false)

    // From the list (no `from=detail`), a delete just toasts.
    await app.action("POST", "/teams", { teams: { draft: { id: "", name: "Listed", description: "" } } })
    const listed = /\/teams\/(\d+)"[^>]*>Listed</.exec(await app.page("/teams?name=Listed"))![1]
    expect(toasts((await app.action("DELETE", `/teams/${listed}`)).events)).toEqual(["Deleted"])
  })

  it("a user's page edits the team through the relation select, which stays live", async () => {
    const html = decode(await app.page("/users/1"))
    expect(html).toContain(`@get('/users/1/edit'`)
    expect(html).toContain(`id="users-field-teamId"`)
    expect(html).toContain(`"label":"Growth"`)

    const s = await app.stream("/users/1/view", {})
    await s.until((e) => elements(e, "users-record") !== "")
    await app.action("PUT", "/teams/2", { teams: { draft: { id: 2, name: "Growth Team", description: "" } } })
    const select = (events: Array<Event>) =>
      events.flatMap((e) => (e.type === "patch-elements" && e.selector === "#users-field-teamId" ? [e.elements] : []))
    const next = await s.until((events) => select(events).length > 0)
    await s.close()
    expect(decode(select(next)[0]!)).toContain(`"label":"Growth Team"`)
    await app.action("PUT", "/teams/2", { teams: { draft: { id: 2, name: "Growth", description: "" } } })
  })
})

describe("shared routes", () => {
  it("an embed uses its resource's routes; there are no per-embed routes", async () => {
    expect((await app.handler(new Request("http://test/users/embed/members/2/view"))).status).toBe(404)
  })

  it("rejects an unknown embed, a scope without an embed, and an embed without a scope", async () => {
    for (const search of ["embed=nope&scope=2", "scope=2", "embed=members"]) {
      const s = await app.stream(`/users/view?${search}`, membersQuery())
      const first = await s.until((e) => e.length > 0)
      await s.close()
      expect(toasts(first), search).toEqual(["Something went wrong (ScopeError)"])
      const created = await app.action("POST", `/users?${search}`, memberDraft({ name: "Nobody", email: "nobody@example.com" }))
      expect(toasts(created.events), search).toEqual(["Something went wrong (ScopeError)"])
    }
    expect(await app.page("/users?name=Nobody")).not.toContain(">Nobody<")
  })
})
