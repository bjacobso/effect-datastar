/**
 * Everything of a resource that depends on its relations and embeds, built
 * once `app` knows them: the tables (the list page's and one per embed of this
 * resource), their routes, the list page and the detail page.
 *
 *   GET    /users              list page, server-rendered for the query in the URL
 *   GET    /users/:id          detail page (fields, Edit, Delete, sections)
 *   GET    /users/:id/view     live record
 *   ...                        the table routes (see `endpoints.ts`)
 *
 * Internal to the resource modules.
 */
import * as Flash from "@effect-datastar/datastar/Flash.ts"
import { Alert, Card, EmptyState } from "@effect-datastar/ui/display.tsx"
import { Effect, type Layer, Option } from "effect"
import { HttpRouter } from "effect/http"
import * as Components from "../components.tsx"
import type * as Policy from "../Policy.ts"
import type * as Query from "../Query.ts"
import type * as Repo from "../Repo.ts"
import * as Bulk from "./bulk.ts"
import { type Ctx, searchParams, wire } from "./context.ts"
import * as Detail from "./detail.tsx"
import * as Endpoints from "./endpoints.ts"
import * as Live from "./live.tsx"
import { html } from "./render.tsx"
import * as Rows from "./rows.ts"
import * as Table from "./table.ts"
import type { AnyEmbed, Fields, IdKey, LookupTag, ModelLike, Section, SectionInput, SectionOf } from "./types.ts"
import * as View from "./view.tsx"

export const build = <
  Name extends string,
  M extends ModelLike,
  Id extends IdKey<M>,
  Sortable extends Fields<M>,
  FK extends string,
  T,
  L,
  A,
  Base
>(
  ctx: Ctx<Name, M, Id, Sortable, FK, T, L, A>,
  /** What a definition exposes (see `definition.ts`), kept in the assembled resource. */
  base: Base,
  relations: ReadonlyArray<readonly [string, LookupTag]>,
  sections: ReadonlyArray<SectionInput<M["Type"], M["fields"][Id]["Type"]>>,
  embeds: ReadonlyArray<AnyEmbed>
) => {
  type Row = M["Type"]
  type IdType = M["fields"][Id]["Type"]
  const w = wire(ctx, relations)
  const { name, prefix, query } = w

  const tables: Endpoints.Tables<IdType, Table.Requires<Name, T, A>> = { list: undefined, embeds: new Map() }
  const endpoints = Endpoints.make(w, tables)

  /** A table: the list page's, or an embed's. */
  const table = <QK extends string>(spec: Table.Spec<Sortable, QK, FK>) => {
    const t = Table.model(w, spec)
    const views = View.make(w, t, endpoints)
    const rows = Rows.make(w, t)
    const bulk = Bulk.make(w, t)
    const handlers: Table.Handlers<IdType, Table.Requires<Name, T, A>> = {
      view: Live.make(w, t, views),
      save: rows.save,
      edit: rows.edit,
      remove: rows.remove,
      bulkRemove: bulk.remove,
      bulkUpdate: bulk.update
    }
    return { handlers, views }
  }

  // --- the list page -------------------------------------------------------

  const list = table({ ns: name, title: w.title, heading: "h1", query, lockKey: undefined, full: (q) => q, syncUrl: true })
  tables.list = list.handlers

  /** The list page, server-rendered for the query in the URL. */
  const Page = (props: {
    readonly query: Query.ListQuery<Sortable, FK>
    readonly initial?: { readonly page: Repo.Page<Row>; readonly lookups: Components.Lookups } | undefined
    /** A toast carried over a redirect (e.g. "Deleted" after a delete on the detail page). */
    readonly flash?: Flash.Flash | undefined
    readonly capabilities?: Policy.Capabilities | undefined
  }) => (
    <main>
      <list.views.View query={props.query} lock={undefined} initial={props.initial} capabilities={props.capabilities} />
      <Components.Toast message={props.flash?.message} kind={props.flash?.kind} />
    </main>
  )

  const page = HttpRouter.route(
    "GET",
    prefix,
    Effect.gen(function*() {
      const caps = yield* w.capabilities
      if (!caps.read) {
        return yield* html(
          w.layout({
            title: "Forbidden",
            active: prefix,
            children: (
              <main>
                <Card>
                  <EmptyState icon="alert" title="Forbidden">
                    {`You do not have permission to view ${w.title.toLowerCase()}.`}
                  </EmptyState>
                </Card>
              </main>
            )
          }),
          403
        )
      }
      const params = yield* searchParams
      const q = query.fromSearchParams(params)
      const initial = yield* list.views.initial(q, undefined)
      const flash = Option.getOrUndefined(yield* Flash.take)
      const response = yield* html(w.layout({
        title: w.title,
        active: prefix,
        children: initial._tag === "Some"
          ? <Page query={initial.value.query} initial={initial.value} flash={flash} capabilities={caps} />
          : <Page query={q} flash={flash} capabilities={caps} />
      }))
      return flash === undefined ? response : Flash.clear(response)
    })
  )

  // --- embeds of this resource on other resources' detail pages -------------

  const embedSections = new Map<string, (value: unknown) => Section<unknown>>()
  for (const embed of embeds) {
    if (tables.embeds.has(embed.name)) throw new Error(`Resource ${name}: two embeds are named "${embed.name}"`)
    const locked = query.lock(embed.lock as FK)
    const embedded = table({
      ns: embed.name,
      title: embed.title,
      heading: "h2",
      query: locked,
      lockKey: locked.key,
      full: (q, lock) => locked.apply(q, lock ?? ""),
      syncUrl: false
    })
    tables.embeds.set(embed.name, { table: embedded.handlers, parse: locked.parse })
    embedSections.set(embed.name, (value) =>
      Effect.gen(function*() {
        const caps = yield* w.capabilities
        if (!caps.read) return null
        const lock = locked.parse(String(value))
        if (lock === undefined) {
          return <Alert tone="danger">{`Cannot show ${embed.title}: invalid ${embed.lock}.`}</Alert>
        }
        const initial = yield* embedded.views.initial(locked.initial, lock)
        return initial._tag === "Some"
          ? <embedded.views.View query={initial.value.query} lock={lock} initial={initial.value} capabilities={caps} />
          : <embedded.views.View query={locked.initial} lock={lock} capabilities={caps} />
      }))
  }

  // --- the detail page -----------------------------------------------------

  const detail = Detail.make(w, endpoints, list.views, sections)

  return {
    resource: {
      ...base,
      /** Error messages for database constraint violations, with the defaults for relations filled in. */
      messages: w.messages,
      endpoints: { ...endpoints, record: detail.record },
      Page
    },
    section: ((embed) => embedSections.get(embed.name)!) satisfies SectionOf,
    routes: (sectionOf: SectionOf) =>
      HttpRouter.addAll([
        page,
        detail.route(sectionOf),
        endpoints.view.route,
        endpoints.create.route,
        endpoints.update.route,
        endpoints.edit.route,
        endpoints.remove.route,
        detail.record.route,
        endpoints.bulkRemove.route,
        endpoints.bulkUpdate.route,
        endpoints.restore.route
      ]) as Layer.Layer<never>
  }
}
