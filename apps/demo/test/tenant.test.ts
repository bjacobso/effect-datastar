/**
 * Organizations never see, edit, delete or reference each other's rows: every
 * path, as Acme (ada@acme.test) against Globex's rows and the other way round.
 *
 * Seeded: Acme has teams 1-3 (Platform, Growth, Design) and 52 users, Globex
 * teams 4-5 (Infrastructure, Support) and 35 users. User 3 and team 4 are
 * Globex's; user 87 and team 2 are Acme's.
 */
import { describe, expect, it } from "vitest"
import { decode, type Event, GLOBEX, makeApp, rowNames, userDraft, usersQuery } from "./support.ts"

const app = makeApp()
const acme = app
const globex = app.as(GLOBEX)

const GLOBEX_USER = 3
const GLOBEX_TEAM = 4

type Patch = Extract<Event, { type: "patch-elements" }>
const toasts = (events: Array<Event>) =>
  events.flatMap((e) => (e.type === "patch-elements" && e.selector === "#toast" ? [e.elements.replace(/<[^>]+>/g, "")] : []))
const signals = (events: Array<Event>) => events.flatMap((e) => (e.type === "patch-signals" ? [e.signals] : []))
const elements = (events: Array<Event>, id: string) =>
  events.find((e): e is Patch => e.type === "patch-elements" && e.elements.includes(`id="${id}"`))?.elements ?? ""
const total = (html: string) => Number(/(\d+) total/.exec(html)?.[1])
const ids = (html: string) => [...html.matchAll(/<tr id="(?:users|teams|members)-(\d+)"/g)].map((m) => Number(m[1]))

