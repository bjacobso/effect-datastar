/**
 * Level 3: a whole CRUD resource from a model + a small typed config.
 *
 *   export const Users = Resource.make({
 *     name: "users", title: "Users", noun: "user",
 *     model: User, idColumn: "id", display: "name",
 *     query: { sortable: [...], filters: {...}, defaultSort: [...], pageSizes: [...] },
 *     relations: { teamId: Teams.Lookup },
 *     messages: { unique: { email: "Email is already taken" } },
 *     layout: Layout
 *   })
 *
 * It only composes the level-2 pieces (Query, Repo, Lookup, Form, components,
 * Endpoint), and everything it builds is exposed, so a resource can drop down a
 * level for anything the config doesn't cover.
 *
 * Generated:
 *   - `Repo` + `Lookup` services and their `layer`
 *   - routes: page, live view, create, edit, update, delete
 *   - the page (filters, live table, pagination, dialog)
 *
 * Conventions (from `name`): table name, URL prefix `/${name}`, signal namespace
 * `${name}.{query,draft,errors,dialog}`, DOM id prefix.
 */
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Reactivity } from "effect/reactivity"
import type { Model } from "effect/schema"
import type { SqlError } from "effect/sql"
import * as ds from "../datastar/Attrs.ts"
import type { SignalPath } from "../datastar/Attrs.ts"
import * as Datastar from "../datastar/Datastar.ts"
import * as Endpoint from "../datastar/Endpoint.ts"
import * as Components from "./components.tsx"
import { toast, unexpected } from "./Feedback.tsx"
import * as Form from "./Form.ts"
import * as Lookup from "./Lookup.ts"
import * as Query from "./Query.ts"
import * as Repo from "./Repo.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AnyStruct = { readonly fields: Schema.Struct.Fields }

/** What `Resource.make` needs from a model (any `Model.Class` satisfies it). */
export type ModelLike = Model.Any & Schema.Codec<any, any, never, never> & {
  readonly jsonCreate: AnyStruct & Schema.Codec<any, any, never, never>
  readonly jsonUpdate: AnyStruct & Schema.Codec<any, any, never, never>
}

type Fields<M extends ModelLike> = keyof M["fields"] & string
type FormKey<M extends ModelLike> = keyof M["jsonCreate"]["fields"] & string

/** Service identifiers, distinct per resource so a missing layer is a type error. */
export interface RepoOf<Name extends string> {
  readonly repo: Name
}
export interface LookupOf<Name extends string> {
  readonly lookup: Name
}

/** A lookup service tag (e.g. another resource's `Lookup`). */
export type LookupTag = Context.Key<LookupOf<string>, Lookup.Lookup>
type Relations<M extends ModelLike> = { readonly [K in Fields<M>]?: LookupTag }
type RelationServices<R> = { [K in keyof R]: R[K] extends Context.Key<infer I, any> ? I : never }[keyof R]

export interface Layout {
  (props: { readonly title: string; readonly active: string; readonly children: JSX.Element }): JSX.Element
}

export interface Config<
  Name extends string,
  M extends ModelLike,
  Id extends Fields<M>,
  Sortable extends Fields<M>,
  Filters extends Record<string, Query.Operator>,
  R extends Relations<M>
> {
  /** Table name, URL prefix, signal namespace and DOM id prefix. */
  readonly name: Name
  readonly title: string
  readonly noun: string
  readonly model: M
  readonly idColumn: Id
  /** Field used as the row's label: toasts, confirms, and this resource's `Lookup`. */
  readonly display: Fields<M>
  readonly query: Query.Config<Sortable, Filters>
  /** Foreign keys whose options/labels come from another resource's lookup. */
  readonly relations?: R
  readonly messages?: {
    /** Field errors for unique constraints (matched by column name in the DB error). */
    readonly unique?: { readonly [K in FormKey<M>]?: string }
    /** Field errors for foreign key violations. Defaults to "<Label> no longer exists" for relations. */
    readonly invalidReference?: { readonly [K in FormKey<M>]?: string }
    /** Toast when a delete is rejected because other rows still reference this one. */
    readonly deleteRestricted?: string
  }
  /** Custom table cells. */
  readonly columns?: { readonly [K in Fields<M>]?: (row: M["Type"], lookups: Components.Lookups) => JSX.Element }
  /** Columns not shown in the table (default: the id). */
  readonly hidden?: ReadonlyArray<Fields<M>>
  readonly layout: Layout
}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

