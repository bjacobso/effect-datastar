/**
 * Bulk actions over HTTP (`POST /users/bulk/update`, `POST /teams/bulk/delete`,
 * ...), against the seeded in-memory app: 87 users, 5 teams, every 6th user
 * without a team. Also: restoring the query for Back/Forward (`GET /users/query`).
 */
import { describe, expect, it } from "vitest"
import { decode, type Event, makeApp, usersQuery } from "./support.ts"

const app = makeApp()

const toasts = (events: Array<Event>) =>
  events.flatMap((e) => (e.type === "patch-elements" && e.selector === "#toast" ? [decode(e.elements.replace(/<[^>]+>/g, ""))] : []))
const signals = (events: Array<Event>) => events.flatMap((e) => (e.type === "patch-signals" ? [e.signals] : []))

const json = async (path: string) => (await app.handler(new Request(`http://test${path}`))).json()
const user = (id: number) => json(`/api/users/${id}`)
const usersIn = async (team: number | "null") =>
  ((await json(`/api/users?teamId=${team}&pageSize=50`)).rows as Array<{ id: number; role: string; teamId: number | null }>)

const setUsers = (selection: ReadonlyArray<unknown>, field: string, value: string, search = "") =>
  app.action("POST", `/users/bulk/update${search}`, { users: { selection, bulk: { field, value } } })
const deleteUsers = (selection: ReadonlyArray<unknown>, search = "") =>
  app.action("POST", `/users/bulk/delete${search}`, { users: { selection } })

describe("bulk update", () => {
  it("sets a field on every selected row, then clears the selection", async () => {
    const { events } = await setUsers([1, 2, 3], "role", "guest")
    expect(toasts(events)).toEqual(["3 updated"])
    expect(signals(events)).toEqual([{ users: { selection: [] } }])
    for (const id of [1, 2, 3]) expect((await user(id)).role).toBe("guest")
  })

  it("sets a relation, and clears it with null", async () => {
    expect(toasts((await setUsers([4, 5], "teamId", "3")).events)).toEqual(["2 updated"])
    expect((await user(4)).teamId).toBe(3)
    expect((await user(5)).teamId).toBe(3)
    expect(toasts((await setUsers([4], "teamId", "null")).events)).toEqual(["1 updated"])
    expect((await user(4)).teamId).toBeNull()
  })

  it("reports ids that no longer exist", async () => {
    const { events } = await setUsers([7, 9999], "role", "admin")
    expect(toasts(events)).toEqual(["1 updated, 1 no longer exists"])
    expect((await user(7)).role).toBe("admin")
    expect(toasts((await setUsers([9998, 9999], "role", "admin")).events)).toEqual(["0 updated, 2 no longer exist"])
  })

  it("validates the selection, the field and the value", async () => {
    expect(toasts((await setUsers([], "role", "admin")).events)).toEqual(["Select at least one row"])
    expect(toasts((await setUsers(["x"], "role", "admin")).events)).toEqual(["Select at least one row"])
    expect(toasts((await setUsers([1.5], "role", "admin")).events)).toEqual(["Select at least one row"])
    expect(toasts((await setUsers(Array.from({ length: 501 }, (_, i) => i + 1), "role", "admin")).events))
      .toEqual(["Select at least one row"])
    // Only the configured fields (`bulk.set`), and only valid values.
    expect(toasts((await setUsers([1], "email", "x@example.com")).events)).toEqual(["email can't be set in bulk"])
    expect(toasts((await setUsers([1], "role", "root")).events)).toEqual(["Invalid role"])
    expect(toasts((await setUsers([1], "teamId", "abc")).events)).toEqual(["Invalid team"])
    expect((await user(1)).role).toBe("guest")
  })

  it("rolls back entirely when the database rejects the value", async () => {
    const before = await Promise.all([10, 11].map(user))
    const { events } = await setUsers([10, 11], "teamId", "999")
    expect(toasts(events)).toEqual(["That team no longer exists"])
    expect(await Promise.all([10, 11].map(user))).toEqual(before)
  })
})

