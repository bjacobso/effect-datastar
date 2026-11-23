/**
 * The live table (`GET /users/view`): re-runs when this table or any related
 * table changes, and sends as little as it can (row patches, just the
 * pagination, nothing). Relation selects are re-sent only when their options
 * changed. When the table owns the URL, the first emission also patches
 * `${ns}._url` (a local signal, never sent back), which the page mirrors into
 * the address bar.
 *
 * Identical views share one source (see `Shared`): every tab showing the same
 * table for the same tenant, lock and query gets the events of one stream,
 * rendered once per change.
 *
 * Internal to the resource modules.
 */
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import * as Shared from "@effect-datastar/datastar/Shared.ts"
import { render } from "@effect-datastar/ui/Html.ts"
import { Context, Effect, Stream } from "effect"
import type { SqlError } from "effect/sql"
import type * as Components from "../components.tsx"
import { unexpected } from "../Feedback.tsx"
import type * as Lookup from "../Lookup.ts"
import type * as Query from "../Query.ts"
import type * as Repo from "../Repo.ts"
import type { Wired } from "./context.ts"
import type { Lock, Model, Requires } from "./table.ts"
import type { Fields, IdKey, ModelLike } from "./types.ts"
import type { Views } from "./view.tsx"

export const make = <
  Name extends string,
  M extends ModelLike,
  Id extends IdKey<M>,
  Sortable extends Fields<M>,
  FK extends string,
  T,
  L,
  QK extends string