export const make = <
  const Name extends string,
  M extends ModelLike,
  const Id extends Fields<M> & keyof M["update"]["Type"] & keyof M["Type"],
  const Sortable extends Fields<M>,
  const Filters extends { readonly [K in Fields<M>]?: Query.Operator },
  const R extends Relations<M> = {}
>(config: Config<Name, M, Id, Sortable, Filters & Record<string, Query.Operator>, R>) => {
  const { name, model, idColumn } = config
  type FK = keyof Filters & string
  type Row = M["Type"]

  // --- derived schemas -----------------------------------------------------

  const query = Query.make(model, config.query as any) as unknown as Query.QueryDef<Sortable, FK>
  const formFields = Form.fields(model.jsonCreate)
  const formKeys = formFields.map((f) => f.key)
  const blankDraft = Form.blankDraft(model.jsonCreate)
  const noErrors = Form.noErrors(formKeys)
  const relations = Object.entries(config.relations ?? {}) as Array<[string, LookupTag]>
  const hidden: ReadonlyArray<string> = config.hidden ?? [idColumn]
  const tableFields = Form.fields(model).filter((f) => !hidden.includes(f.key))

  const inner = Schema.Struct({
    query: query.schema,
    draft: Form.draftSchema(model.jsonCreate),
    errors: Form.errorsSchema(model.jsonCreate),
    dialog: Schema.Boolean
  })
  const signals = ds.make(Schema.Struct({ [name]: inner } as { readonly [K in Name]: typeof inner }))
  const path = (...parts: Array<string>) => [name, ...parts].join(".") as SignalPath
  const $ = (...parts: Array<string>) => `$${path(...parts)}`

  const QuerySignals = Schema.Struct({ [name]: Schema.Struct({ query: query.schema }) })
  const DraftSignals = Schema.Struct({ [name]: Schema.Struct({ draft: Form.draftSchema(model.jsonCreate) }) })
  const IdParams = Schema.Struct({
    id: Schema.NumberFromString.pipe(Schema.decodeTo(model.fields[idColumn] as any))
  }) as unknown as Schema.Codec<{ readonly id: M["fields"][Id]["Type"] }, { readonly id: string }>

  const readQuery = Effect.map(
    Datastar.signals(QuerySignals),
    (s) => (s as any)[name].query as Query.ListQuery<Sortable, FK>
  )
  const readDraft = Effect.map(Datastar.signals(DraftSignals), (s) => (s as any)[name].draft as Record<string, unknown>)
  const readId = Effect.map(HttpRouter.schemaPathParams(IdParams as any), (p: any) => p.id as M["fields"][Id]["Type"])
  const label = (row: Row) => String((row as any)[config.display])

  // --- services ------------------------------------------------------------

  type RepoShape = Repo.Repo<M, Id, Sortable, FK>
  const RepoTag = Context.Service<RepoOf<Name>, RepoShape>(`${name}/Repo`)
  const LookupTag = Context.Service<LookupOf<Name>, Lookup.Lookup>(`${name}/Lookup`)
  const layer = Layer.mergeAll(
    Layer.effect(RepoTag, Repo.make(model as any, { table: name, idColumn: idColumn as any, query }) as any),
    Layer.effect(LookupTag, Lookup.make({ table: name, value: idColumn, label: config.display }))
  ) as Layer.Layer<
    RepoOf<Name> | LookupOf<Name>,
    never,
    import("effect/sql").SqlClient.SqlClient | Reactivity.Reactivity
  >

  // --- error mapping -------------------------------------------------------

  const dbText = (e: SqlError.SqlError) => `${e.reason.message ?? ""} ${String((e.reason as any).cause ?? "")}`
  /** Pick the configured field whose column name appears in the DB error (else the first). */
  const pick = (messages: Partial<Record<string, string>> | undefined, e: SqlError.SqlError) => {
    const entries = Object.entries(messages ?? {}).filter((x): x is [string, string] => x[1] !== undefined)
    const text = dbText(e)
    return entries.find(([k]) => text.includes(k)) ?? entries[0]
  }
  const invalidReference: Partial<Record<string, string>> = {
    ...Object.fromEntries(
      relations.map(([k]) => [k, `${formFields.find((f) => f.key === k)?.label ?? k} no longer exists`])
    ),
    ...config.messages?.invalidReference
  }

  const fieldErrors = (errors: Partial<Record<string, string>>) =>
    Datastar.patchSignals({ [name]: { errors: { ...noErrors, ...errors } } })
  const closeDialog = Datastar.patchSignals({ [name]: { dialog: false, draft: blankDraft, errors: noErrors } })

  const saveError = (e: SqlError.SqlError) => {
    const match = e.reason._tag === "UniqueViolation"
      ? pick(config.messages?.unique, e)
      : e.reason._tag === "ConstraintError"
      ? pick(invalidReference, e)
      : undefined
    return match ? Effect.succeed(fieldErrors({ [match[0]]: match[1] })) : unexpected(e)
  }

  // --- endpoints -----------------------------------------------------------
  // Paths are typed as fixed literals (`/resource/:id`) so path params type-check
  // through the generic `name`; the real path is used at runtime.

  const relationServices = Effect.forEach(relations, ([key, tag]) => Effect.map(Effect.service(tag), (l) => [key, l] as const))

  /** Canonical URL for a query, e.g. `/users?teamId=3&sort=name&dir=asc`. */
  const urlFor = (q: Query.ListQuery<Sortable, FK>) => {
    const qs = query.toSearchParams(q).toString()
    return qs ? `/${name}?${qs}` : `/${name}`
  }

  const lookupsFor = (services: ReadonlyArray<readonly [string, Lookup.Lookup]>) =>
    Effect.map(
      Effect.forEach(services, ([key, l]) => Effect.map(l.options, (o) => [key, o] as const)),
      (entries): Components.Lookups => Object.fromEntries(entries)
    )

  /** Selects whose options come from lookups; replaced so `data-bind` re-applies the signal value. */
  const relationSelects = (lookups: Components.Lookups): Array<Datastar.DatastarEvent> =>
    relations.flatMap(([key]) => {
      const filter = query.filters.find((f) => f.key === key)
      const field = formFields.find((f) => f.key === key)
      return [
        ...(filter
          ? [Datastar.patchElements(
            <Components.FilterSelect prefix={name} filter={filter} query={path("query")} lookup={lookups[key]} />,
            { selector: `#${Components.filterId(name, key)}`, mode: "replace" }
          )]
          : []),
        ...(field
          ? [Datastar.patchElements(
            <Components.FieldSelect
              prefix={name}
              field={field}
              draft={path("draft")}
              errors={path("errors")}
              lookup={lookups[key]}
            />,
            { selector: `#${Components.fieldId(name, key)}`, mode: "replace" }
          )]
          : [])
      ]
    })

  /**
   * Live view: the table for the query, kept up to date by `Repo.live`. A page
   * event re-renders the table; a rows event patches just those `<tr>`s (by
   * id). Lookups are loaded with the first page and whenever a related table
   * changes; relation selects are re-sent only when their options changed. The
   * first emission also patches `${name}._url` (a local signal, never sent
   * back), which the page mirrors into the address bar.
   */
  const view = Endpoint.make(
    "GET",
    `/${name}/view` as "/resource/view",
    Stream.unwrap(Effect.gen(function*() {
      const repo = yield* RepoTag
      const services = yield* relationServices
      const q = yield* readQuery
      let lookups: Components.Lookups = {}
      let lastOptions: string | undefined
      let urlSent = false
      return repo.live(q, { dependsOn: services.map(([, l]) => l.table) }).pipe(
        Stream.mapEffect((event) =>
          event._tag === "Page" && event.reason !== "table"
            ? Effect.map(lookupsFor(services), (loaded) => {
              lookups = loaded
              return event
            })
            : Effect.succeed(event)
        ),
        Stream.map((event): Datastar.Events => {
          if (event._tag === "Rows") {
            return event.rows.map((row) => Datastar.patchElements(<RowView row={row} lookups={lookups} />))
          }
          const page = event.page
          if (page.page > page.pages) {
            // Out of range (e.g. after deleting the last row on the last page): clamp.
            return Datastar.patchSignals({ [name]: { query: { page: page.pages } } })
          }
          const events = [Datastar.patchElements(<TableView page={page} query={q} lookups={lookups} />)]
          const key = JSON.stringify(lookups)
          if (key !== lastOptions) {
            lastOptions = key
            events.push(...relationSelects(lookups))
          }
          if (!urlSent) {
            urlSent = true
            events.push(Datastar.patchSignals({ [name]: { _url: urlFor(q) } }))
          }
          return events
        })
      )
    })).pipe(Stream.catch((error) => Stream.fromEffect(unexpected(error)))),
    { include: [path("query")] }
  )

  const save = (id?: M["fields"][Id]["Type"]) =>
    Effect.gen(function*() {
      const repo = yield* RepoTag
      const draft = yield* readDraft
      const row = id === undefined
        ? yield* repo.insert((model.insert as any).make(yield* Form.decode(model.jsonCreate, draft)))
        : yield* repo.update((model.update as any).make({ ...(yield* Form.decode(model.jsonUpdate, draft)), [idColumn]: id }))
      return [closeDialog, toast(`${id === undefined ? "Created" : "Saved"} ${label(row)}`)]
    }).pipe(
      Effect.catchTags({
        SchemaError: (e) => Effect.succeed(fieldErrors(Form.errors(formKeys, e))),
        SqlError: saveError,
        SignalsError: unexpected
      })
    )

  const create = Endpoint.make("POST", `/${name}` as "/resource", save(), { include: [path("draft")] })

  const update = Endpoint.make(
    "PUT",
    `/${name}/:id` as "/resource/:id",
    Effect.flatMap(readId, (id) => save(id)).pipe(Effect.catchTag("SchemaError", unexpected)),
    { include: [path("draft")] }
  )

  const edit = Endpoint.make(
    "GET",
    `/${name}/:id/edit` as "/resource/:id/edit",
    Effect.gen(function*() {
      const repo = yield* RepoTag
      const row = yield* repo.findById(yield* readId)
      return Datastar.patchSignals({
        [name]: { dialog: true, draft: Form.toDraft(model.jsonUpdate, row, row[idColumn]), errors: noErrors }
      })
    }).pipe(
      Effect.catchTags({
        NoSuchElementError: () => Effect.succeed(toast(`That ${config.noun} no longer exists`, "error")),
        SchemaError: unexpected,
        SqlError: unexpected
      })
    ),
    { include: [] }
  )

  const remove = Endpoint.make(
    "DELETE",
    `/${name}/:id` as "/resource/:id",
    Effect.gen(function*() {
      const repo = yield* RepoTag
      yield* repo.delete(yield* readId)
      return toast("Deleted")
    }).pipe(
      Effect.catchTags({
        SqlError: (e) =>
          e.reason._tag === "ConstraintError"
            ? Effect.succeed(
              toast(config.messages?.deleteRestricted ?? `This ${config.noun} is still referenced elsewhere.`, "error")
            )
            : unexpected(e),
        SchemaError: unexpected
      })
    ),
    { include: [] }
  )

  // --- views ---------------------------------------------------------------

  const columnsFor = (lookups: Components.Lookups): ReadonlyArray<Components.Column<Row>> =>
    tableFields.map((field) => {
      const custom = (config.columns as Record<string, ((row: Row, l: Components.Lookups) => JSX.Element) | undefined>)
        ?.[field.key]
      const relation = relations.some(([k]) => k === field.key)
      const labels = relation ? Lookup.labels(lookups[field.key] ?? []) : undefined
      return {
        field,
        sortable: (query.sortable as ReadonlyArray<string>).includes(field.key),
        render: custom
          ? (row: Row) => custom(row, lookups)
          : labels
          ? (row: Row) => {
            const v = (row as any)[field.key]
            return <span safe>{v === null || v === undefined ? "—" : labels.get(String(v)) ?? "?"}</span>
          }
          : undefined
      }
    })

  const rowId = (row: Row) => `${name}-${String(row[idColumn])}`
  const actions = (row: Row) => (
    <>
      <button class="link" {...ds.on("click", edit.call({ id: row[idColumn] as any }))}>Edit</button>
      <button
        class="link danger"
        {...ds.on("click", `confirm(${JSON.stringify(`Delete ${label(row)}?`)}) && ${remove.call({ id: row[idColumn] as any })}`)}
      >
        Delete
      </button>
    </>
  )

  /** A single row, as rendered in the table (same id), for row-level patches. */
  const RowView = (props: { readonly row: Row; readonly lookups: Components.Lookups }) => (
    <Components.TableRow row={props.row} columns={columnsFor(props.lookups)} rowId={rowId} actions={actions} />
  )

  const TableView = (props: {
    readonly page: Repo.Page<Row>
    readonly query: Query.ListQuery<Sortable, FK>
    readonly lookups: Components.Lookups
  }) => (
    <section id={`${name}-table`}>
      <Components.Table
        id={`${name}-rows`}
        columns={columnsFor(props.lookups)}
        rows={props.page.rows}
        rowId={rowId}
        query={path("query")}
        current={props.query}
        actions={actions}
      />
      <Components.Pagination
        query={path("query")}
        page={props.page.page}
        pages={props.page.pages}
        total={props.page.total}
        pageSizes={query.pageSizes}
      />
    </section>
  )

  /**
   * The page, server-rendered for the query in the URL. The live stream then
   * takes over: it re-renders on changes and keeps the URL in sync.
   */
  const Page = (props: {
    readonly query: Query.ListQuery<Sortable, FK>
    readonly initial?: { readonly page: Repo.Page<Row>; readonly lookups: Components.Lookups } | undefined
  }) => (
    <main
      {...signals.init({ [name]: { query: props.query, draft: blankDraft, errors: noErrors, dialog: false } } as any)}
      {...ds.effect(`${$("_url")} && ${$("_url")} !== location.pathname + location.search && history.replaceState(null, '', ${$("_url")})`)}
    >
      <header class="bar">
        <h1 safe>{config.title}</h1>
        <button
          {...ds.on(
            "click",
            `${$("draft")} = ${JSON.stringify(blankDraft)}; ${$("errors")} = ${JSON.stringify(noErrors)}; ${$("dialog")} = true`
          )}
        >
          New {config.noun}
        </button>
      </header>
      <Components.FilterBar prefix={name} filters={query.filters} query={path("query")} lookups={props.initial?.lookups} />
      <div
        id={`${name}-live`}
        {...ds.merge(
          ds.init(view.call()),
          ds.onSignalPatch(view.call(), { include: [path("query")], debounce: "200ms" })
        )}
      >
        {props.initial
          ? <TableView page={props.initial.page} query={props.query} lookups={props.initial.lookups} />
          : <section id={`${name}-table`} aria-busy="true">Loading…</section>}
      </div>
      <Components.FormDialog
        prefix={name}
        noun={config.noun}
        fields={formFields}
        draft={path("draft")}
        errors={path("errors")}
        open={path("dialog")}
        submit={`${$("draft", "id")} ? ${update.call({ id: Endpoint.js($("draft", "id")) })} : ${create.call()}`}
        lookups={props.initial?.lookups}
      />
      <Components.Toast />
    </main>
  )

  const page = HttpRouter.route(
    "GET",
    `/${name}`,
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const repo = yield* RepoTag
      const services = yield* relationServices
      let q = query.fromSearchParams(new URL(request.url, "http://localhost").searchParams)
      const initial = yield* Effect.gen(function*() {
        let page = yield* repo.list(q)
        if (page.page > page.pages) {
          q = { ...q, page: page.pages }
          page = yield* repo.list(q)
        }
        return { page, lookups: yield* lookupsFor(services) }
      }).pipe(
        // If the first render fails, serve the shell; the live stream reports the error.
        Effect.tapError((e) => Effect.logError("initial render failed", e)),
        Effect.option
      )
      const html = config.layout({
        title: config.title,
        active: `/${name}`,
        children: <Page query={q} initial={initial._tag === "Some" ? initial.value : undefined} />
      })
      return HttpServerResponse.html(typeof html === "string" ? html : yield* Effect.promise(() => html))
    })
  )

  const routes = HttpRouter.addAll([page, view.route, create.route, update.route, edit.route, remove.route])

  return {
    name,
    query,
    signals,
    /** Repository service for this resource. */
    Repo: RepoTag,
    /** `{ value, label }` options of this resource, for other resources' relations. */
    Lookup: LookupTag,
    /** Provides `Repo` and `Lookup`. */
    layer,
    routes: routes as Layer.Layer<
      never,
      never,
      HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", RepoOf<Name> | Reactivity.Reactivity | RelationServices<R>>
    >,
    endpoints: { view, create, update, edit, remove },
    Page
  }
}
