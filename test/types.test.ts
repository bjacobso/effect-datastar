/**
 * Compile-time checks of `Resource.define` / `Resource.app`: `npm run typecheck`
 * fails if an `@ts-expect-error` below stops being an error. Each negative case
 * has a positive twin, so the errors come from the mistake and nothing else.
 */
import { NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { Reactivity } from "effect/reactivity"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Resources } from "../src/app/Resources.ts"
import { Tags } from "../src/app/Tags.tsx"
import { Teams } from "../src/app/Teams.tsx"
import { Users } from "../src/app/Users.tsx"
import * as Db from "../src/app/Db.ts"
import { Shell } from "../src/app/Layout.tsx"
import { Team } from "../src/app/Team.ts"
import { CurrentOrg, CurrentUser, Sessions } from "../src/auth/Auth.ts"
import { RequireSession } from "../src/auth/Middleware.ts"
import * as Resource from "../src/crud/Resource.tsx"

/** Type-checked, never run: serve `routes` with `services` provided. */
const serve = <R,>(
  routes: Layer.Layer<never, unknown, HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", R>>,
  services: Layer.Layer<R, unknown, never>
) => () => HttpRouter.toWebHandler(routes.pipe(Layer.provide(services), Layer.provide(HttpServer.layerServices), Layer.provide(NodeServices.layer)))

type Requirements<L> = L extends Layer.Layer<infer _A, infer _E, infer R> ? R : never

const infra = Layer.mergeAll(Reactivity.layer, Db.layer({ filename: ":memory:" }))

/** The session middleware, ready to provide to routes. */
const session = RequireSession.layer.pipe(Layer.provide(Sessions.layer), Layer.provide(infra))
const signedIn = Resources.routes.pipe(Layer.provide(session))