const api = async (client: Pick<typeof acme, "handler">, method: string, path: string, body?: unknown) => {
  const response = await client.handler(
    new Request(`http://test${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } })
    })
  )
  const text = await response.text()
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) }
}

/** Globex's view of a user (to check Acme changed nothing). */
const globexUser = async (id: number) => (await api(globex, "GET", `/api/users/${id}`)).body

describe("lists, counts and lookups", () => {
  it("each organization lists only its own users, with its own total", async () => {
    const [a, g] = await Promise.all([
      api(acme, "GET", "/api/users?pageSize=50&page=1"),
      api(globex, "GET", "/api/users?pageSize=50&page=1")
    ])
    expect(a.body.total).toBe(52)
    expect(g.body.total).toBe(35)
    expect(a.body.rows.every((r: { orgId: number }) => r.orgId === 1)).toBe(true)
    expect(g.body.rows.every((r: { orgId: number }) => r.orgId === 2)).toBe(true)
    const acmeIds = new Set(a.body.rows.map((r: { id: number }) => r.id))
    expect(g.body.rows.some((r: { id: number }) => acmeIds.has(r.id))).toBe(false)
  })

  it("the list page, live view and teams page show only the organization's rows", async () => {
    const page = await acme.page("/users?pageSize=50")
    expect(total(page)).toBe(52)
    expect(ids(page)).not.toContain(GLOBEX_USER)
    const teams = decode(await acme.page("/teams"))
    expect(rowNames(teams).sort()).toEqual(["Design", "Growth", "Platform"])

    const s = await globex.stream("/users/view", usersQuery({ pageSize: 50 }))
    const first = elements(await s.until((e) => elements(e, "users-table") !== ""), "users-table")
    await s.close()
    expect(total(first)).toBe(35)
    expect(ids(first)).not.toContain(87)
  })

  it("relation lookups (filter and form selects, table labels) offer only the organization's teams", async () => {
    const page = decode(await acme.page("/users"))
    expect(page).toContain(">Growth</option>")
    expect(page).not.toContain("Infrastructure")
    expect(page).not.toContain("Support")
    const globexPage = decode(await globex.page("/users"))
    expect(globexPage).toContain(">Infrastructure</option>")
    expect(globexPage).not.toContain(">Growth</option>")
  })

  it("the tenant column is not a column, filter or form field", async () => {
    const page = decode(await acme.page("/users"))
    expect(page).not.toContain("Organization")
    expect(page).not.toMatch(/users-(filter|field)-orgId/)
    expect(JSON.stringify((await acme.action("GET", "/users/87/edit")).events)).not.toContain("orgId")
  })

  it("a filter on the tenant column, in the URL or the API, is ignored", async () => {
    expect(total(await acme.page("/users?orgId=2"))).toBe(52)
    expect((await api(acme, "GET", "/api/users?orgId=2")).body.total).toBe(52)
  })
})

describe("guessing another organization's ids", () => {
  it("detail pages are 404s", async () => {
    expect((await acme.handler(new Request(`http://test/users/${GLOBEX_USER}`))).status).toBe(404)
    expect((await acme.handler(new Request(`http://test/teams/${GLOBEX_TEAM}`))).status).toBe(404)
    expect((await globex.handler(new Request("http://test/users/87"))).status).toBe(404)
    expect((await acme.handler(new Request("http://test/users/87"))).status).toBe(200)
  })

  it("the live record shows nothing", async () => {
    const s = await acme.stream(`/users/${GLOBEX_USER}/view`, {})
    const events = await s.until((e) => elements(e, "users-record") !== "")
    await s.close()
    const record = elements(events, "users-record")
    expect(record).toContain("This user no longer exists.")
    expect(record).not.toContain("@example.com")
  })

  it("edit, update and delete answer \"no longer exists\" and change nothing", async () => {
    const before = await globexUser(GLOBEX_USER)
    expect(toasts((await acme.action("GET", `/users/${GLOBEX_USER}/edit`)).events)).toEqual(["That user no longer exists"])
    const updated = await acme.action("PUT", `/users/${GLOBEX_USER}`, userDraft({ id: GLOBEX_USER, name: "Hijacked", email: "h@example.com" }))
    expect(toasts(updated.events)).toEqual(["That user no longer exists"])
    expect(toasts((await acme.action("DELETE", `/users/${GLOBEX_USER}`)).events)).toEqual(["That user no longer exists"])
    expect(await globexUser(GLOBEX_USER)).toEqual(before)

    const renamed = await acme.action("PUT", `/teams/${GLOBEX_TEAM}`, { teams: { draft: { id: GLOBEX_TEAM, name: "Hijacked", description: "" } } })
    expect(toasts(renamed.events)).toEqual(["That team no longer exists"])
    expect(toasts((await acme.action("DELETE", `/teams/${GLOBEX_TEAM}`)).events)).toEqual(["That team no longer exists"])
    expect((await api(globex, "GET", `/api/teams/${GLOBEX_TEAM}`)).body.name).toBe("Infrastructure")
  })

  it("an empty team of another organization can't be deleted either", async () => {
    const created = await api(globex, "POST", "/api/teams", { name: "Globex Empty", description: "" })
    expect(created.status).toBe(201)
    expect(toasts((await acme.action("DELETE", `/teams/${created.body.id}`)).events)).toEqual(["That team no longer exists"])
    expect((await api(acme, "DELETE", `/api/teams/${created.body.id}`)).status).toBe(404)
    expect((await api(globex, "GET", `/api/teams/${created.body.id}`)).status).toBe(200)
  })
})

describe("referencing another organization's rows", () => {
  it("a user draft with another organization's teamId is rejected (create)", async () => {
    const { events } = await acme.action("POST", "/users", userDraft({ name: "Mole", email: "mole@example.com", teamId: String(GLOBEX_TEAM) }))
    expect(signals(events)[0].users.errors.teamId).toBe("That team no longer exists")
    expect(total(await acme.page("/users?name=Mole"))).toBe(0)
    expect(total(await globex.page("/users?name=Mole"))).toBe(0)
  })

  it("a user draft with another organization's teamId is rejected (update)", async () => {
    const { events } = await acme.action("GET", "/users/87/edit")
    const draft = (events[0] as { signals: { users: { draft: Record<string, unknown> } } }).signals.users.draft
    const updated = await acme.action("PUT", "/users/87", userDraft({ ...draft, teamId: String(GLOBEX_TEAM) }))
    expect(signals(updated.events)[0].users.errors.teamId).toBe("That team no longer exists")
    expect((await api(acme, "GET", "/api/users/87")).body.teamId).not.toBe(GLOBEX_TEAM)
  })

  it("an orgId sent in a draft is ignored: the row goes to the signed-in organization", async () => {
    await acme.action("POST", "/users", userDraft({ name: "Planted", email: "planted@example.com", orgId: 2 }))
    expect(total(await acme.page("/users?name=Planted"))).toBe(1)
    expect(total(await globex.page("/users?name=Planted"))).toBe(0)
  })
})

