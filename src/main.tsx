import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import { Reactivity } from "effect/reactivity"
import { createServer } from "node:http"
import { DbLive } from "./app/Db.ts"
import { Layout } from "./app/Layout.tsx"
import { UserRepoLive, UserRoutes, UsersPage } from "./app/Users.tsx"

const Pages = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.redirect("/users")),
  HttpRouter.add("GET", "/users", HttpServerResponse.html(<Layout title="Users"><UsersPage /></Layout> as string))
)

const Static = HttpStaticServer.layer({ root: "public" })

const App = Layer.mergeAll(Pages, UserRoutes, Static)

/** Shared infrastructure lives outside `serve` so mutations and live views share one Reactivity. */
const Infra = UserRepoLive.pipe(Layer.provideMerge(DbLive), Layer.provideMerge(Reactivity.layer))

HttpRouter.serve(App).pipe(
  Layer.provide(Infra),
  Layer.provide(NodeHttpServer.layer(createServer, { port: Number(process.env.PORT ?? 3000) })),
  Layer.launch,
  NodeRuntime.runMain
)
