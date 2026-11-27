/**
 * Role-Based Access Control (RBAC) across HTML views, Datastar actions,
 * shared live views, and the JSON API.
 *
 * Seeded Acme accounts:
 * - ada@acme.test   (admin)  — full access to Users, Teams, Tags
 * - grace@acme.test (member) — Users: read/create/update (no delete/bulk); Teams & Tags: read-only
 * - alan@acme.test  (viewer) — read-only on Users, Teams, Tags
 */
import { describe, expect, it } from "vitest"
import { ACME, ACME_2, decode, type Event, makeApp, userDraft, usersQuery } from "./support.ts"

const VIEWER = "alan@acme.test"

const app = makeApp()
const admin = app.as(ACME)
const member = app.as(ACME_2)
const viewer = app.as(VIEWER)

type Patch = Extract<Event, { type: "patch-elements" }>
const toasts = (events: Array<Event>) =>
  events.filter((e): e is Patch => e.type === "patch-elements" && e.selector === "#toast").map((e) => e.elements)
const tableOf = (events: Array<Event>) =>
  events.filter((e): e is Patch => e.type === "patch-elements").find((e) => e.elements.includes(`id="users-table"`))?.elements

const api = async (
  client: ReturnType<typeof app.as>,
  method: string,
  path: string,
  body?: unknown
) => {
  const response = await client.handler(
    new Request(`http://test${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } })
    })
  )
  const text = await response.text()
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) }
}

const newUser = (overrides: Record<string, unknown> = {}) => ({
  name: "Rbac User",
  email: "rbac.user@example.com",
  role: "member",
  teamId: 1,
  active: true,
  startDate: null,
  tags: [],
  ...overrides
})

describe("header role badge", () => {
  it("renders the signed-in account's role badge in the header", async () => {
    expect(decode(await admin.page("/users"))).toMatch(/id="account-role"[^>]*>.*admin/)
    expect(decode(await member.page("/users"))).toMatch(/id="account-role"[^>]*>.*member/)
    expect(decode(await viewer.page("/users"))).toMatch(/id="account-role"[^>]*>.*viewer/)
  })
})

describe("UI controls by role", () => {
  it("viewer sees read-only lists, detail pages, and embedded tables", async () => {
    const usersHtml = decode(await viewer.page("/users"))
    expect(usersHtml).not.toContain("New user")
    expect(usersHtml).not.toContain(`id="users-bulk"`)
    expect(usersHtml).not.toContain(`aria-label="Select all on this page"`)
    expect(usersHtml).not.toContain(`/edit`)
    expect(usersHtml).not.toContain(`@delete('/users/`)

    const userDetail = decode(await viewer.page("/users/1"))
    expect(userDetail).not.toContain(`/users/1/edit`)
    expect(userDetail).not.toContain(`@delete('/users/1`)

    const teamDetail = decode(await viewer.page("/teams/1"))
    expect(teamDetail).not.toContain(`/teams/1/edit`)
    expect(teamDetail).not.toContain(`@delete('/teams/1`)
    // Embedded Members table is also read-only for viewer
    expect(teamDetail).not.toContain("New user")
    expect(teamDetail).not.toContain(`id="members-bulk"`)
    expect(teamDetail).not.toContain(`/edit`)

    const tagsHtml = decode(await viewer.page("/tags"))
    expect(tagsHtml).not.toContain("New tag")
    expect(tagsHtml).not.toContain(`id="tags-bulk"`)
  })

  it("member sees create/edit on Users (no delete/bulk) and read-only on Teams and Tags", async () => {
    const usersHtml = decode(await member.page("/users"))
    expect(usersHtml).toContain("New user")
    expect(usersHtml).toContain(`/edit`)
    expect(usersHtml).not.toContain(`@delete('/users/`)
    expect(usersHtml).not.toContain(`id="users-bulk"`)
    expect(usersHtml).not.toContain(`aria-label="Select all on this page"`)

    const userDetail = decode(await member.page("/users/1"))
    expect(userDetail).toContain(`/users/1/edit`)
    expect(userDetail).not.toContain(`@delete('/users/1`)

    const teamsHtml = decode(await member.page("/teams"))
    expect(teamsHtml).not.toContain("New team")
    expect(teamsHtml).not.toContain(`/teams/1/edit`)
    expect(teamsHtml).not.toContain(`id="teams-bulk"`)

    // On Team detail: Team itself has no Edit/Delete, while embedded Members (Users) has New user & Edit (no Delete/bulk)
    const teamDetail = decode(await member.page("/teams/1"))
    expect(teamDetail).not.toContain(`/teams/1/edit`)
    expect(teamDetail).not.toContain(`@delete('/teams/1`)
    expect(teamDetail).toContain("New user")
    expect(teamDetail).toContain(`/users/`)
    expect(teamDetail).not.toContain(`id="members-bulk"`)

    const tagsHtml = decode(await member.page("/tags"))
    expect(tagsHtml).not.toContain("New tag")
    expect(tagsHtml).not.toContain(`id="tags-bulk"`)
  })

  it("admin sees all controls on Users, Teams, and Tags", async () => {
    const usersHtml = decode(await admin.page("/users"))
    expect(usersHtml).toContain("New user")
    expect(usersHtml).toContain(`id="users-bulk"`)
    expect(usersHtml).toContain(`/edit`)
    expect(usersHtml).toContain(`@delete('/users/`)

    const teamsHtml = decode(await admin.page("/teams"))
    expect(teamsHtml).toContain("New team")
    expect(teamsHtml).toContain(`id="teams-bulk"`)
  })
})