describe("embeds (locked to a team) within the organization", () => {
  const members = (q: Record<string, unknown> = {}) => ({
    members: {
      query: {
        page: 1,
        pageSize: 10,
        sort: "createdAt",
        dir: "desc",
        filters: { name: "", email: "", role: "", active: "", tags: "", createdAtFrom: "", createdAtTo: "" },
        ...q
      }
    }
  })

  it("another organization's team as the embed scope shows no members", async () => {
    const s = await acme.stream(`/users/view?embed=members&scope=${GLOBEX_TEAM}`, members())
    const table = elements(await s.until((e) => elements(e, "members-table") !== ""), "members-table")
    await s.close()
    expect(total(table)).toBe(0)
    const own = await acme.stream("/users/view?embed=members&scope=2", members())
    const ownTable = elements(await own.until((e) => elements(e, "members-table") !== ""), "members-table")
    await own.close()
    expect(total(ownTable)).toBe(15)
  })

  it("creating into another organization's team through the embed is rejected", async () => {
    const { events } = await acme.action(
      "POST",
      `/users?embed=members&scope=${GLOBEX_TEAM}`,
      { members: { draft: { id: "", name: "Embedded Mole", email: "emole@example.com", role: "member", active: true, startDate: "", tags: [] } } }
    )
    expect(toasts(events)).toEqual(["That team no longer exists"])
    expect(total(await globex.page("/users?name=Embedded"))).toBe(0)
  })

  it("editing another organization's user through an embed of one's own team is rejected", async () => {
    const { events } = await acme.action("GET", `/users/${GLOBEX_USER}/edit?embed=members&scope=2`)
    expect(toasts(events)).toEqual(["That user no longer exists"])
  })
})

describe("JSON API", () => {
  it("get, update and delete of another organization's rows are 404s", async () => {
    const before = await globexUser(GLOBEX_USER)
    expect((await api(acme, "GET", `/api/users/${GLOBEX_USER}`)).status).toBe(404)
    expect((await api(acme, "GET", `/api/teams/${GLOBEX_TEAM}`)).status).toBe(404)
    const put = await api(acme, "PUT", `/api/users/${GLOBEX_USER}`, {
      name: "Hijacked",
      email: "hijacked@example.com",
      role: "admin",
      teamId: null,
      active: true,
      startDate: null,
      tags: []
    })
    expect(put).toEqual({ status: 404, body: { _tag: "NotFound", message: `No user with id ${GLOBEX_USER}` } })
    expect((await api(acme, "DELETE", `/api/users/${GLOBEX_USER}`)).status).toBe(404)
    expect(await globexUser(GLOBEX_USER)).toEqual(before)
  })

  it("a reference to another organization's team is a 409", async () => {
    const body = { name: "Api Mole", email: "api.mole@example.com", role: "member", teamId: GLOBEX_TEAM, active: true, startDate: null, tags: [] }
    expect(await api(acme, "POST", "/api/users", body)).toEqual({
      status: 409,
      body: { _tag: "Conflict", message: "That team no longer exists", fields: { teamId: "That team no longer exists" } }
    })
    expect((await api(acme, "PUT", "/api/users/87", body)).status).toBe(409)
  })

  it("an orgId in the body is ignored", async () => {
    const created = await api(acme, "POST", "/api/users", {
      name: "Api Planted",
      email: "api.planted@example.com",
      role: "member",
      teamId: null,
      active: true,
      startDate: null,
      tags: [],
      orgId: 2
    })
    expect(created.status).toBe(201)
    expect(created.body.orgId).toBe(1)
    expect((await api(globex, "GET", `/api/users/${created.body.id}`)).status).toBe(404)
  })

  it("uniqueness is per organization, so it reveals nothing about the other one", async () => {
    const acmeEmail = (await api(acme, "GET", "/api/users/87")).body.email
    const body = { name: "Same Email", email: acmeEmail, role: "member", teamId: null, active: true, startDate: null, tags: [] }
    expect((await api(globex, "POST", "/api/users", body)).status).toBe(201)
    expect((await api(globex, "POST", "/api/teams", { name: "Growth", description: "" })).status).toBe(201)
  })
})