describe("bulk delete", () => {
  it("deletes the selection in one go", async () => {
    const created = await Promise.all(["Del A", "Del B"].map(async (name, i) => {
      const response = await app.handler(new Request("http://test/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email: `del${i}@example.com`, role: "member", teamId: null, active: true })
      }))
      return ((await response.json()) as { id: number }).id
    }))
    const { events } = await deleteUsers(created)
    expect(toasts(events)).toEqual(["2 deleted"])
    expect(signals(events)).toEqual([{ users: { selection: [] } }])
    for (const id of created) expect((await app.handler(new Request(`http://test/api/users/${id}`))).status).toBe(404)
  })

  it("reports what the database keeps, and keeps it selected", async () => {
    const ids = await Promise.all(["Spare 1", "Spare 2"].map(async (name) => {
      const response = await app.handler(new Request("http://test/api/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name })
      }))
      return ((await response.json()) as { id: number }).id
    }))
    const { events } = await app.action("POST", "/teams/bulk/delete", { teams: { selection: [...ids, 2] } })
    expect(toasts(events)).toEqual(["2 deleted, 1 has members"])
    expect(signals(events)).toEqual([{ teams: { selection: [2] } }])
    expect((await app.handler(new Request("http://test/api/teams/2"))).status).toBe(200)

    const all = await app.action("POST", "/teams/bulk/delete", { teams: { selection: [1, 2] } })
    expect(toasts(all.events)).toEqual(["0 deleted, 2 have members"])
  })
})

describe("in an embed", () => {
  it("only touches rows inside the lock", async () => {
    const [inside] = await usersIn(2)
    const [outside] = await usersIn(3)
    const search = "?embed=members&scope=2"
    const select = [inside!.id, outside!.id]

    const set = await app.action("POST", `/users/bulk/update${search}`, {
      members: { selection: select, bulk: { field: "role", value: "admin" } }
    })
    expect(toasts(set.events)).toEqual(["1 updated, 1 no longer exists"])
    expect(signals(set.events)).toEqual([{ members: { selection: [] } }])
    expect((await user(inside!.id)).role).toBe("admin")
    expect((await user(outside!.id)).role).toBe(outside!.role)

    // The locked field can't be set from the embed.
    const move = await app.action("POST", `/users/bulk/update${search}`, {
      members: { selection: [inside!.id], bulk: { field: "teamId", value: "3" } }
    })
    expect(toasts(move.events)).toEqual(["teamId can't be set in bulk"])
    expect((await user(inside!.id)).teamId).toBe(2)

    const removed = await app.action("POST", `/users/bulk/delete${search}`, { members: { selection: select } })
    expect(toasts(removed.events)).toEqual(["1 deleted, 1 no longer exists"])
    expect((await app.handler(new Request(`http://test/api/users/${inside!.id}`))).status).toBe(404)
    expect((await app.handler(new Request(`http://test/api/users/${outside!.id}`))).status).toBe(200)
  })

  it("rejects a bad scope", async () => {
    const { events } = await app.action("POST", "/users/bulk/delete?embed=members&scope=abc", {
      members: { selection: [1] }
    })
    expect(toasts(events)).toEqual(["Something went wrong (ScopeError)"])
    expect((await app.handler(new Request("http://test/api/users/1"))).status).toBe(200)
  })
})

describe("live views", () => {
  it("a bulk update reaches an open view once, as row patches", async () => {
    // The first two rows of the default list, and a team neither is in.
    const [a, b] = (await json("/api/users")).rows as Array<{ id: number; teamId: number | null }>
    const team = [1, 2, 3, 4, 5].find((t) => t !== a!.teamId && t !== b!.teamId)!
    const s = await app.stream("/users/view", usersQuery())
    await s.until((events) => events.some((e) => e.type === "patch-elements"), { settle: 100 })
    await setUsers([a!.id, b!.id, 5], "teamId", String(team))
    const events = await s.until((events) => events.length >= 2, { settle: 300 })
    await s.close()
    // The team isn't sorted or filtered on: the two visible rows are re-sent (user 5 isn't
    // on the page), and nothing else: no table, no second wake-up.
    const sent = events.map((e) => e.type === "patch-elements" ? /^<tr id="([^"]+)"/.exec(e.elements)?.[1] : e.type)
    expect(sent.sort()).toEqual([`users-${a!.id}`, `users-${b!.id}`].sort())
  })
})

describe("restoring a URL's query", () => {
  it("parses the URL as the page does", async () => {
    const { events } = await app.action("GET", "/users/query?teamId=3&sort=email&dir=asc&page=2&role=root")
    expect(signals(events)).toEqual([
      { users: { query: usersQuery({ sort: "email", dir: "asc", page: 2 }, { teamId: "3" }).users.query } }
    ])
    const plain = await app.action("GET", "/users/query")
    expect(signals(plain.events)).toEqual([{ users: { query: usersQuery().users.query } }])
  })
})
