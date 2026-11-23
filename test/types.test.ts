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
import { Teams } from "../src/app/Teams.tsx"
import { Users } from "../src/app/Users.tsx"
import * as Db from "../src/app/Db.ts"
import * as Resource from "../src/crud/Resource.tsx"

/** Type-checked, never run: serve `routes` with `services` provided. */
const serve = <R,>(
  routes: Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", R>>,
  services: Layer.Layer<R, unknown, never>
) => () => HttpRouter.toWebHandler(routes.pipe(Layer.provide(services), Layer.provide(HttpServer.layerServices), Layer.provide(NodeServices.layer)))

const infra = Layer.mergeAll(Reactivity.layer, Db.layer({ filename: ":memory:" }))

describe("Resource types", () => {
  it("routes require every resource's services", () => {
    serve(Resources.routes, Resources.layer.pipe(Layer.provideMerge(Reactivity.layer), Layer.provide(infra)))
    // @ts-expect-error: no `LookupOf<"teams">` / `RepoOf<"teams">` (the teams layer is missing)
    serve(Resources.routes, Users.layer.pipe(Layer.provideMerge(Reactivity.layer), Layer.provide(infra)))
    expectTypeOf(Resources.layer).toEqualTypeOf<
      Layer.Layer<
        Resource.ServicesOf<"users" | "teams">,
        never,
        import("effect/sql").SqlClient.SqlClient | Reactivity.Reactivity
      >
    >()
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
