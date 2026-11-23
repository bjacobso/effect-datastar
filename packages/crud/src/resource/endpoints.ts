/**
 * A resource's table routes, registered once each. The list page's table and
 * every embed's table share them: `?embed=&scope=` picks the table and its
 * lock value (`GET /users/view?embed=members&scope=2`). An unknown embed, a
 * scope that isn't a valid value of the locked field, or a scope without an
 * embed is a `ScopeError`, answered with an error toast.
 *
 *   GET    /users/view         live table
 *   POST   /users              create
 *   GET    /users/:id/edit     open the edit dialog
 *   PUT    /users/:id          update
 *   DELETE /users/:id          delete (`?from=detail`: then back to the list, see `Flash`)
 *   POST   /users/bulk/delete  delete the selected rows
 *   POST   /users/bulk/update  set one field on the selected rows
 *   GET    /users/query        the query signals for a URL (Back/Forward, see `UrlState`)
 *
 * Internal to the resource modules.
 */
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import * as Endpoint from "@effect-datastar/datastar/Endpoint.ts"
import * as Flash from "@effect-datastar/datastar/Flash.ts"
import { Effect, Stream } from "effect"
import { toast, unexpected } from "../Feedback.tsx"
import { EMBED, FROM, SCOPE, searchParams, type Wired } from "./context.ts"
import type { Handlers, Lock, Requires } from "./table.ts"
import { type Fields, type IdKey, type ModelLike, ScopeError } from "./types.ts"

/** The tables the routes serve: the list page's, and each embed's with its lock parser. Filled in by `build`. */
export interface Tables<IdType, R> {
  list: Handlers<IdType, R> | undefined
  readonly embeds: Map<string, { readonly table: Handlers<IdType, R>; readonly parse: (raw: string) => string | undefined }>
}

export const make = <Name extends string, M extends ModelLike, Id extends IdKey<M>, Sortable extends Fields<M>, FK extends string, T, L>(
  w: Wired<Name, M, Id, Sortable, FK, T, L>,
  tables: Tables<M["fields"][Id]["Type"], Requires<Name, T>>
) => {
  type IdType = M["fields"][Id]["Type"]
  type Table = Handlers<IdType, Requires<Name, T>>
  const { name, prefix, query } = w

  /** The table a request is for: the list's, or an embed's with its validated lock value. */
  const target = Effect.flatMap(searchParams, (params): Effect.Effect<{ table: Table; lock: Lock }, ScopeError> => {
    const embed = params.get(EMBED)
    const raw = params.get(SCOPE)
    if (embed === null && raw === null) return Effect.succeed({ table: tables.list!, lock: undefined })
    const locked = embed === null ? undefined : tables.embeds.get(embed)
    const lock = locked?.parse(raw ?? "")
    return locked === undefined || lock === undefined
      ? Effect.fail(new ScopeError({ embed, raw }))
      : Effect.succeed({ table: locked.table, lock })
  })

  /** Runs `f` with the path's id and the request's table; a bad id or scope is a toast. */
  const onRow = (f: (id: IdType, table: Table, lock: Lock) => Effect.Effect<Datastar.Events, never, Requires<Name, T>>) =>
    Effect.gen(function*() {
      const id = yield* w.readId
      const t = yield* target
      return yield* f(id, t.table, t.lock)
    }).pipe(Effect.catchTags({ SchemaError: unexpected, ScopeError: unexpected }))

  /** A table-level action (`?embed=&scope=` picks the table and its lock). */
  const onTable = (f: (table: Table, lock: Lock) => Effect.Effect<Datastar.Events, never, Requires<Name, T>>) =>
    Effect.flatMap(target, (t) => f(t.table, t.lock)).pipe(Effect.catchTag("ScopeError", unexpected))

  return {
    view: Endpoint.make(
      "GET",
      "/view",
      Stream.unwrap(Effect.map(target, (t) => t.table.view(t.lock))).pipe(
        Stream.catch((error) => Stream.fromEffect(unexpected(error)))
      ),
      { prefix }
    ),
    create: Endpoint.make("POST", "", onTable((table, lock) => table.save(undefined, lock)), { prefix }),
    update: Endpoint.make("PUT", "/:id", onRow((id, table, lock) => table.save(id, lock)), { prefix }),
    edit: Endpoint.make("GET", "/:id/edit", onRow((id, table, lock) => table.edit(id, lock)), { prefix, include: [] }),
    /**
     * Delete. From the detail page (`?from=detail`), a successful delete goes back to the
     * list, which shows the toast (a flash message: see `Flash`).
     */
    remove: Endpoint.make(
      "DELETE",
      "/:id",
      onRow((id, table, lock) =>
        Effect.flatMap(searchParams, (params) =>
          table.remove(
            id,
            lock,
            params.get(FROM) === "detail" ? Flash.redirect(prefix, { message: "Deleted", kind: "ok" }) : toast("Deleted")
          )
        )
      ),
      { prefix, include: [] }
    ),
    bulkRemove: Endpoint.make("POST", "/bulk/delete", onTable((table, lock) => table.bulkRemove(lock)), { prefix }),
    bulkUpdate: Endpoint.make("POST", "/bulk/update", onTable((table, lock) => table.bulkUpdate(lock)), { prefix }),
    /**
     * The query of a list URL, as signals (`GET /users/query?teamId=3&sort=name`),
     * parsed exactly as the page parses it. Back/Forward use it (see `UrlState`).
     */
    restore: Endpoint.make(
      "GET",
      "/query",
      Effect.map(searchParams, (params) => Datastar.patchSignals({ [name]: { query: query.fromSearchParams(params) } })),
      { prefix, include: [] }
    )
  }
}

/** The table endpoints (see `make`). */
export type TableEndpoints<
  Name extends string,
  M extends ModelLike,
  Id extends IdKey<M>,
  Sortable extends Fields<M>,
  FK extends string,
  T,
  L
> = ReturnType<typeof make<Name, M, Id, Sortable, FK, T, L>>
