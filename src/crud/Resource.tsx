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
 *   - routes: list page, live view, create, edit, update, delete, and a detail
 *     page (`/${name}/:id`) whose record is live (`/${name}/:id/view`)
 *   - `routesWith({ sections })`: the same routes, with extra sections on the
 *     detail page (e.g. an embedded "has many" table)
 *   - `embed({ name, title, lock })`: this resource's table as a section of
 *     another page, with one `eq` filter fixed by the server
 *
 * Conventions (from `name`): table name, URL prefix `/${name}`, signal namespace
 * `${name}.{query,draft,errors,dialog}`, DOM id prefix. An embed uses its own
 * `name` for the signal namespace and DOM ids, and routes under
 * `/${resource}/embed/${embed}/:scope`.
 */
import { Cause, Context, Data, Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Reactivity } from "effect/reactivity"
import type { Model } from "effect/schema"
import type { SqlClient, SqlError } from "effect/sql"
import * as ds from "../datastar/Attrs.ts"
import type { SignalPath } from "../datastar/Attrs.ts"
import * as Datastar from "../datastar/Datastar.ts"
import * as Endpoint from "../datastar/Endpoint.ts"
import * as Components from "./components.tsx"
import type * as Field from "./Field.ts"
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

/** Filter keys configured with the `eq` operator (the ones an embed can lock). */
type EqKeys<Filters> = { [K in keyof Filters & string]: Filters[K] extends "eq" ? K : never }[keyof Filters & string]

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
  /** Field used as the row's label: toasts, confirms, links, and this resource's `Lookup`. */
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

/** A server-rendered section of the detail page. Failures must be handled (rendered) first. */
export type Section<R> = Effect.Effect<JSX.Element, never, R>