describe("live updates", () => {
  it("another organization's changes never reach a stream, and don't wake it", async () => {
    const s = await acme.stream("/users/view", usersQuery())
    await s.until((e) => elements(e, "users-table") !== "")
    await api(globex, "POST", "/api/users", { name: "Globex Live", email: "globex.live@example.com", role: "member", teamId: null, active: true, startDate: null, tags: [] })
    await api(globex, "PUT", `/api/teams/${GLOBEX_TEAM}`, { name: "Infra Renamed", description: "" })
    expect(await s.collect(300)).toEqual([])

    // Its own organization's change still arrives.
    await api(acme, "POST", "/api/users", { name: "Acme Live", email: "acme.live@example.com", role: "member", teamId: null, active: true, startDate: null, tags: [] })
    const table = elements(await s.until((e) => elements(e, "users-table") !== ""), "users-table")
    await s.close()
    expect(rowNames(table)[0]).toBe("Acme Live")
    expect(table).not.toContain("Globex Live")
  })

  it("the live record of a row doesn't follow another organization's changes", async () => {
    const s = await acme.stream("/teams/2/view", {})
    await s.until((e) => elements(e, "teams-record") !== "")
    await api(globex, "PUT", `/api/teams/${GLOBEX_TEAM}`, { name: "Infra Again", description: "" })
    expect(await s.collect(300)).toEqual([])
    await s.close()
  })
})