describe("Resource types", () => {
  it("routes require every resource's services", () => {
    serve(signedIn, Resources.layer.pipe(Layer.provideMerge(Reactivity.layer), Layer.provide(infra)))
    // @ts-expect-error: no `LookupOf<"teams">` / `RepoOf<"teams">` (the teams layer is missing)
    serve(signedIn, Users.layer.pipe(Layer.provideMerge(Reactivity.layer), Layer.provide(infra)))
    expectTypeOf(Resources.layer).toEqualTypeOf<
      Layer.Layer<
        Resource.ServicesOf<"users" | "teams" | "tags">,
        never,
        import("effect/sql").SqlClient.SqlClient | Reactivity.Reactivity
      >
    >()
  })

  it("tenant-scoped routes require the tenant service (from the session middleware)", () => {
    const services = Resources.layer.pipe(Layer.provideMerge(Reactivity.layer), Layer.provide(infra))
    // @ts-expect-error: `CurrentOrg` (and the layout's `CurrentUser`) are request-level: only middleware provides them
    serve(Resources.routes, services)
    expectTypeOf<HttpRouter.Request.From<"Requires", CurrentOrg>>().toExtend<Requirements<typeof Resources.routes>>()
    // Unscoped and without an effectful layout: no tenant service.
    const Plain = Resource.define({
      name: "plain",
      title: "Plain",
      noun: "plain",
      model: Team,
      idColumn: "id",
      display: "name",
      query: { sortable: ["name"], filters: {}, defaultSort: ["name", "asc"], pageSizes: [10] },
      layout: Shell
    })
    const plainApp = () => Resource.app(Plain)
    expectTypeOf<HttpRouter.Request.From<"Requires", CurrentOrg>>().not.toExtend<
      Requirements<ReturnType<typeof plainApp>["routes"]>
    >()
  })

  it("the tenant option names a model column whose values are the service's ids", () => {
    const config = {
      name: "scoped",
      title: "Scoped",
      noun: "scoped",
      model: Team,
      idColumn: "id",
      display: "name",
      query: { sortable: ["name"], filters: {}, defaultSort: ["name", "asc"], pageSizes: [10] },
      layout: Shell
    } as const
    Resource.define({ ...config, tenant: { column: "orgId", service: CurrentOrg } })
    // @ts-expect-error: `CurrentUser["id"]` is an account id, not an organization id
    Resource.define({ ...config, tenant: { column: "orgId", service: CurrentUser } })
    // Type-checked only (it would throw: there is no such field).
    const noColumn = () =>
      // @ts-expect-error: `nope` is not a column
      Resource.define({ ...config, tenant: { column: "nope", service: CurrentOrg } })
    expect(noColumn).toThrow()
  })

  it("an app must include every resource its relations and embeds name", () => {
    const ok = () => Resource.app(Users.with({ relations: { teamId: Teams } }), Teams)
    // @ts-expect-error: users' `teamId` relation needs teams in the app
    const noTeams = () => Resource.app(Users.with({ relations: { teamId: Teams } }))
    // @ts-expect-error: the teams page embeds users, so users must be in the app
    const noUsers = () => Resource.app(Teams.with({ sections: [Users.embed({ name: "members", title: "Members", lock: "teamId" })] }))
    expect([ok, noTeams, noUsers]).toHaveLength(3)
  })

  it("an embed locks an `eq` filter whose values are the parent's ids", () => {
    Users.embed({ name: "members", title: "Members", lock: "teamId" })
    Teams.with({ sections: [Users.embed({ name: "members", title: "Members", lock: "teamId" })] })
    // @ts-expect-error: `name` is a `contains` filter
    Users.embed({ name: "x", title: "X", lock: "name" })
    // @ts-expect-error: `createdAt` is not a filter
    Users.embed({ name: "x", title: "X", lock: "createdAt" })
    // @ts-expect-error: `role` is an `eq` filter, but a team id is not a role
    Teams.with({ sections: [Users.embed({ name: "x", title: "X", lock: "role" })] })
    // @ts-expect-error: a user's page can't lock users by team to the user's id
    Users.with({ sections: [Users.embed({ name: "x", title: "X", lock: "teamId" })] })
  })

  it("many-to-many: the target must be in the app, and the field must hold its ids", () => {
    const ok = () => Resource.app(Users.with({ relations: { teamId: Teams }, manyToMany: { tags: Tags } }), Teams, Tags)
    // @ts-expect-error: users' `tags` needs tags in the app
    const noTags = () => Resource.app(Users.with({ relations: { teamId: Teams }, manyToMany: { tags: Tags } }), Teams)
    // @ts-expect-error: `tags` holds tag ids, not team ids
    Users.with({ manyToMany: { tags: Teams } })
    // @ts-expect-error: `teamId` is not many-to-many (not an array)
    Users.with({ manyToMany: { teamId: Teams } })
    // @ts-expect-error: and `tags` is not a plain relation
    Users.with({ relations: { tags: Tags } })
    expect([ok, noTags]).toHaveLength(2)
  })

  it("a relation's field holds the target's ids", () => {
    Users.with({ relations: { teamId: Teams } })
    // @ts-expect-error: `role` values are not team ids
    Users.with({ relations: { role: Teams } })
    // @ts-expect-error: `teamId` holds team ids, not user ids
    Users.with({ relations: { teamId: Users } })
  })

  it("endpoint paths are what is registered", () => {
    const { endpoints } = Resources.resources.users
    expectTypeOf(endpoints.view.path).toEqualTypeOf<"/users/view">()
    expectTypeOf(endpoints.update.path).toEqualTypeOf<"/users/:id">()
    expect(endpoints.update.path).toBe("/users/:id")
    expect(endpoints.create.path).toBe("/users")
    // @ts-expect-error: the full list's routes have no `:scope` param
    endpoints.update.call({ id: 3, scope: "2" })
    expect(endpoints.update.call({ id: 3 })).toBe("@put('/users/3')")
  })
})

describe("Resource.app checks at startup", () => {
  it("rejects a resource given twice and clashing embed names", () => {
    expect(() => Resource.app(Teams, Teams)).toThrow(`"teams" is given twice`)
    const members = Users.embed({ name: "members", title: "Members", lock: "teamId" })
    expect(() => Resource.app(Users, Teams.with({ sections: [members, members] }))).toThrow(`two embeds are named "members"`)
    const named = Users.embed({ name: "teams", title: "Members", lock: "teamId" })
    expect(() => Resource.app(Users, Teams.with({ sections: [named] }))).toThrow(`embed "teams" has a resource's name`)
  })
})
