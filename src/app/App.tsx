/**
 * App composition, shared by `main.tsx` and the tests.
 */
import { Layer } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import { Reactivity } from "effect/reactivity"
import * as Db from "./Db.ts"
import { Teams } from "./Teams.tsx"
import { Users } from "./Users.tsx"

/** All routes. */
export const Routes = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.redirect("/users")),
  Users.routes,
  Teams.routes,
  HttpStaticServer.layer({ root: "public" })
)

/**
 * Shared infrastructure. Provided outside `serve` so mutations and live views
 * share one `Reactivity` instance.
 */
export const Infra = (db: { readonly filename: string; readonly seed?: boolean }) =>
  Layer.mergeAll(Users.layer, Teams.layer).pipe(
    Layer.provideMerge(Db.layer(db)),
    Layer.provideMerge(Reactivity.layer)
  )
