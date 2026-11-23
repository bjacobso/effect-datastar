/**
 * App composition, shared by `main.tsx` and the tests.
 */
import { type Duration, Layer } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import { Sessions } from "../auth/Auth.ts"
import { RequireSession } from "../auth/Middleware.ts"
import * as DistributedReactivity from "../reactivity/DistributedReactivity.ts"
import * as SqliteBroadcast from "../reactivity/SqliteBroadcast.ts"
import { ApiRoutes } from "./Api.ts"
import * as Db from "./Db.ts"
import { LoginRoutes } from "./Login.tsx"
import { Resources } from "./Resources.ts"

/**
 * Behind the session middleware: it provides `CurrentUser` and `CurrentOrg`,
 * which the tenant-scoped resources and the layout require (remove the
 * `Layer.provide` and this no longer type-checks).
 */
const Protected = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.redirect("/users")),
  Resources.routes
).pipe(Layer.provide(RequireSession.layer))

/** All routes. */
export const Routes = Layer.mergeAll(
  Protected,
  // Sign in and out (public).
  LoginRoutes,
  // JSON API under /api, through the same repos (so it updates live views too). Its own
  // `Authentication` middleware answers 401 without a session.
  ApiRoutes,
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
  Layer.mergeAll(Resources.layer, Sessions.layer).pipe(
    Layer.provideMerge(DistributedReactivity.layer),
    Layer.provide(SqliteBroadcast.layer({ pollInterval: db.pollInterval })),
    Layer.provideMerge(Db.layer(db))
  )
