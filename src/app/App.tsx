/**
 * App composition, shared by `main.tsx` and the tests.
 */
import { Layer } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import { Reactivity } from "effect/reactivity"
import * as Db from "./Db.ts"
import { Layout } from "./Layout.tsx"
import { TeamLookupLive, TeamRepoLive, TeamRoutes, TeamsPage } from "./Teams.tsx"
import { UserRepoLive, UserRoutes, UsersPage } from "./Users.tsx"

const Pages = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.redirect("/users")),
  HttpRouter.add(
    "GET",
    "/users",
    HttpServerResponse.html(<Layout title="Users" active="/users"><UsersPage /></Layout> as string)
  ),
  HttpRouter.add(
    "GET",
    "/teams",
    HttpServerResponse.html(<Layout title="Teams" active="/teams"><TeamsPage /></Layout> as string)
  )
)

/** All routes. */
export const Routes = Layer.mergeAll(Pages, UserRoutes, TeamRoutes, HttpStaticServer.layer({ root: "public" }))

/**
 * Shared infrastructure. Provided outside `serve` so mutations and live views
 * share one `Reactivity` instance.
 */
export const Infra = (db: { readonly filename: string; readonly seed?: boolean }) =>
  Layer.mergeAll(UserRepoLive, TeamRepoLive, TeamLookupLive).pipe(
    Layer.provideMerge(Db.layer(db)),
    Layer.provideMerge(Reactivity.layer)
  )
