/**
 * App composition, shared by `main.tsx` and the tests.
 */
import { type Duration, Layer } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import * as DistributedReactivity from "../reactivity/DistributedReactivity.ts"
import * as SqliteBroadcast from "../reactivity/SqliteBroadcast.ts"
import * as Db from "./Db.ts"
import { TeamMembers, TeamRoutes } from "./TeamDetail.tsx"
import { Teams } from "./Teams.tsx"
import { Users } from "./Users.tsx"

/** All routes. */
export const Routes = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.redirect("/users")),
  Users.routes,
  TeamRoutes,
  TeamMembers.routes,
  HttpStaticServer.layer({ root: "public" })
)

/**
 * Shared infrastructure. Provided outside `serve` so mutations and live views
 * share one `Reactivity` instance.
 *
 * That `Reactivity` also broadcasts through the database, so several server
 * processes on the same SQLite file update each other's live views.
 */
export const Infra = (db: {
  readonly filename: string
  readonly seed?: boolean
  /** How often to poll for other processes' invalidations (default 100 millis). */
  readonly pollInterval?: Duration.Input
}) =>
  Layer.mergeAll(Users.layer, Teams.layer).pipe(
    Layer.provideMerge(DistributedReactivity.layer),
    Layer.provide(SqliteBroadcast.layer({ pollInterval: db.pollInterval })),
    Layer.provideMerge(Db.layer(db))
  )
