/**
 * App composition, shared by `main.tsx` and the tests.
 */
import { Config, type Duration, Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http"
import * as Metrics from "../metrics/Metrics.ts"
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

/**
 * `GET /_metrics` (see `metrics/Metrics.ts`), only with `METRICS=1`: it is
 * unauthenticated and meant for load tests (`scripts/load/`).
 */
const MetricsRoutes: Layer.Layer<never, never, HttpRouter.HttpRouter> = Layer.unwrap(Effect.gen(function*() {
  const enabled = yield* Config.Boolean("METRICS").pipe(Config.withDefault(false))
  if (!enabled) return Layer.empty as Layer.Layer<never, never, HttpRouter.HttpRouter>
  Metrics.install()
  return HttpRouter.add(
    "GET",
    "/_metrics",
    Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
      // `?gc=1` collects garbage first (when started with `--expose-gc`), for steadier memory numbers.
      const gc = (globalThis as { gc?: () => void }).gc
      if (request.url.includes("gc=1") && gc) gc()
      return HttpServerResponse.jsonUnsafe(Metrics.snapshot())
    })
  )
}).pipe(Effect.orDie))

/** All routes. */
export const Routes = Layer.mergeAll(
  MetricsRoutes,
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
  /** `"load"`: the demo data plus the load-test organizations (`Db.ts`). */
  readonly seed?: boolean | "load"
  /** How often to poll for other processes' invalidations (default 100 millis). */
  readonly pollInterval?: Duration.Input
}) =>
  Layer.mergeAll(Resources.layer, Sessions.layer).pipe(
    Layer.provideMerge(DistributedReactivity.layer),
    Layer.provide(SqliteBroadcast.layer({ pollInterval: db.pollInterval })),
    Layer.provideMerge(Db.layer(db))
  )