describe("Datastar HTML action enforcement", () => {
  it("blocks viewer from all mutations on Users, Teams, and Tags with an error toast", async () => {
    const createUser = await viewer.action("POST", "/users", userDraft({ name: "Sneaky Viewer", email: "sneaky.viewer@example.com" }))
    expect(toasts(createUser.events).join("")).toContain("Not allowed to create users")

    const editUser = await viewer.action("GET", "/users/1/edit")
    expect(toasts(editUser.events).join("")).toContain("Not allowed to update users")

    const updateUser = await viewer.action("PUT", "/users/1", userDraft({ id: "1", name: "Hacked", email: "hacked@example.com" }))
    expect(toasts(updateUser.events).join("")).toContain("Not allowed to update users")

    const deleteUser = await viewer.action("DELETE", "/users/1")
    expect(toasts(deleteUser.events).join("")).toContain("Not allowed to delete users")

    const bulkDel = await viewer.action("POST", "/users/bulk/delete", { users: { selection: [1] } })
    expect(toasts(bulkDel.events).join("")).toContain("Not allowed to bulk users")

    const bulkUpd = await viewer.action("POST", "/users/bulk/update", {
      users: { selection: [1], bulk: { field: "role", value: "admin" } }
    })
    expect(toasts(bulkUpd.events).join("")).toContain("Not allowed to bulk users")

    const createTeam = await viewer.action("POST", "/teams", { teams: { draft: { id: "", name: "Rogue Team", description: "" } } })
    expect(toasts(createTeam.events).join("")).toContain("Not allowed to create teams")

    const createTag = await viewer.action("POST", "/tags", { tags: { draft: { id: "", name: "Rogue Tag", color: "#000000" } } })
    expect(toasts(createTag.events).join("")).toContain("Not allowed to create tags")

    // Confirm nothing was created
    expect((await api(admin, "GET", "/api/users?email=sneaky.viewer@example.com")).body.total).toBe(0)
  })

  it("allows member to create/edit Users, but blocks delete/bulk on Users and all writes on Teams/Tags", async () => {
    const created = await member.action("POST", "/users", userDraft({ name: "Member Created", email: "member.created@example.com" }))
    expect(toasts(created.events).join("")).toContain("Created Member Created")

    const found = await api(member, "GET", "/api/users?email=member.created@example.com")
    expect(found.body.total).toBe(1)
    const id = found.body.rows[0].id as number

    const editRes = await member.action("GET", `/users/${id}/edit`)
    expect(editRes.events.some((e) => e.type === "patch-signals" && e.signals.users?.dialog === true)).toBe(true)

    const updated = await member.action("PUT", `/users/${id}`, userDraft({
      id: String(id),
      name: "Member Updated",
      email: "member.created@example.com"
    }))
    expect(toasts(updated.events).join("")).toContain("Saved Member Updated")

    const del = await member.action("DELETE", `/users/${id}`)
    expect(toasts(del.events).join("")).toContain("Not allowed to delete users")

    const bulkDel = await member.action("POST", "/users/bulk/delete", { users: { selection: [id] } })
    expect(toasts(bulkDel.events).join("")).toContain("Not allowed to bulk users")

    const bulkUpd = await member.action("POST", "/users/bulk/update", {
      users: { selection: [id], bulk: { field: "role", value: "admin" } }
    })
    expect(toasts(bulkUpd.events).join("")).toContain("Not allowed to bulk users")

    // Teams & Tags writes blocked for member
    const teamCreate = await member.action("POST", "/teams", { teams: { draft: { id: "", name: "Member Team", description: "" } } })
    expect(toasts(teamCreate.events).join("")).toContain("Not allowed to create teams")

    const tagCreate = await member.action("POST", "/tags", { tags: { draft: { id: "", name: "Member Tag", color: "#111111" } } })
    expect(toasts(tagCreate.events).join("")).toContain("Not allowed to create tags")

    // Admin cleans up the created user
    expect((await api(admin, "DELETE", `/api/users/${id}`)).status).toBe(204)
  })
})