>(
  w: Wired<Name, M, Id, Sortable, FK, T, L>,
  t: Model<Name, M, Id, Sortable, FK, T, L, QK>,
  views: Views<Name, M, Id, Sortable, FK, T, L, QK>
) => {
  type Row = M["Type"]
  type Q = Query.ListQuery<Sortable, QK>
  const { ns, spec } = t
  const { RowView, TableView, relationSelects, splitPagination } = views

  /** Shared live tables, by tenant, lock and query. */
  const hubs = Shared.registry()

  /**
   * What every tab showing this table for this query and tenant receives: the
   * live page, rendered once. Its snapshot is the table as it is now (the page
   * with any row patches applied), all relation selects and the page's ids.
   */
  const sharedSource = (
    repo: Repo.Repo<M, Id, Sortable, FK, T>,
    services: ReadonlyArray<readonly [string, Lookup.Lookup<T>]>,
    q: Q,
    full: Query.ListQuery<Sortable, FK>,
    lock: Lock
  ): Effect.Effect<Shared.Source, never, T> =>
    Effect.gen(function*() {
      const context = yield* Effect.context<T>()
      let lookups: Components.Lookups = {}
      const lastOptions = new Map<string, string>()
      /** The table as last rendered (`undefined` once rows were patched since). */
      let lastTable: string | undefined
      /** The page ids as last sent (`_page`). */
      let lastIds: string | undefined
      /** The current page (with row patches applied), or the page to clamp to. */
      let current: Repo.Page<Row> | undefined
      let clamp: number | undefined
      const snapshots: Record<"plain" | "first", ReadonlyArray<Datastar.DatastarEvent> | undefined> = {
        plain: undefined,
        first: undefined
      }
      const snapshot = (first: boolean): ReadonlyArray<Datastar.DatastarEvent> | undefined => {
        const cached = first ? snapshots.first : snapshots.plain
        if (cached !== undefined) return cached
        if (clamp !== undefined) return [Datastar.patchSignals({ [ns]: { query: { page: clamp } } })]
        if (current === undefined) return undefined
        lastTable ??= render(<TableView page={current} current={q} lookups={lookups} lock={lock} />)
        // The ids on this page, for "select all" and pruning the selection (see `Bulk`),
        // and for a new tab the canonical URL (see `UrlState`).
        const local: Record<string, unknown> = { _page: w.pageIds(current.rows) }
        if (first && spec.syncUrl) local["_url"] = t.urlFor(full)
        const events = [
          Datastar.patchElements(lastTable),
          ...relationSelects(lookups),
          Datastar.patchSignals({ [ns]: local })
        ]
        snapshots[first ? "first" : "plain"] = events
        return events
      }
      // The related tables' keys, for the current tenant (`tags[orgId=1]`): another
      // organization's tag changes don't wake this view.
      const dependsOn = yield* Effect.forEach(services, ([, l]) => l.key)
      const deltas = repo.live(full, { dependsOn }).pipe(
        // Lookups load with the first page and whenever a related table changes (only
        // the changed tables' lookups, when the repo can tell).
        Stream.mapEffect((event): Effect.Effect<Repo.LiveEvent<Row>, SqlError.SqlError, T> =>
          event._tag === "Page" && event.reason !== "table"
            ? Effect.map(w.lookupsFor(services), (loaded) => {
              lookups = loaded
              return event
            })
            : event._tag === "Related"
            ? Effect.map(w.lookupsFor(services.filter(([, l]) => event.tables.includes(l.table))), (loaded) => {
              lookups = { ...lookups, ...loaded }
              return event
            })
            : Effect.succeed(event)
        ),
        // Deltas, for tabs that are up to date. The state is updated first, so a tab
        // that joins (or catches up) gets a snapshot that includes this change.
        Stream.map((event): ReadonlyArray<Datastar.DatastarEvent> => {
          snapshots.plain = undefined
          snapshots.first = undefined
          if (event._tag === "Rows") {
            const byId = new Map(event.rows.map((row) => [row[w.idColumn], row] as const))
            if (current) current = { ...current, rows: current.rows.map((row) => byId.get(row[w.idColumn]) ?? row) }
            lastTable = undefined
            // Only these rows changed, in ways that can't move them: patch each `<tr>` by id.
            return event.rows.map((row) => Datastar.patchElements(render(<RowView row={row} lookups={lookups} lock={lock} />)))
          }
          const page = event.page
          if (page.page > page.pages) {
            // Out of range (e.g. after deleting the last row on the last page): clamp.
            clamp = page.pages
            return [Datastar.patchSignals({ [ns]: { query: { page: page.pages } } })]
          }
          clamp = undefined
          current = page
          const table = render(<TableView page={page} current={q} lookups={lookups} lock={lock} />)
          // Send only what the tabs don't have. A re-query often renders the same table
          // (an insert that a filter excludes, a renamed tag the page doesn't show), or the
          // same rows with a new total (an insert that sorts onto another page): then
          // nothing, or just the pagination, instead of the whole table.
          const events: Array<Datastar.DatastarEvent> = []
          if (table !== lastTable) {
            const [rows, pagination] = splitPagination(table)
            const [lastRows] = lastTable === undefined ? [undefined] : splitPagination(lastTable)
            events.push(Datastar.patchElements(rows === lastRows && pagination !== "" ? pagination : table))
          }
          lastTable = table
          // Re-send the selects of the relations whose options changed.
          const changed = new Set(Object.keys(lookups).filter((k) => JSON.stringify(lookups[k]) !== lastOptions.get(k)))
          for (const k of changed) lastOptions.set(k, JSON.stringify(lookups[k]))
          if (changed.size > 0) events.push(...relationSelects(lookups, changed))
          // The ids on this page, when they changed.
          const ids = w.pageIds(page.rows)
          const idsKey = JSON.stringify(ids)
          if (idsKey !== lastIds) events.push(Datastar.patchSignals({ [ns]: { _page: ids } }))
          lastIds = idsKey
          return events
        }),
        Stream.provideContext(context),
        Stream.catch((error) => Stream.fromEffect(Effect.map(unexpected(error), (e) => [e])))
      )
      return { deltas, snapshot }
    })

  /** The live view of this table for the request's query (and the lock, for an embed). */
  return (lock: Lock): Stream.Stream<Datastar.Events, never, Requires<Name, T>> =>
    Stream.unwrap(Effect.gen(function*() {
      const repo = yield* w.Repo
      const services = yield* w.relationServices
      const q = yield* t.readQuery
      const full = spec.full(q, lock)
      // Identical views share one source (see `Shared`): the same tenant, lock and query.
      // The source runs with this request's tenant service only, so it doesn't hold on to
      // the request, and a view of another tenant never shares it (its key differs).
      const tenantKey = w.scope === undefined ? null : (yield* w.scope.value).encoded
      const key = JSON.stringify([tenantKey, lock ?? null, q])
      const tenantOnly = w.tenant === undefined
        ? Context.empty()
        : Context.pick(w.tenant.service)(yield* Effect.context<T>())
      const source = sharedSource(repo, services, q, full, lock).pipe(
        Effect.provideContext(tenantOnly as Context.Context<T>)
      )
      return Shared.subscribe(hubs, key, source)
    })).pipe(Stream.catch((error) => Stream.fromEffect(unexpected(error))))
}