describe("bulk actions", () => {
  // Globex's users 3 and 8 (both in its team 4); Acme's 85 and 86 (on page 1 of its list).
  const GLOBEX_USERS = [GLOBEX_USER, 8]
  const bulkSet = (client: typeof acme, selection: ReadonlyArray<number>, field: string, value: string, search = "") =>
    client.action("POST", `/users/bulk/update${search}`, { users: { selection, bulk: { field, value } } })
  const bulkDelete = (client: typeof acme, selection: ReadonlyArray<number>) =>
    client.action("POST", "/users/bulk/delete", { users: { selection } })
  const globexUsers = () => Promise.all(GLOBEX_USERS.map(globexUser))

  it("can't update another organization's rows: they no longer exist, and nothing changes there", async () => {
    const before = await globexUsers()
    expect(toasts((await bulkSet(acme, GLOBEX_USERS, "role", "admin")).events)).toEqual(["0 updated, 2 no longer exist"])
    // Mixed with one of its own: only that one is updated.
    const own = (await api(acme, "GET", "/api/users/85")).body
    const mixed = await bulkSet(acme, [85, ...GLOBEX_USERS], "role", own.role === "guest" ? "member" : "guest")
    expect(toasts(mixed.events)).toEqual(["1 updated, 2 no longer exist"])
    expect((await api(acme, "GET", "/api/users/85")).body.role).not.toBe(own.role)
    // Moving them to its own team doesn't pull them in either.
    expect(toasts((await bulkSet(acme, GLOBEX_USERS, "teamId", "2")).events)).toEqual(["0 updated, 2 no longer exist"])
    expect(await globexUsers()).toEqual(before)
  })

  it("can't delete another organization's rows", async () => {
    const before = await globexUsers()
    expect(toasts((await bulkDelete(acme, GLOBEX_USERS)).events)).toEqual(["0 deleted, 2 no longer exist"])
    const empty = await api(globex, "POST", "/api/teams", { name: "Globex Spare", description: "" })
    const teams = await acme.action("POST", "/teams/bulk/delete", { teams: { selection: [empty.body.id, GLOBEX_TEAM] } })
    expect(toasts(teams.events)).toEqual(["0 deleted, 2 no longer exist"])
    expect(await globexUsers()).toEqual(before)
    expect((await api(globex, "GET", `/api/teams/${empty.body.id}`)).status).toBe(200)
    expect((await api(globex, "GET", `/api/teams/${GLOBEX_TEAM}`)).status).toBe(200)
  })

  it("can't set a user's team to another organization's team", async () => {
    const before = (await api(acme, "GET", "/api/users/86")).body
    const { events } = await bulkSet(acme, [86, 85], "teamId", String(GLOBEX_TEAM))
    expect(toasts(events)).toEqual(["That team no longer exists"])
    expect((await api(acme, "GET", "/api/users/86")).body).toEqual(before)
    expect((await api(acme, "GET", "/api/users/85")).body.teamId).not.toBe(GLOBEX_TEAM)
  })

  it("an embed scoped to another organization's team touches nothing (tenant and lock together)", async () => {
    const before = await globexUsers()
    const search = `?embed=members&scope=${GLOBEX_TEAM}`
    const set = await acme.action("POST", `/users/bulk/update${search}`, {
      members: { selection: GLOBEX_USERS, bulk: { field: "role", value: "admin" } }
    })
    expect(toasts(set.events)).toEqual(["0 updated, 2 no longer exist"])
    const removed = await acme.action("POST", `/users/bulk/delete${search}`, { members: { selection: GLOBEX_USERS } })
    expect(toasts(removed.events)).toEqual(["0 deleted, 2 no longer exist"])
    expect(await globexUsers()).toEqual(before)
  })

  it("the tenant column can't be set in bulk", async () => {
    expect(toasts((await bulkSet(acme, [86], "orgId", "2")).events).map(decode)).toEqual(["orgId can't be set in bulk"])
    expect((await api(acme, "GET", "/api/users/86")).body.orgId).toBe(1)
  })

  it("bulk changes don't wake another organization's views, and reach their own once", async () => {
    const theirs = await globex.stream("/users/view", usersQuery())
    await theirs.until((e) => elements(e, "users-table") !== "")
    const ours = await acme.stream("/users/view", usersQuery())
    const [a, b] = ids(elements(await ours.until((e) => elements(e, "users-table") !== ""), "users-table"))

    // The role isn't sorted or filtered on here: Acme's view re-sends the two rows, once each, and nothing else.
    expect(toasts((await bulkSet(acme, [a!, b!], "role", "guest")).events)).toEqual(["2 updated"])
    const updated = await ours.until((e) => e.length >= 2, { settle: 300 })
    const sent = updated.map((e) => e.type === "patch-elements" ? /^<tr id="([^"]+)"/.exec(e.elements)?.[1] ?? "other" : e.type)
    expect(sent.sort()).toEqual([`users-${a}`, `users-${b}`].sort())

    // A bulk delete: Acme's view re-renders its table once.
    const created = await Promise.all(["Bulk A", "Bulk B"].map(async (name, i) =>
      (await api(acme, "POST", "/api/users", { name, email: `bulk.${i}@example.com`, role: "member", teamId: null, active: true, startDate: null, tags: [] }))
        .body.id as number
    ))
    await ours.until((e) => rowNames(elements(e, "users-table")).includes("Bulk B"), { settle: 300 })
    expect(toasts((await bulkDelete(acme, created)).events)).toEqual(["2 deleted"])
    const deleted = await ours.until((e) => elements(e, "users-table") !== "", { settle: 300 })
    expect(deleted.filter((e) => e.type === "patch-elements" && e.elements.includes(`id="users-table"`))).toHaveLength(1)
    expect(rowNames(elements(deleted, "users-table"))).not.toContain("Bulk A")
    await ours.close()

    // Globex's view was never woken: not by the bulk update, the inserts, or the bulk delete.
    expect(await theirs.collect(300)).toEqual([])
    await theirs.close()
  })
})

