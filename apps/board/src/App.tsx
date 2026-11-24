/**
 * Kanban Board app composition, shared by `main.tsx` and tests.
 */
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import { Reactivity } from "effect/reactivity"
import { BoardStore, type Card, DEFAULT_SEED, makeBoardStoreLayer } from "./BoardStore.ts"
import { makeBoardView } from "./BoardView.tsx"

export const makeBoardApp = (seed: ReadonlyArray<Omit<Card, "id">> = DEFAULT_SEED) => {
  const { view, renderPage, hubs } = makeBoardView()

  const pageRoute = HttpRouter.add(
    "GET",
    "/",
    Effect.gen(function*() {
      const store = yield* BoardStore
      const cards = yield* store.list
      return HttpServerResponse.html(renderPage(cards))
    })
  )

  const routes = Layer.mergeAll(
    pageRoute,
    view.layer,
    HttpStaticServer.layer({ root: "public" })
  )

  const infra = makeBoardStoreLayer(seed).pipe(
    Layer.provideMerge(Reactivity.layer)
  )

  return { view, routes, infra, hubs }
}

const defaultApp = makeBoardApp()

export const Routes = defaultApp.routes
export const Infra = defaultApp.infra