describe("JSON API enforcement (403 Forbidden)", () => {
  it("viewer can read but gets 403 on create, update, delete across all resources", async () => {
    expect((await api(viewer, "GET", "/api/users")).status).toBe(200)
    expect((await api(viewer, "GET", "/api/teams")).status).toBe(200)
    expect((await api(viewer, "GET", "/api/tags")).status).toBe(200)

    const createUser = await api(viewer, "POST", "/api/users", newUser({ email: "v1@example.com" }))
    expect(createUser).toEqual({
      status: 403,
      body: { _tag: "Forbidden", message: "Not allowed to create users" }
    })

    const updateUser = await api(viewer, "PUT", "/api/users/1", newUser({ email: "v2@example.com" }))
    expect(updateUser.status).toBe(403)
    expect(updateUser.body._tag).toBe("Forbidden")

    const deleteUser = await api(viewer, "DELETE", "/api/users/1")
    expect(deleteUser.status).toBe(403)
    expect(deleteUser.body._tag).toBe("Forbidden")

    expect((await api(viewer, "POST", "/api/teams", { name: "No", description: "" })).status).toBe(403)
    expect((await api(viewer, "PUT", "/api/teams/1", { name: "No", description: "" })).status).toBe(403)
    expect((await api(viewer, "DELETE", "/api/teams/1")).status).toBe(403)

    expect((await api(viewer, "POST", "/api/tags", { name: "No", color: "#000000" })).status).toBe(403)
    expect((await api(viewer, "PUT", "/api/tags/1", { name: "No", color: "#000000" })).status).toBe(403)
    expect((await api(viewer, "DELETE", "/api/tags/1")).status).toBe(403)
  })

  it("member can create/update Users, gets 403 on delete Users and all writes on Teams/Tags", async () => {
    const created = await api(member, "POST", "/api/users", newUser({ email: "m.api@example.com", name: "Member Api" }))
    expect(created.status).toBe(201)
    const id = created.body.id as number

    const updated = await api(member, "PUT", `/api/users/${id}`, newUser({ email: "m.api@example.com", name: "Member Api 2" }))
    expect(updated.status).toBe(200)
    expect(updated.body.name).toBe("Member Api 2")

    const del = await api(member, "DELETE", `/api/users/${id}`)
    expect(del).toEqual({
      status: 403,
      body: { _tag: "Forbidden", message: "Not allowed to delete users" }
    })

    expect((await api(member, "POST", "/api/teams", { name: "Member Team", description: "" })).status).toBe(403)
    expect((await api(member, "PUT", "/api/teams/1", { name: "Renamed", description: "" })).status).toBe(403)
    expect((await api(member, "DELETE", "/api/teams/1")).status).toBe(403)

    expect((await api(member, "POST", "/api/tags", { name: "Member Tag", color: "#123456" })).status).toBe(403)
    expect((await api(member, "DELETE", "/api/tags/1")).status).toBe(403)

    // Admin can delete
    expect((await api(admin, "DELETE", `/api/users/${id}`)).status).toBe(204)
  })
})

describe("shared live views isolate rendered HTML by capabilities", () => {
  it("admin and viewer in the same org do not share rendered controls, and both receive live updates", async () => {
    const adminStream = await admin.stream("/users/view", usersQuery())
    const viewerStream = await viewer.stream("/users/view", usersQuery())
    const [adminInitial, viewerInitial] = await Promise.all([
      adminStream.until((e) => tableOf(e) !== undefined),
      viewerStream.until((e) => tableOf(e) !== undefined)
    ])

    const adminHtml = decode(tableOf(adminInitial)!)
    const viewerHtml = decode(tableOf(viewerInitial)!)
    expect(adminHtml).toContain(`id="users-bulk"`)
    expect(adminHtml).toContain(`@delete('/users/`)
    expect(viewerHtml).not.toContain(`id="users-bulk"`)
    expect(viewerHtml).not.toContain(`@delete('/users/`)
    expect(viewerHtml).not.toContain(`/edit`)

    const created = await api(admin, "POST", "/api/users", newUser({ name: "Live Rbac", email: "live.rbac@example.com" }))
    expect(created.status).toBe(201)

    const [adminNext, viewerNext] = await Promise.all([
      adminStream.until((e) => tableOf(e)?.includes("Live Rbac") === true),
      viewerStream.until((e) => tableOf(e)?.includes("Live Rbac") === true)
    ])
    expect(decode(tableOf(adminNext)!)).toContain(`@delete('/users/`)
    expect(decode(tableOf(viewerNext)!)).not.toContain(`@delete('/users/`)

    await Promise.all([adminStream.close(), viewerStream.close()])
    await api(admin, "DELETE", `/api/users/${created.body.id}`)
  })
})