describe("tags (many-to-many) within the organization", () => {
  // Seeded: Acme's tags are 1-5 (Remote, On call, Mentor, New hire, Contractor), Globex's 6-8
  // (Remote in another color, Night shift, Lead). Both have a "Remote".
  const GLOBEX_TAG = 7
  const GLOBEX_REMOTE = 6
  const tagIds = (rows: ReadonlyArray<{ id: number }>) => rows.map((r) => r.id).sort((a, b) => a - b)
  const userBody = (overrides: Record<string, unknown>) => ({
    name: "Tag Mole",
    email: "tag.mole@example.com",
    role: "member",
    teamId: null,
    active: true,
    startDate: null,
    tags: [],
    ...overrides
  })

  it("each organization lists and looks up only its own tags", async () => {
    const [a, g] = await Promise.all([api(acme, "GET", "/api/tags?pageSize=50"), api(globex, "GET", "/api/tags?pageSize=50")])
    expect(tagIds(a.body.rows)).toEqual([1, 2, 3, 4, 5])
    expect(tagIds(g.body.rows)).toEqual([6, 7, 8])
    expect((await api(acme, "GET", `/api/tags/${GLOBEX_TAG}`)).status).toBe(404)
    expect((await acme.handler(new Request(`http://test/tags/${GLOBEX_TAG}`))).status).toBe(404)
    const tagsPage = decode(await acme.page("/tags"))
    expect(rowNames(tagsPage).sort()).toEqual(["Contractor", "Mentor", "New hire", "On call", "Remote"])
  })

  it("users' tags, chips, filter and form options never show another organization's tags, names or colors", async () => {
    const page = decode(await acme.page("/users?pageSize=50"))
    expect(page).toContain("Mentor")
    expect(page).not.toContain("Night shift")
    // Globex's "Remote" has its own color; Acme's chips and options only ever use Acme's.
    expect(page).not.toContain("#0891b2")
    expect(page).not.toContain("#be185d")
    const rows = (await api(acme, "GET", "/api/users?pageSize=50")).body.rows as Array<{ tags: Array<number> }>
    expect(rows.flatMap((r) => r.tags).every((t) => t >= 1 && t <= 5)).toBe(true)
    const globexRows = (await api(globex, "GET", "/api/users?pageSize=50")).body.rows as Array<{ tags: Array<number> }>
    expect(globexRows.flatMap((r) => r.tags).every((t) => t >= 6 && t <= 8)).toBe(true)
    // Filtering by another organization's tag finds nothing (it isn't one of Acme's tags).
    expect(total(await acme.page(`/users?tags=${GLOBEX_TAG}`))).toBe(0)
    expect((await api(acme, "GET", `/api/users?tags=${GLOBEX_TAG}`)).body.total).toBe(0)
  })

  it("saving a user with another organization's tag is a field error (create and update), and changes nothing", async () => {
    const created = await acme.action("POST", "/users", userDraft({ name: "Tag Mole", email: "tag.mole@example.com", tags: [String(GLOBEX_TAG)] }))
    expect(signals(created.events)[0].users.errors.tags).toBe("That tag no longer exists")
    expect(total(await acme.page("/users?name=Tag Mole"))).toBe(0)
    // Mixed with one of its own: still rejected as a whole.
    const mixed = await acme.action("POST", "/users", userDraft({ name: "Tag Mole", email: "tag.mole@example.com", tags: ["1", String(GLOBEX_REMOTE)] }))
    expect(signals(mixed.events)[0].users.errors.tags).toBe("That tag no longer exists")
    expect(total(await acme.page("/users?name=Tag Mole"))).toBe(0)

    const before = (await api(acme, "GET", "/api/users/87")).body
    const { events } = await acme.action("GET", "/users/87/edit")
    const draft = (events[0] as { signals: { users: { draft: Record<string, unknown> } } }).signals.users.draft
    const updated = await acme.action("PUT", "/users/87", userDraft({ ...draft, tags: ["1", String(GLOBEX_TAG)] }))
    expect(signals(updated.events)[0].users.errors.tags).toBe("That tag no longer exists")
    expect((await api(acme, "GET", "/api/users/87")).body).toEqual(before)
    // Globex's tag is untouched: it has no Acme user.
    expect((await api(globex, "GET", `/api/users?tags=${GLOBEX_TAG}&pageSize=50`)).body.rows
      .every((r: { orgId: number }) => r.orgId === 2)).toBe(true)
  })

  it("the API answers 409 for another organization's tag ids (create and update)", async () => {
    const conflict = {
      status: 409,
      body: { _tag: "Conflict", message: "That tag no longer exists", fields: { tags: "That tag no longer exists" } }
    }
    expect(await api(acme, "POST", "/api/users", userBody({ tags: [GLOBEX_TAG] }))).toEqual(conflict)
    expect(await api(acme, "POST", "/api/users", userBody({ tags: [2, GLOBEX_REMOTE] }))).toEqual(conflict)
    const before = (await api(acme, "GET", "/api/users/87")).body
    const { id: _, orgId: __, createdAt: ___, ...body } = before
    expect(await api(acme, "PUT", "/api/users/87", { ...body, tags: [GLOBEX_TAG] })).toEqual(conflict)
    expect((await api(acme, "GET", "/api/users/87")).body).toEqual(before)
    // Its own tags are fine.
    expect((await api(acme, "PUT", "/api/users/87", { ...body, tags: [1, 2] })).body.tags).toEqual([1, 2])
  })

  it("another organization's tags can't be renamed or deleted", async () => {
    const renamed = await acme.action("PUT", `/tags/${GLOBEX_TAG}`, { tags: { draft: { id: GLOBEX_TAG, name: "Hijacked", color: "#000000" } } })
    expect(toasts(renamed.events)).toEqual(["That tag no longer exists"])
    expect(toasts((await acme.action("DELETE", `/tags/${GLOBEX_TAG}`)).events)).toEqual(["That tag no longer exists"])
    expect(toasts((await acme.action("POST", "/tags/bulk/delete", { tags: { selection: [GLOBEX_TAG] } })).events))
      .toEqual(["0 deleted, 1 no longer exists"])
    expect((await api(globex, "GET", `/api/tags/${GLOBEX_TAG}`)).body.name).toBe("Night shift")
  })

  it("another organization's tag changes don't wake the users or tags views; one's own still update them", async () => {
    const users = await acme.stream("/users/view", usersQuery({ pageSize: 50 }))
    const first = elements(await users.until((e) => elements(e, "users-table") !== ""), "users-table")
    expect(decode(first)).toContain("Mentor")
    const tagsQuery = { tags: { query: { page: 1, pageSize: 10, sort: "name", dir: "asc", filters: { name: "" } } } }
    const tags = await acme.stream("/tags/view", tagsQuery)
    await tags.until((e) => elements(e, "tags-table") !== "")

    // Globex renames, recolors, creates and deletes its tags (one of them on its users).
    const lead = (await api(globex, "GET", "/api/tags/8")).body
    await api(globex, "PUT", "/api/tags/8", { name: "Team lead", color: "#ff0000" })
    await api(globex, "PUT", `/api/tags/${GLOBEX_REMOTE}`, { name: "Remote", color: "#00ff00" })
    const extra = await api(globex, "POST", "/api/tags", { name: "Globex extra", color: "#123456" })
    await api(globex, "DELETE", `/api/tags/${extra.body.id}`)
    await globex.action("POST", "/tags/bulk/delete", { tags: { selection: [8] } })
    expect(await users.collect(300)).toEqual([])
    expect(await tags.collect(100)).toEqual([])
    expect(lead.name).toBe("Lead")

    // Acme renames its own tag: its users view re-renders with the new name, its tags view too.
    await api(acme, "PUT", "/api/tags/3", { name: "Mentor (senior)", color: "#16a34a" })
    const table = elements(await users.until((e) => elements(e, "users-table") !== ""), "users-table")
    expect(decode(table)).toContain("Mentor (senior)")
    expect(decode(elements(await tags.until((e) => elements(e, "tags-table") !== ""), "tags-table"))).toContain("Mentor (senior)")
    await users.close()
    await tags.close()
  })
})
