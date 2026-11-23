/**
 * The JSON API generated from the resources (`src/crud/Api.ts`, mounted in
 * `src/app/Api.ts`), against the seeded in-memory app: 87 users, 5 teams.
 */
import { describe, expect, it } from "vitest"
import { type Event, makeApp, rowNames, usersQuery } from "./support.ts"

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
  name: "Api User",
  email: "api.user@example.com",
  role: "member",
  teamId: 2,
  active: true,
  ...overrides
})

describe("list", () => {
  it("pages with the defaults", async () => {
    const { body, status } = await call("GET", "/api/users")
    expect(status).toBe(200)
    expect(body).toMatchObject({ total: 87, page: 1, pages: 9 })
    expect(body.rows).toHaveLength(10)
    expect(body.rows[0]).toMatchObject({ id: 87, name: expect.any(String), createdAt: expect.any(String) })
  })

  it("takes the URL-state params", async () => {
    const { body } = await call("GET", "/api/users?role=admin&teamId=null&sort=name&dir=asc&pageSize=25")
    expect(body.rows.length).toBeGreaterThan(0)
    for (const row of body.rows) expect(row).toMatchObject({ role: "admin", teamId: null })
    const names = body.rows.map((r: { name: string }) => r.name)
    expect([...names].sort((a: string, b: string) => a.localeCompare(b))).toEqual(names)
  })

  it("rejects invalid params with a 400 per param, where the page would fall back to defaults", async () => {
    const { body, status } = await call("GET", "/api/users?teamId=1.5&sort=password&page=0")
    expect(status).toBe(400)
    expect(body._tag).toBe("ValidationError")
    expect(Object.keys(body.fields).sort()).toEqual(["page", "sort", "teamId"])
  })
})

describe("get", () => {
  it("returns a row by id", async () => {
    const { body, status } = await call("GET", "/api/teams/3")
    expect(status).toBe(200)
    expect(body).toMatchObject({ id: 3, name: "Design" })
  })

  it("404s for an unknown id and 400s for a malformed one", async () => {
    expect(await call("GET", "/api/teams/999")).toEqual({
      status: 404,
      body: { _tag: "NotFound", message: "No team with id 999" }
    })
    const malformed = await call("GET", "/api/teams/abc")
    expect(malformed.status).toBe(400)
    expect(malformed.body.fields).toHaveProperty("id")
  })
})

describe("create, update, delete", () => {
  it("creates (201), updates and deletes a row", async () => {
    const created = await call("POST", "/api/users", newUser({ email: "crud@example.com" }))
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ name: "Api User", teamId: 2, active: true })
    const id = created.body.id

    const updated = await call("PUT", `/api/users/${id}`, newUser({ email: "crud@example.com", name: "Renamed" }))
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({ id, name: "Renamed" })
    expect((await call("GET", `/api/users/${id}`)).body.name).toBe("Renamed")

    expect((await call("DELETE", `/api/users/${id}`)).status).toBe(204)
    expect((await call("GET", `/api/users/${id}`)).status).toBe(404)
    expect((await call("DELETE", `/api/users/${id}`)).status).toBe(404)
    expect((await call("PUT", `/api/users/${id}`, newUser())).status).toBe(404)
  })

  it("400s with every invalid field, with the model's messages", async () => {
    const { body, status } = await call("POST", "/api/users", newUser({ name: "  ", email: "nope", role: "root" }))
    expect(status).toBe(400)
    expect(body._tag).toBe("ValidationError")
    expect(body.fields).toMatchObject({ name: "Name is required", email: "Enter a valid email" })
    expect(body.fields).toHaveProperty("role")
  })

  it("409s for a unique violation, with the resource's message", async () => {
    const { body: existing } = await call("GET", "/api/users/1")
    const { body, status } = await call("POST", "/api/users", newUser({ email: existing.email }))
    expect(status).toBe(409)
    expect(body).toEqual({ _tag: "Conflict", message: "Email is already taken", fields: { email: "Email is already taken" } })
  })

  it("409s for a missing reference and for deleting a referenced row", async () => {
    const missing = await call("POST", "/api/users", newUser({ email: "fk@example.com", teamId: 999 }))
    expect(missing).toEqual({
      status: 409,
      body: { _tag: "Conflict", message: "That team no longer exists", fields: { teamId: "That team no longer exists" } }
    })
    const restricted = await call("DELETE", "/api/teams/2")
    expect(restricted).toEqual({
      status: 409,
      body: { _tag: "Conflict", message: "This team still has members. Move them first.", fields: {} }
    })
  })
})

describe("live views", () => {
  const isTable = (events: Array<Event>) =>
    events.some((e) => e.type === "patch-elements" && e.elements.includes(`id="users-table"`))

  it("an API create re-renders an open users live stream", async () => {
    const s = await app.stream("/users/view", usersQuery())
    await s.until(isTable)
    const created = await call("POST", "/api/users", newUser({ name: "Live From Api", email: "live.api@example.com" }))
    expect(created.status).toBe(201)
    const events = await s.until(isTable)
    await s.close()
    const table = events.find((e) => e.type === "patch-elements" && e.elements.includes(`id="users-table"`))
    expect(rowNames((table as { elements: string }).elements)[0]).toBe("Live From Api")
  })
})

describe("OpenAPI", () => {
  it("serves the spec with both resources", async () => {
    const { body, status } = await call("GET", "/api/openapi.json")
    expect(status).toBe(200)
    expect(Object.keys(body.paths).sort()).toEqual(["/api/teams", "/api/teams/{id}", "/api/users", "/api/users/{id}"])
    const list = body.paths["/api/users"].get
    expect(list.parameters.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(["page", "pageSize", "sort", "dir", "name", "email", "role", "teamId", "active"])
    )
    expect(Object.keys(body.paths["/api/users"].post.responses).sort()).toEqual(["201", "400", "409"])
  })

  it("serves the docs page", async () => {
    const response = await app.handler(new Request("http://test/api/docs"))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
  })
})