/** The `:scope` path param of an embed did not decode to a valid lock value. */
export class ScopeError extends Data.TaggedError("ScopeError")<{ readonly raw: string }> {}

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
  type IdType = M["fields"][Id]["Type"]
  type Requires = RepoOf<Name> | Reactivity.Reactivity | RelationServices<R>

  // --- derived schemas -----------------------------------------------------

  const query = Query.make(model, config.query as any) as unknown as Query.QueryDef<Sortable, FK>
  const formFields = Form.fields(model.jsonCreate)
  const relations = Object.entries(config.relations ?? {}) as Array<[string, LookupTag]>
  const hidden: ReadonlyArray<string> = config.hidden ?? [idColumn]
  const tableFields = Form.fields(model).filter((f) => !hidden.includes(f.key))

  const IdParams = Schema.Struct({
    id: Schema.NumberFromString.pipe(Schema.decodeTo(model.fields[idColumn] as any))
  }) as unknown as Schema.Codec<{ readonly id: IdType }, { readonly id: string }>
  const readId = Effect.map(HttpRouter.schemaPathParams(IdParams as any), (p: any) => p.id as IdType)
  const label = (row: Row) => String((row as any)[config.display])
  const href = (id: unknown) => `/${name}/${encodeURIComponent(String(id))}`

  // --- services ------------------------------------------------------------

  type RepoShape = Repo.Repo<M, Id, Sortable, FK>
  const RepoTag = Context.Service<RepoOf<Name>, RepoShape>(`${name}/Repo`)
  const LookupTag = Context.Service<LookupOf<Name>, Lookup.Lookup>(`${name}/Lookup`)
  const layer = Layer.mergeAll(
    Layer.effect(RepoTag, Repo.make(model as any, { table: name, idColumn: idColumn as any, query }) as any),
    Layer.effect(LookupTag, Lookup.make({ table: name, value: idColumn, label: config.display, href }))
  ) as Layer.Layer<RepoOf<Name> | LookupOf<Name>, never, SqlClient.SqlClient | Reactivity.Reactivity>

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
  const goneToast = () => Effect.succeed(toast(`That ${config.noun} no longer exists`, "error"))

  // --- shared rendering ----------------------------------------------------

  const relationServices = Effect.forEach(relations, ([key, tag]) => Effect.map(Effect.service(tag), (l) => [key, l] as const))
  const relationTables = Effect.map(relationServices, (services) => services.map(([, l]) => l.table))

  const lookupsFor = (services: ReadonlyArray<readonly [string, Lookup.Lookup]>) =>
    Effect.map(
      Effect.forEach(services, ([key, l]) => Effect.map(l.options, (o) => [key, o] as const)),
      (entries): Components.Lookups => Object.fromEntries(entries)
    )

  /** How a field's value is shown: custom cell, linked relation label, linked display, or formatted value. */
  const cell = (field: Field.FieldInfo, lookups: Components.Lookups, options: { readonly link: boolean }) => {
    const custom = (config.columns as Record<string, ((row: Row, l: Components.Lookups) => JSX.Element) | undefined>)
      ?.[field.key]
    if (custom) return (row: Row) => custom(row, lookups)
    if (relations.some(([k]) => k === field.key)) {
      const byValue = new Map((lookups[field.key] ?? []).map((o) => [o.value, o]))
      return (row: Row) => {
        const v = (row as Record<string, unknown>)[field.key]
        if (v === null || v === undefined) return <span>—</span>
        const option = byValue.get(String(v))
        if (!option) return <span>?</span>
        return option.href ? <a href={option.href} safe>{option.label}</a> : <span safe>{option.label}</span>
      }
    }
    if (options.link && field.key === config.display) {
      return (row: Row) => <a href={href(row[idColumn])} safe>{label(row)}</a>
    }
    return undefined
  }

  // --- a scoped table ------------------------------------------------------
  //
  // The list page and every embed share this: a filter bar, live table,
  // paging and a create/edit dialog in their own signal namespace, with their
  // own routes. An embed adds a lock: one filter the server fixes from the
  // `:scope` path param, which also prefills creates and bounds edits/deletes.

  interface Scope<Ns extends string, QK extends string> {
    readonly ns: Ns
    /** Route prefix; contains `:scope` when locked. */
    readonly base: string
    readonly title: string
    readonly heading: "h1" | "h2"
    readonly query: {
      readonly schema: Schema.Codec<Query.ListQuery<Sortable, QK>, Query.ListQuery<Sortable, QK>>
      readonly initial: Query.ListQuery<Sortable, QK>
      readonly filters: ReadonlyArray<Query.FilterInfo>
    }
    readonly lock:
      | {
        readonly key: FK
        readonly parse: (raw: string) => string | undefined
        readonly apply: (q: Query.ListQuery<Sortable, QK>, value: string) => Query.ListQuery<Sortable, FK>
      }
      | undefined
    /** Mirror the query into the address bar (only one table per page can own the URL). */
    readonly syncUrl: boolean
  }

  const scoped = <const Ns extends string, QK extends string>(scope: Scope<Ns, QK>) => {
    const { ns, lock } = scope
    type Q = Query.ListQuery<Sortable, QK>
    const lockKey: string | undefined = lock?.key
    const fields = formFields.filter((f) => f.key !== lockKey)
    // The draft, errors and form leave out the lock: the server owns that field.
    const { [lockKey ?? ""]: _locked, ...formSchemaFields } = model.jsonCreate.fields as Schema.Struct.Fields
    const form = { fields: formSchemaFields }
    const keys = fields.map((f) => f.key)
    const blankDraft = Form.blankDraft(form)
    const noErrors = Form.noErrors(keys)
    const draftSchema = Form.draftSchema(form)
    const columns = tableFields.filter((f) => f.key !== lockKey)
    const scopedRelations = relations.filter(([k]) => k !== lockKey)

    const inner = Schema.Struct({
      query: scope.query.schema,
      draft: draftSchema,
      errors: Form.errorsSchema(form),
      dialog: Schema.Boolean
    })
    const namespaced = <S extends Schema.Top>(s: S) => Schema.Struct({ [ns]: s } as { readonly [K in Ns]: S })
    const signals = ds.make(namespaced(inner))
    const path = (...parts: Array<string>) => [ns, ...parts].join(".") as SignalPath
    const $ = (...parts: Array<string>) => `$${path(...parts)}`

    // TS can't index a mapped type over a generic key, hence the widening.
    const readQuery = Effect.map(
      Datastar.signals(namespaced(Schema.Struct({ query: scope.query.schema }))),
      (s) => (s as Readonly<Record<string, { readonly query: Q }>>)[ns]!.query
    )
    const readDraft = Effect.map(
      Datastar.signals(namespaced(Schema.Struct({ draft: draftSchema }))),
      (s) => (s as Readonly<Record<string, { readonly draft: Record<string, unknown> }>>)[ns]!.draft
    )
    /** The lock value from the `:scope` path param (`undefined` when this scope has no lock). */
    const readLock: Effect.Effect<string | undefined, ScopeError, HttpRouter.RouteContext> = lock === undefined
      ? Effect.succeed(undefined)
      : Effect.flatMap(HttpRouter.params, (params) => {
        const raw = params["scope"] ?? ""
        const value = lock.parse(raw)
        return value === undefined ? Effect.fail(new ScopeError({ raw })) : Effect.succeed(value)
      })
    const fullQuery = (q: Q, value: string | undefined): Query.ListQuery<Sortable, FK> =>
      lock && value !== undefined ? lock.apply(q, value) : (q as unknown as Query.ListQuery<Sortable, FK>)
    const inScope = (row: Row, value: string | undefined) =>
      lockKey === undefined || value === undefined || String((row as Record<string, unknown>)[lockKey]) === value
    /** `findById`, but rows outside the lock don't exist. */
    const findInScope = (id: IdType, value: string | undefined) =>
      Effect.gen(function*() {
        const row = yield* (yield* RepoTag).findById(id)
        return inScope(row, value) ? row : yield* Effect.fail(new Cause.NoSuchElementError())
      })

    const fieldErrors = (errors: Partial<Record<string, string>>) =>
      Datastar.patchSignals({ [ns]: { errors: { ...noErrors, ...errors } } })
    const closeDialog = Datastar.patchSignals({ [ns]: { dialog: false, draft: blankDraft, errors: noErrors } })
    const saveError = (e: SqlError.SqlError) => {
      const match = e.reason._tag === "UniqueViolation"
        ? pick(config.messages?.unique, e)
        : e.reason._tag === "ConstraintError"
        ? pick(invalidReference, e)
        : undefined
      if (!match) return unexpected(e)
      // The locked field isn't in the form (e.g. its row was deleted meanwhile): say so in a toast.
      return Effect.succeed(match[0] === lockKey ? toast(match[1], "error") : fieldErrors({ [match[0]]: match[1] }))
    }

    /** Canonical URL for a query, e.g. `/users?teamId=3&sort=name&dir=asc`. */
    const urlFor = (q: Query.ListQuery<Sortable, FK>) => {
      const qs = query.toSearchParams(q).toString()
      return qs ? `/${name}?${qs}` : `/${name}`
    }

    /** Selects whose options come from lookups; replaced so `data-bind` re-applies the signal value. */
    const relationSelects = (lookups: Components.Lookups): Array<Datastar.DatastarEvent> =>
      scopedRelations.flatMap(([key]) => {
        const filter = scope.query.filters.find((f) => f.key === key)
        const field = fields.find((f) => f.key === key)
        return [
          ...(filter
            ? [Datastar.patchElements(
              <Components.FilterSelect prefix={ns} filter={filter} query={path("query")} lookup={lookups[key]} />,
              { selector: `#${Components.filterId(ns, key)}`, mode: "replace" }
            )]
            : []),
          ...(field
            ? [Datastar.patchElements(
              <Components.FieldSelect
                prefix={ns}
                field={field}
                draft={path("draft")}
                errors={path("errors")}
                lookup={lookups[key]}
              />,
              { selector: `#${Components.fieldId(ns, key)}`, mode: "replace" }
            )]
            : [])
        ]
      })

    // --- endpoints ---------------------------------------------------------
    // Paths are typed as fixed literals (`/resource/:scope/:id`) so path params
    // type-check through the generic `name`; the real path is used at runtime
    // (an unlocked scope has no `:scope` segment, so that param is ignored).

    /**
     * Live view: re-runs when this table or any related table changes. Relation
     * selects are re-sent only when their options changed. When the scope owns
     * the URL, the first emission also patches `${ns}._url` (a local signal,
     * never sent back), which the page mirrors into the address bar.
     */
    const view = Endpoint.make(
      "GET",
      `${scope.base}/view` as "/resource/:scope/view",
      Stream.unwrap(Effect.gen(function*() {
        const repo = yield* RepoTag
        const services = yield* relationServices
        const value = yield* readLock
        const q = yield* readQuery
        const full = fullQuery(q, value)
        let lookups: Components.Lookups = {}
        let lastOptions: string | undefined
        let urlSent = false
        return repo.live(full, { dependsOn: services.map(([, l]) => l.table) }).pipe(
          // Lookups load with the first page and whenever a related table changes.
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
              // Only these rows changed, in ways that can't move them: patch each `<tr>` by id.
              return event.rows.map((row) => Datastar.patchElements(<RowView row={row} lookups={lookups} lock={value} />))
            }
            const page = event.page
            if (page.page > page.pages) {
              // Out of range (e.g. after deleting the last row on the last page): clamp.
              return Datastar.patchSignals({ [ns]: { query: { page: page.pages } } })
            }
            const events = [Datastar.patchElements(<TableView page={page} current={q} lookups={lookups} lock={value} />)]
            const key = JSON.stringify(lookups)
            if (key !== lastOptions) {
              lastOptions = key
              events.push(...relationSelects(lookups))
            }
            if (scope.syncUrl && !urlSent) {
              urlSent = true
              events.push(Datastar.patchSignals({ [ns]: { _url: urlFor(full) } }))
            }
            return events
          })
        )
      })).pipe(Stream.catch((error) => Stream.fromEffect(unexpected(error)))),
      { include: [path("query")] }
    )

    const save = (id?: IdType) =>
      Effect.gen(function*() {
        const repo = yield* RepoTag
        const value = yield* readLock
        const raw = yield* readDraft
        // The lock is not in the form; the server sets it (and ignores any sent value).
        const draft = lockKey !== undefined && value !== undefined ? { ...raw, [lockKey]: value } : raw
        // Unlocked scopes skip the check: the update or delete itself reports a missing row.
        if (id !== undefined && value !== undefined) yield* findInScope(id, value)
        const row = id === undefined
          ? yield* repo.insert((model.insert as any).make(yield* Form.decode(model.jsonCreate, draft)))
          : yield* repo.update((model.update as any).make({ ...(yield* Form.decode(model.jsonUpdate, draft)), [idColumn]: id }))
        return [closeDialog, toast(`${id === undefined ? "Created" : "Saved"} ${label(row)}`)]
      }).pipe(
        Effect.catchTags({
          SchemaError: (e) => Effect.succeed(fieldErrors(Form.errors(keys, e))),
          SqlError: saveError,
          SignalsError: unexpected,
          ScopeError: unexpected,
          NoSuchElementError: goneToast
        })
      )

    const create = Endpoint.make("POST", scope.base as "/resource/:scope", save(), { include: [path("draft")] })

    const update = Endpoint.make(
      "PUT",
      `${scope.base}/:id` as "/resource/:scope/:id",
      Effect.flatMap(readId, (id) => save(id)).pipe(Effect.catchTag("SchemaError", unexpected)),
      { include: [path("draft")] }
    )

    const edit = Endpoint.make(
      "GET",
      `${scope.base}/:id/edit` as "/resource/:scope/:id/edit",
      Effect.gen(function*() {
        const row = yield* findInScope(yield* readId, yield* readLock)
        const { [lockKey ?? ""]: _locked, ...draft } = Form.toDraft(model.jsonUpdate, row, row[idColumn])
        return Datastar.patchSignals({ [ns]: { dialog: true, draft, errors: noErrors } })
      }).pipe(
        Effect.catchTags({
          NoSuchElementError: goneToast,
          SchemaError: unexpected,
          SqlError: unexpected,
          ScopeError: unexpected
        })
      ),
      { include: [] }
    )

    const remove = Endpoint.make(
      "DELETE",
      `${scope.base}/:id` as "/resource/:scope/:id",
      Effect.gen(function*() {
        const repo = yield* RepoTag
        const id = yield* readId
        const value = yield* readLock
        if (value !== undefined) yield* findInScope(id, value)
        yield* repo.delete(id)
        return toast("Deleted")
      }).pipe(
        Effect.catchTags({
          SqlError: (e) =>
            e.reason._tag === "ConstraintError"
              ? Effect.succeed(
                toast(config.messages?.deleteRestricted ?? `This ${config.noun} is still referenced elsewhere.`, "error")
              )
              : unexpected(e),
          SchemaError: unexpected,
          ScopeError: unexpected,
          NoSuchElementError: goneToast
        })
      ),
      { include: [] }
    )

    // --- views -------------------------------------------------------------

    const columnsFor = (lookups: Components.Lookups): ReadonlyArray<Components.Column<Row>> =>
      columns.map((field) => ({
        field,
        sortable: (query.sortable as ReadonlyArray<string>).includes(field.key),
        render: cell(field, lookups, { link: true })
      }))

    const rowId = (row: Row) => `${ns}-${String(row[idColumn])}`
    const actions = (lock: string | undefined) => (row: Row) => {
      const at = { scope: lock ?? "", id: String(row[idColumn]) }
      return (
        <>
          <button class="link" {...ds.on("click", edit.call(at))}>Edit</button>
          <button
            class="link danger"
            {...ds.on("click", `confirm(${JSON.stringify(`Delete ${label(row)}?`)}) && ${remove.call(at)}`)}
          >
            Delete
          </button>
        </>
      )
    }

    /** A single row, as rendered in the table (same id), for row-level patches. */
    const RowView = (props: { readonly row: Row; readonly lookups: Components.Lookups; readonly lock: string | undefined }) => (
      <Components.TableRow row={props.row} columns={columnsFor(props.lookups)} rowId={rowId} actions={actions(props.lock)} />
    )

    const TableView = (props: {
      readonly page: Repo.Page<Row>
      readonly current: { readonly sort: string; readonly dir: Query.Dir }
      readonly lookups: Components.Lookups
      readonly lock: string | undefined
    }) => (
      <section id={`${ns}-table`}>
        <Components.Table
          id={`${ns}-rows`}
          columns={columnsFor(props.lookups)}
          rows={props.page.rows}
          rowId={rowId}
          query={path("query")}
          current={props.current}
          actions={actions(props.lock)}
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

    interface Initial {
      readonly page: Repo.Page<Row>
      readonly lookups: Components.Lookups
    }

    /**
     * Filters, live table, paging and dialog, server-rendered for `query`. The
     * live stream then takes over. Carries its own `data-signals`, so it can sit
     * inside any page.
     */
    const View = (props: { readonly query: Q; readonly lock: string | undefined; readonly initial?: Initial | undefined }) => {
      const scopeParam = { scope: props.lock ?? "" }
      const initialSignals = { [ns]: { query: props.query, draft: blankDraft, errors: noErrors, dialog: false } }
      return (
        <section
          id={`${ns}-section`}
          class="resource"
          {...ds.merge(
            signals.init(initialSignals as typeof signals.schema.Type),
            scope.syncUrl &&
              ds.effect(`${$("_url")} && ${$("_url")} !== location.pathname + location.search && history.replaceState(null, '', ${$("_url")})`)
          )}
        >
          <header class="bar">
            {scope.heading === "h1" ? <h1 safe>{scope.title}</h1> : <h2 safe>{scope.title}</h2>}
            <button
              {...ds.on(
                "click",
                `${$("draft")} = ${JSON.stringify(blankDraft)}; ${$("errors")} = ${JSON.stringify(noErrors)}; ${$("dialog")} = true`
              )}
            >
              New {config.noun}
            </button>
          </header>
          <Components.FilterBar prefix={ns} filters={scope.query.filters} query={path("query")} lookups={props.initial?.lookups} />
          <div
            id={`${ns}-live`}
            {...ds.merge(
              ds.init(view.call(scopeParam)),
              ds.onSignalPatch(view.call(scopeParam), { include: [path("query")], debounce: "200ms" })
            )}
          >
            {props.initial
              ? <TableView page={props.initial.page} current={props.query} lookups={props.initial.lookups} lock={props.lock} />
              : <section id={`${ns}-table`} aria-busy="true">Loading…</section>}
          </div>
          <Components.FormDialog
            prefix={ns}
            noun={config.noun}
            fields={fields}
            draft={path("draft")}
            errors={path("errors")}
            open={path("dialog")}
            submit={`${$("draft", "id")} ? ${update.call({ ...scopeParam, id: Endpoint.js($("draft", "id")) })} : ${
              create.call(scopeParam)
            }`}
            lookups={props.initial?.lookups}
          />
        </section>
      )
    }

    /** First page + lookups for the initial render; `None` (and logged) on failure, so the shell is still served. */
    const initial = (q: Q, value: string | undefined) =>
      Effect.gen(function*() {
        const repo = yield* RepoTag
        const services = yield* relationServices
        let current = q
        let page = yield* repo.list(fullQuery(current, value))
        if (page.page > page.pages) {
          current = { ...current, page: page.pages }
          page = yield* repo.list(fullQuery(current, value))
        }
        return { query: current, page, lookups: yield* lookupsFor(services) }
      }).pipe(
        Effect.tapError((e) => Effect.logError("initial render failed", e)),
        Effect.option
      )

    const routes = HttpRouter.addAll([view.route, create.route, update.route, edit.route, remove.route]) as Layer.Layer<
      never,
      never,
      HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", Requires>
    >

    return {
      signals,
      endpoints: { view, create, update, edit, remove },
      routes,
      View,
      initial
    }
  }

  // --- the list page -------------------------------------------------------

  const list = scoped({
    ns: name,
    base: `/${name}`,
    title: config.title,
    heading: "h1",
    query,
    lock: undefined,
    syncUrl: true
  })

  const html = (element: JSX.Element, status = 200) =>
    Effect.map(
      typeof element === "string" ? Effect.succeed(element) : Effect.promise(() => element),
      (body) => HttpServerResponse.html(body).pipe(HttpServerResponse.setStatus(status))
    )

  /** The list page, server-rendered for the query in the URL. */
  const Page = (props: {
    readonly query: Query.ListQuery<Sortable, FK>
    readonly initial?: { readonly page: Repo.Page<Row>; readonly lookups: Components.Lookups } | undefined
  }) => (
    <main>
      <list.View query={props.query} lock={undefined} initial={props.initial} />
      <Components.Toast />
    </main>
  )

  const page = HttpRouter.route(
    "GET",
    `/${name}`,
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const q = query.fromSearchParams(new URL(request.url, "http://localhost").searchParams)
      const initial = yield* list.initial(q, undefined)
      return yield* html(config.layout({
        title: config.title,
        active: `/${name}`,
        children: initial._tag === "Some"
          ? <Page query={initial.value.query} initial={initial.value} />
          : <Page query={q} />
      }))
    })
  )

  // --- the detail page -----------------------------------------------------

  /** The row's fields, or a notice once it has been deleted. Re-rendered live. */
  const RecordView = (props: { readonly row: Row | undefined; readonly lookups: Components.Lookups }) => {
    const row = props.row
    return (
      <section id={`${name}-record`}>
        {row === undefined
          ? (
            <>
              <h1>Not found</h1>
              <p safe>{`This ${config.noun} no longer exists.`}</p>
            </>
          )
          : (
            <>
              <h1 safe>{label(row)}</h1>
              <dl class="record">
                {tableFields.map((field) => {
                  const render = cell(field, props.lookups, { link: false })
                  return (
                    <>
                      <dt safe>{field.label}</dt>
                      <dd id={`${name}-record-${field.key}`}>
                        {render
                          ? render(row)
                          : <span safe>{Components.formatCell(field, (row as Record<string, unknown>)[field.key])}</span>}
                      </dd>
                    </>
                  )
                })}
              </dl>
            </>
          )}
      </section>
    )
  }

  const findRecord = (id: IdType) =>
    Effect.flatMap(RepoTag, (repo) => repo.findById(id)).pipe(
      Effect.map((row): Row | undefined => row),
      Effect.catchTag("NoSuchElementError", () => Effect.succeed(undefined))
    )

  /** Live record: re-renders on any change to this table or a related one (e.g. a rename). */
  const record = Endpoint.make(
    "GET",
    `/${name}/:id/view` as "/resource/:id/view",
    Stream.unwrap(Effect.gen(function*() {
      const reactivity = yield* Reactivity.Reactivity
      const services = yield* relationServices
      const id = yield* readId
      return reactivity.stream(
        [name, ...services.map(([, l]) => l.table)],
        Effect.all([findRecord(id), lookupsFor(services)])
      ).pipe(Stream.map(([row, lookups]) => Datastar.patchElements(<RecordView row={row} lookups={lookups} />)))
    })).pipe(Stream.catch((error) => Stream.fromEffect(unexpected(error)))),
    { include: [] }
  )

  const notFound = html(
    config.layout({
      title: "Not found",
      active: `/${name}`,
      children: (
        <main>
          <h1>Not found</h1>
          <p safe>{`There is no such ${config.noun}.`}</p>
          <p>
            <a href={`/${name}`} safe>{`← ${config.title}`}</a>
          </p>
        </main>
      )
    }),
    404
  )

  const detail = <RS,>(sections: (row: Row) => ReadonlyArray<Section<RS>>) =>
    HttpRouter.route(
      "GET",
      `/${name}/:id`,
      Effect.gen(function*() {
        const id = yield* Effect.option(readId)
        if (id._tag === "None") return yield* notFound
        const row = yield* findRecord(id.value)
        if (row === undefined) return yield* notFound
        const lookups = yield* lookupsFor(yield* relationServices)
        const extra = yield* Effect.all(sections(row))
        return yield* html(config.layout({
          title: label(row),
          active: `/${name}`,
          children: (
            <main>
              <p class="crumbs">
                <a href={`/${name}`} safe>{`← ${config.title}`}</a>
              </p>
              <div id={`${name}-record-live`} {...ds.init(record.call({ id: String(id.value) }))}>
                <RecordView row={row} lookups={lookups} />
              </div>
              {extra}
              <Components.Toast />
            </main>
          )
        }))
      })
    )

  /**
   * All routes, with `sections` appended to the detail page (rendered in
   * order, each with its own signals and live view).
   */
  const routesWith = <RS = never,>(options: { readonly sections?: (row: Row) => ReadonlyArray<Section<RS>> }) =>
    Layer.mergeAll(
      HttpRouter.addAll([page, record.route, detail(options.sections ?? (() => []))]),
      list.routes
    ) as Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", Requires | RS>>

  // --- embedding -----------------------------------------------------------

  /**
   * This resource's table as a section of another page, with the `eq` filter
   * `lock` fixed by the server:
   *
   *   const Members = Users.embed({ name: "members", title: "Members", lock: "teamId" })
   *   Members.Section(team.id)   // Effect<JSX.Element>, server-rendered
   *   Members.routes             // its live view, create, edit, update, delete
   *
   * The client never sees or sends the locked filter (signals that try to set
   * it are rejected), creates get it from the server, and edits/deletes of
   * rows outside the lock answer "no longer exists". Its query is not synced
   * to the URL: the page's URL belongs to the page.
   */
  const embed = <const Ns extends string, const Lock extends EqKeys<Filters> & FK>(options: {
    /** Signal namespace, DOM id prefix and route segment. Must differ from every other table on the page. */
    readonly name: Ns
    readonly title: string
    readonly lock: Lock
  }) => {
    const locked = query.lock(options.lock)
    const scope = scoped({
      ns: options.name,
      base: `/${name}/embed/${options.name}/:scope`,
      title: options.title,
      heading: "h2",
      query: locked,
      lock: locked,
      syncUrl: false
    })
    const Section = (value: Row[Lock & keyof Row]) =>
      Effect.gen(function*() {
        const lock = locked.parse(String(value))
        if (lock === undefined) return <p class="error" safe>{`Cannot show ${options.title}: invalid ${options.lock}.`}</p>
        const initial = yield* scope.initial(locked.initial, lock)
        return initial._tag === "Some"
          ? <scope.View query={initial.value.query} lock={lock} initial={initial.value} />
          : <scope.View query={locked.initial} lock={lock} />
      }) as Section<RepoOf<Name> | RelationServices<R>>
    return {
      name: options.name,
      signals: scope.signals,
      endpoints: scope.endpoints,
      routes: scope.routes,
      Section
    }
  }

  return {
    name,
    query,
    signals: list.signals,
    /** Repository service for this resource. */
    Repo: RepoTag,
    /** `{ value, label, href }` options of this resource, for other resources' relations. */
    Lookup: LookupTag,
    /** Provides `Repo` and `Lookup`. */
    layer,
    /** List page, its live table and mutations, and the detail page. */
    routes: routesWith({}),
    routesWith,
    embed,
    /** Link to a row's detail page. */
    href: (id: IdType) => href(id),
    endpoints: { ...list.endpoints, record },
    Page
  }
}
