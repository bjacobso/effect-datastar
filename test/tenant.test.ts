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

    const renamed = await acme.action("PUT", `/teams/${GLOBEX_TEAM}`, { teams: { draft: { id: GLOBEX_TEAM, name: "Hijacked" } } })
    expect(toasts(renamed.events)).toEqual(["That team no longer exists"])
    expect(toasts((await acme.action("DELETE", `/teams/${GLOBEX_TEAM}`)).events)).toEqual(["That team no longer exists"])
    expect((await api(globex, "GET", `/api/teams/${GLOBEX_TEAM}`)).body.name).toBe("Infrastructure")
  })

  it("an empty team of another organization can't be deleted either", async () => {
    const created = await api(globex, "POST", "/api/teams", { name: "Globex Empty" })
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
        filters: { name: "", email: "", role: "", active: "" },
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
      { members: { draft: { id: "", name: "Embedded Mole", email: "emole@example.com", role: "member", active: true } } }
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
      active: true
    })
    expect(put).toEqual({ status: 404, body: { _tag: "NotFound", message: `No user with id ${GLOBEX_USER}` } })
    expect((await api(acme, "DELETE", `/api/users/${GLOBEX_USER}`)).status).toBe(404)
    expect(await globexUser(GLOBEX_USER)).toEqual(before)
  })

  it("a reference to another organization's team is a 409", async () => {
    const body = { name: "Api Mole", email: "api.mole@example.com", role: "member", teamId: GLOBEX_TEAM, active: true }
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
      orgId: 2
    })
    expect(created.status).toBe(201)
    expect(created.body.orgId).toBe(1)
    expect((await api(globex, "GET", `/api/users/${created.body.id}`)).status).toBe(404)
  })

  it("uniqueness is per organization, so it reveals nothing about the other one", async () => {
    const acmeEmail = (await api(acme, "GET", "/api/users/87")).body.email
    const body = { name: "Same Email", email: acmeEmail, role: "member", teamId: null, active: true }
    expect((await api(globex, "POST", "/api/users", body)).status).toBe(201)
    expect((await api(globex, "POST", "/api/teams", { name: "Growth" })).status).toBe(201)
  })
})

describe("live updates", () => {
  it("another organization's changes never reach a stream, and don't wake it", async () => {
    const s = await acme.stream("/users/view", usersQuery())
    await s.until((e) => elements(e, "users-table") !== "")
    await api(globex, "POST", "/api/users", { name: "Globex Live", email: "globex.live@example.com", role: "member", teamId: null, active: true })
    await api(globex, "PUT", `/api/teams/${GLOBEX_TEAM}`, { name: "Infra Renamed" })
    expect(await s.collect(300)).toEqual([])

    // Its own organization's change still arrives.
    await api(acme, "POST", "/api/users", { name: "Acme Live", email: "acme.live@example.com", role: "member", teamId: null, active: true })
    const table = elements(await s.until((e) => elements(e, "users-table") !== ""), "users-table")
    await s.close()
    expect(rowNames(table)[0]).toBe("Acme Live")
    expect(table).not.toContain("Globex Live")
  })

  it("the live record of a row doesn't follow another organization's changes", async () => {
    const s = await acme.stream("/teams/2/view", {})
    await s.until((e) => elements(e, "teams-record") !== "")
    await api(globex, "PUT", `/api/teams/${GLOBEX_TEAM}`, { name: "Infra Again" })
    expect(await s.collect(300)).toEqual([])
    await s.close()
  })
})
