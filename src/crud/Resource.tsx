/**
 * Level 3: CRUD resources from a model + a small typed config, in two steps.
 *
 * 1. `define`: one pure value per resource (model, table, query, display,
 *    messages). Definitions never refer to each other, so they can't form a cycle.
 *
 *      export const Users = Resource.define({ name: "users", model: User, idColumn: "id", ... })
 *      export const Teams = Resource.define({ name: "teams", model: Team, idColumn: "id", ... })
 *
 * 2. `app`: attach relations and detail-page sections once every definition
 *    exists. It registers every route once and checks (in the types) that each
 *    resource a relation or embed names is part of the app.
 *
 *      export const Resources = Resource.app(
 *        Users.with({ relations: { teamId: Teams } }),
 *        Teams.with({ sections: [Users.embed({ name: "members", title: "Members", lock: "teamId" })] })
 *      )
 *      Resources.routes                 // every route of every resource
 *      Resources.layer                  // every `Repo` and `Lookup`
 *      Resources.resources.users        // endpoints, messages, `Page`, ... (e.g. for `Api.make`)
 *
 * Routes per resource:
 *
 *   GET    /users              list page, server-rendered for the query in the URL
 *   GET    /users/view         live table
 *   POST   /users              create
 *   GET    /users/:id/edit     open the edit dialog
 *   PUT    /users/:id          update
 *   DELETE /users/:id          delete
 *   GET    /users/:id          detail page (fields, Edit, Delete, sections)
 *   GET    /users/:id/view     live record
 *
 * An embed (the users table on a team's page, with `teamId` locked) uses the
 * same table routes, with `?embed=members&scope=3`. The server looks up the
 * embed by name, decodes the scope with the lock field's own schema and applies
 * the lock; anything else is a `ScopeError`.
 *
 * Conventions (from `name`): table name, URL prefix `/${name}`, signal namespace
 * `${name}.{query,draft,errors,dialog}`, DOM id prefix. An embed uses its own
 * `name` for the signal namespace and DOM ids.
 */
import { Cause, Context, Data, Effect, Layer, Option, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Reactivity } from "effect/reactivity"
import type { Model } from "effect/schema"
import type { SqlClient, SqlError } from "effect/sql"
import * as stylex from "@stylexjs/stylex"
import { Fragment, type ReactElement, type ReactNode } from "react"
import * as ds from "../datastar/Attrs.ts"
import type { SignalPath } from "../datastar/Attrs.ts"
import * as Datastar from "../datastar/Datastar.ts"
import * as Endpoint from "../datastar/Endpoint.ts"
import * as Flash from "../datastar/Flash.ts"
import { document, render } from "../datastar/Html.ts"
import { Button } from "../ui/Button.tsx"
import { Alert, Card, EmptyState, Skeleton } from "../ui/display.tsx"
import { Icon } from "../ui/icons.tsx"
import { color, font, space } from "../ui/theme/tokens.stylex.ts"
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

/** What `Resource.define` needs from a model (any `Model.Class` satisfies it). */
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
/** `RepoOf` and `LookupOf` for each name in a union. */
export type ServicesOf<Name extends string> = Name extends string ? RepoOf<Name> | LookupOf<Name> : never

/** A lookup service tag (e.g. another resource's `Lookup`). */
export type LookupTag = Context.Key<LookupOf<string>, Lookup.Lookup>

/**
 * What a relation points at: a resource definition. `href` takes the target's
 * id, so a foreign key whose values aren't the target's ids is a type error.
 */
export interface Target<Id> {
  readonly name: string
  readonly Lookup: LookupTag
  readonly href: (id: Id) => string
}
type Relations<M extends ModelLike> = {
  readonly [K in Fields<M>]?: K extends keyof M["Type"] ? Target<NonNullable<M["Type"][K]>> : never
}
type RelationServices<R> = { [K in keyof R]: R[K] extends { readonly Lookup: Context.Key<infer I, any> } ? I : never }[keyof R]
type RelationNames<R> = { [K in keyof R]: R[K] extends { readonly name: infer N extends string } ? N : never }[keyof R]

/** Filter keys configured with the `eq` operator (the ones an embed can lock). */
type EqKeys<Filters> = { [K in keyof Filters & string]: Filters[K] extends "eq" ? K : never }[keyof Filters & string]

export interface Layout {
  (props: { readonly title: string; readonly active: string; readonly children: ReactNode }): ReactElement
}

export interface Config<
  Name extends string,
  M extends ModelLike,
  Id extends Fields<M>,
  Sortable extends Fields<M>,
  Filters extends Record<string, Query.Operator>
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
  readonly messages?: {
    /** Field errors for unique constraints (matched by column name in the DB error). */
    readonly unique?: { readonly [K in FormKey<M>]?: string }
    /** Field errors for foreign key violations. Defaults to "<Label> no longer exists" for relations. */
    readonly invalidReference?: { readonly [K in FormKey<M>]?: string }
    /** Toast when a delete is rejected because other rows still reference this one. */
    readonly deleteRestricted?: string
  }
  /** Custom table cells. */
  readonly columns?: { readonly [K in Fields<M>]?: (row: M["Type"], lookups: Components.Lookups) => ReactNode }
  /** Columns not shown in the table (default: the id). */
  readonly hidden?: ReadonlyArray<Fields<M>>
  readonly layout: Layout
}

/** A resource's constraint-violation messages, resolved (see `Config["messages"]`). */
export interface Messages {
  /** Field -> message for unique constraints. */
  readonly unique: Readonly<Partial<Record<string, string>>>
  /** Field -> message for foreign key violations (relations get a default). */
  readonly invalidReference: Readonly<Partial<Record<string, string>>>
  readonly deleteRestricted: string | undefined
}

/** A server-rendered section of the detail page. Failures must be handled (rendered) first. */
export type Section<R> = Effect.Effect<ReactNode, never, R>

/**
 * A resource's table to show on another resource's detail page, with one `eq`
 * filter locked to that page's row id (see `Definition.embed`). `V` is the
 * lock column's value type: the parent's id type must be assignable to it.
 */
export interface Embed<Target extends string, V> {
  readonly _tag: "Embed"
  /** The embedded resource. */
  readonly target: Target
  /** Signal namespace, DOM id prefix and `?embed=` value. */
  readonly name: string
  readonly title: string
  readonly lock: string
  readonly "~value"?: ((value: V) => void) | undefined
}
type AnyEmbed = Embed<string, never>
type SectionInput<Row, Id> = Embed<string, Id> | ((row: Row) => Section<unknown>)
type SectionRequires<S> = S extends (row: never) => Effect.Effect<unknown, unknown, infer R> ? R : never
type EmbedTargets<S> = S extends Embed<infer T, never> ? T : never

/** The `?embed=&scope=` of a request did not name an embed, or its scope is not a valid lock value. */
export class ScopeError extends Data.TaggedError("ScopeError")<{ readonly embed: string | null; readonly raw: string | null }> {}

/** What `build` hands to `app`: the resource, its embeds as sections, and its routes. */
interface Built<Res> {
  readonly resource: Res
  readonly section: (embed: AnyEmbed) => (value: unknown) => Section<unknown>
  readonly routes: (sectionOf: (embed: AnyEmbed) => (value: unknown) => Section<unknown>) => Layer.Layer<never>
}

/**
 * A resource ready for `app`: a definition (`Users`) or a definition with
 * relations and sections (`Users.with({...})`).
 */
export interface Spec<Name extends string, Needs extends string, Requires, Res> {
  readonly name: Name
  readonly layer: Layer.Layer<RepoOf<Name> | LookupOf<Name>, never, SqlClient.SqlClient | Reactivity.Reactivity>
  readonly embeds: ReadonlyArray<AnyEmbed>
  readonly build: (embeds: ReadonlyArray<AnyEmbed>) => Built<Res>
  /** Type-level only: the resources this one needs in the app (relation targets, embedded resources). */
  readonly "~needs"?: Needs | undefined
  /** Type-level only: what its routes require. */
  readonly "~requires"?: Requires | undefined
}

interface AnySpec {
  readonly name: string
  readonly layer: Layer.Layer<never, never, SqlClient.SqlClient | Reactivity.Reactivity>
  readonly embeds: ReadonlyArray<AnyEmbed>
  readonly build: (embeds: ReadonlyArray<AnyEmbed>) => Built<unknown>
  readonly "~needs"?: string | undefined
  readonly "~requires"?: unknown
}

/** The search params that pick an embed's table (`?embed=members&scope=3`) or the detail page (`?from=detail`). */
const EMBED = "embed"
const SCOPE = "scope"
const FROM = "from"

/** Signals under one namespace: `{ [ns]: schema }` read back as `schema`'s type. */
const readSignals = <S extends Schema.Codec<any, any, never, never>>(ns: string, schema: S) =>
  Effect.map(Datastar.signals(Schema.Struct({ [ns]: schema })), (s) => (s as Readonly<Record<string, S["Type"]>>)[ns]!)

/** `variant.make(value)` for a model variant whose input TS can't relate to `value` generically. */
const construct = <T,>(variant: unknown, value: unknown): T => (variant as { make: (v: unknown) => T }).make(value)

// ---------------------------------------------------------------------------
// define
// ---------------------------------------------------------------------------

export const define = <
  const Name extends string,
  M extends ModelLike,
  const Id extends Fields<M> & keyof M["update"]["Type"] & keyof M["Type"],
  const Sortable extends Fields<M>,
  const Filters extends { readonly [K in Fields<M>]?: Query.Operator }
>(config: Config<Name, M, Id, Sortable, Filters & Record<string, Query.Operator>>) => {
  const { name, model, idColumn } = config
  type FK = keyof Filters & string
  type Row = M["Type"]
  type IdType = M["fields"][Id]["Type"]

  // --- derived schemas -----------------------------------------------------

  const query: Query.QueryDef<Sortable, FK> = Query.make(model, config.query)
  const formFields = Form.fields(model.jsonCreate)
  const hidden: ReadonlyArray<string> = config.hidden ?? [idColumn]
  const tableFields = Form.fields(model).filter((f) => !hidden.includes(f.key))

  // Ids are numbers in the path (TS can't see that through the generic model).
  const IdSchema = model.fields[idColumn] as unknown as Schema.Codec<IdType, number>
  const IdParams = Schema.Struct({ id: Schema.NumberFromString.pipe(Schema.decodeTo(IdSchema)) })
  const readId = Effect.map(HttpRouter.schemaPathParams(IdParams), (p) => p.id)
  const get = (row: Row, key: string): unknown => (row as Record<string, unknown>)[key]
  const label = (row: Row) => String(get(row, config.display))
  const href = (id: IdType) => `/${name}/${encodeURIComponent(String(id))}`

  // --- services ------------------------------------------------------------

  const RepoTag = Context.Service<RepoOf<Name>, Repo.Repo<M, Id, Sortable, FK>>(`${name}/Repo`)
  const LookupTag = Context.Service<LookupOf<Name>, Lookup.Lookup>(`${name}/Lookup`)
  const layer = Layer.mergeAll(
    Layer.effect(RepoTag, Repo.make(model, { table: name, idColumn, query })),
    Layer.effect(LookupTag, Lookup.make({ table: name, value: idColumn, label: config.display, href }))
  )

  /** What a definition and an assembled resource both expose. */
  const base = {
    name,
    title: config.title,
    noun: config.noun,
    model,
    idColumn,
    query,
    /** Repository service for this resource. */
    Repo: RepoTag,
    /** `{ value, label, href }` options of this resource, for other resources' relations. */
    Lookup: LookupTag,
    /** Provides `Repo` and `Lookup`. */
    layer,
    /** Link to a row's detail page. */
    href
  }

  // --- build: everything that depends on relations and embeds -------------

  const build = (
    relations: ReadonlyArray<readonly [string, LookupTag]>,
    sections: ReadonlyArray<SectionInput<Row, IdType>>,
    embeds: ReadonlyArray<AnyEmbed>
  ) => {
    // --- error mapping -----------------------------------------------------

    const dbText = (e: SqlError.SqlError) => `${e.reason.message ?? ""} ${String(e.reason.cause ?? "")}`
    /** Pick the configured field whose column name appears in the DB error (else the first). */
    const pick = (messages: Partial<Record<string, string>> | undefined, e: SqlError.SqlError) => {
      const entries = Object.entries(messages ?? {}).filter((x): x is [string, string] => x[1] !== undefined)
      const text = dbText(e)
      return entries.find(([k]) => text.includes(k)) ?? entries[0]
    }
    const messages: Messages = {
      unique: config.messages?.unique ?? {},
      invalidReference: {
        ...Object.fromEntries(
          relations.map(([k]) => [k, `${formFields.find((f) => f.key === k)?.label ?? k} no longer exists`])
        ),
        ...config.messages?.invalidReference
      },
      deleteRestricted: config.messages?.deleteRestricted
    }
    const goneToast = () => Effect.succeed(toast(`That ${config.noun} no longer exists`, "error"))

    // --- shared rendering --------------------------------------------------

    const relationServices = Effect.forEach(relations, ([key, tag]) => Effect.map(Effect.service(tag), (l) => [key, l] as const))
    const lookupsFor = (services: ReadonlyArray<readonly [string, Lookup.Lookup]>) =>
      Effect.map(
        Effect.forEach(services, ([key, l]) => Effect.map(l.options, (o) => [key, o] as const)),
        (entries): Components.Lookups => Object.fromEntries(entries)
      )

    /** How a field's value is shown: custom cell, linked relation label, linked display, or formatted value. */
    const cell = (field: Field.FieldInfo, lookups: Components.Lookups, options: { readonly link: boolean }) => {
      const custom = (config.columns as Record<string, ((row: Row, l: Components.Lookups) => ReactNode) | undefined>)
        ?.[field.key]
      if (custom) return (row: Row) => custom(row, lookups)
      if (relations.some(([k]) => k === field.key)) {
        const byValue = new Map((lookups[field.key] ?? []).map((o) => [o.value, o]))
        return (row: Row) => {
          const v = get(row, field.key)
          if (v === null || v === undefined) return <span {...stylex.props(styles.subtle)}>—</span>
          const option = byValue.get(String(v))
          if (!option) return <span>?</span>
          return option.href ? <a href={option.href} {...stylex.props(styles.link)}>{option.label}</a> : <span>{option.label}</span>
        }
      }
      if (options.link && field.key === config.display) {
        return (row: Row) => <a href={href(row[idColumn])} {...stylex.props(styles.link, styles.strong)}>{label(row)}</a>
      }
      return undefined
    }

    // --- endpoints ---------------------------------------------------------
    //
    // One route each. The list page's table and every embed's table share the
    // table routes; `?embed=&scope=` picks the table and its lock value.

    type Lock = string | undefined
    type Events = Datastar.Events
    type Req = RepoOf<Name> | LookupOf<string> | HttpServerRequest.HttpServerRequest
    interface Table {
      readonly view: (lock: Lock) => Stream.Stream<Events, never, Req>
      readonly save: (id: IdType | undefined, lock: Lock) => Effect.Effect<Events, never, Req>
      readonly edit: (id: IdType, lock: Lock) => Effect.Effect<Events, never, Req>
      /** `deleted`: the events to send once the row is gone. */
      readonly remove: (id: IdType, lock: Lock, deleted: Events) => Effect.Effect<Events, never, Req>
    }
    interface Locked {
      readonly table: Table
      readonly parse: (raw: string) => string | undefined
    }
    const tables = new Map<string, Locked>()

    const searchParams = Effect.map(
      HttpServerRequest.HttpServerRequest,
      (request) => new URL(request.url, "http://localhost").searchParams
    )
    /** The table a request is for: the list's, or an embed's with its validated lock value. */
    const target = Effect.flatMap(searchParams, (params): Effect.Effect<{ table: Table; lock: Lock }, ScopeError> => {
      const embed = params.get(EMBED)
      const raw = params.get(SCOPE)
      if (embed === null && raw === null) return Effect.succeed({ table: list, lock: undefined })
      const locked = embed === null ? undefined : tables.get(embed)
      const lock = locked?.parse(raw ?? "")
      return locked === undefined || lock === undefined
        ? Effect.fail(new ScopeError({ embed, raw }))
        : Effect.succeed({ table: locked.table, lock })
    })

    const prefix = `/${name}` as const

    const view = Endpoint.make(
      "GET",
      "/view",
      Stream.unwrap(Effect.map(target, (t) => t.table.view(t.lock))).pipe(
        Stream.catch((error) => Stream.fromEffect(unexpected(error)))
      ),
      { prefix }
    )
    const create = Endpoint.make(
      "POST",
      "",
      Effect.flatMap(target, (t) => t.table.save(undefined, t.lock)).pipe(Effect.catchTag("ScopeError", unexpected)),
      { prefix }
    )
    /** Runs `f` with the path's id and the request's table; a bad id or scope is a toast. */
    const onRow = (f: (id: IdType, table: Table, lock: Lock) => Effect.Effect<Events, never, Req>) =>
      Effect.gen(function*() {
        const id = yield* readId
        const t = yield* target
        return yield* f(id, t.table, t.lock)
      }).pipe(Effect.catchTags({ SchemaError: unexpected, ScopeError: unexpected }))

    const update = Endpoint.make("PUT", "/:id", onRow((id, table, lock) => table.save(id, lock)), { prefix })
    const edit = Endpoint.make("GET", "/:id/edit", onRow((id, table, lock) => table.edit(id, lock)), { prefix, include: [] })
    /**
     * Delete. From the detail page (`?from=detail`), a successful delete goes back to the
     * list, which shows the toast (a flash message: see `Flash`).
     */
    const remove = Endpoint.make(
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
    )

    // --- a table -----------------------------------------------------------
    //
    // The list page and every embed share this: a filter bar, live table,
    // paging and a create/edit dialog in their own signal namespace. An embed
    // adds a lock: one filter the server fixes from `?scope=`, which also
    // prefills creates and bounds edits and deletes.

    const table = <QK extends string>(options: {
      readonly ns: string
      readonly title: string
      readonly heading: "h1" | "h2"
      readonly query: {
        readonly schema: Schema.Codec<Query.ListQuery<Sortable, QK>, Query.ListQuery<Sortable, QK>>
        readonly initial: Query.ListQuery<Sortable, QK>
        readonly filters: ReadonlyArray<Query.FilterInfo>
      }
      /** The locked filter, if any. */
      readonly lockKey: string | undefined
      /** The query the server runs: the client's, plus the lock. */
      readonly full: (q: Query.ListQuery<Sortable, QK>, lock: Lock) => Query.ListQuery<Sortable, FK>
      /** Mirror the query into the address bar (only one table per page can own the URL). */
      readonly syncUrl: boolean
    }) => {
      const { ns, lockKey } = options
      type Q = Query.ListQuery<Sortable, QK>
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

      const editorSchema = { draft: draftSchema, errors: Form.errorsSchema(form), dialog: Schema.Boolean }
      const signals = ds.make(Schema.Struct({ [ns]: Schema.Struct({ query: options.query.schema, ...editorSchema }) }))
      const editorSignals = ds.make(Schema.Struct({ [ns]: Schema.Struct(editorSchema) }))
      const path = (...parts: Array<string>) => [ns, ...parts].join(".") as SignalPath
      const $ = (...parts: Array<string>) => `$${path(...parts)}`
      const search = (lock: Lock) => (lock === undefined ? undefined : { [EMBED]: ns, [SCOPE]: lock })

      const readQuery = Effect.map(readSignals(ns, Schema.Struct({ query: options.query.schema })), (s) => s.query)
      const readDraft = Effect.map(readSignals(ns, Schema.Struct({ draft: draftSchema })), (s) => s.draft)
      const inScope = (row: Row, lock: Lock) => lockKey === undefined || lock === undefined || String(get(row, lockKey)) === lock
      /** `findById`, but rows outside the lock don't exist. */
      const findInScope = (id: IdType, lock: Lock) =>
        Effect.gen(function*() {
          const row = yield* (yield* RepoTag).findById(id)
          return inScope(row, lock) ? row : yield* Effect.fail(new Cause.NoSuchElementError())
        })

      const fieldErrors = (errors: Partial<Record<string, string>>) =>
        Datastar.patchSignals({ [ns]: { errors: { ...noErrors, ...errors } } })
      const closeDialog = Datastar.patchSignals({ [ns]: { dialog: false, draft: blankDraft, errors: noErrors } })
      const saveError = (e: SqlError.SqlError) => {
        const match = e.reason._tag === "UniqueViolation"
          ? pick(messages.unique, e)
          : e.reason._tag === "ConstraintError"
          ? pick(messages.invalidReference, e)
          : undefined
        if (!match) return unexpected(e)
        // The locked field isn't in the form (e.g. its row was deleted meanwhile): say so in a toast.
        return Effect.succeed(match[0] === lockKey ? toast(match[1], "error") : fieldErrors({ [match[0]]: match[1] }))
      }

      /** Canonical URL for a query, e.g. `/users?teamId=3&sort=name&dir=asc`. */
      const urlFor = (q: Query.ListQuery<Sortable, FK>) => {
        const qs = query.toSearchParams(q).toString()
        return qs ? `${prefix}?${qs}` : prefix
      }

      /** Form selects whose options come from lookups; replaced so `data-bind` re-applies the signal value. */
      const fieldSelects = (lookups: Components.Lookups): Array<Datastar.DatastarEvent> =>
        scopedRelations.flatMap(([key]) => {
          const field = fields.find((f) => f.key === key)
          return field
            ? [Datastar.patchElements(
              render(
                <Components.FieldSelect prefix={ns} field={field} draft={path("draft")} errors={path("errors")} lookup={lookups[key]} />
              ),
              { selector: `#${Components.fieldId(ns, key)}`, mode: "replace" }
            )]
            : []
        })
      /** Filter and form selects whose options come from lookups. */
      const relationSelects = (lookups: Components.Lookups): Array<Datastar.DatastarEvent> => [
        ...scopedRelations.flatMap(([key]) => {
          const filter = options.query.filters.find((f) => f.key === key)
          return filter
            ? [Datastar.patchElements(
              render(<Components.FilterSelect prefix={ns} filter={filter} query={path("query")} lookup={lookups[key]} />),
              { selector: `#${Components.filterId(ns, key)}`, mode: "replace" }
            )]
            : []
        }),
        ...fieldSelects(lookups)
      ]

      // --- handlers ----------------------------------------------------------

      /**
       * Live view: re-runs when this table or any related table changes. Relation
       * selects are re-sent only when their options changed. When the table owns
       * the URL, the first emission also patches `${ns}._url` (a local signal,
       * never sent back), which the page mirrors into the address bar.
       */
      const liveView = (lock: Lock): Stream.Stream<Events, never, Req> =>
        Stream.unwrap(Effect.gen(function*() {
          const repo = yield* RepoTag
          const services = yield* relationServices
          const q = yield* readQuery
          const full = options.full(q, lock)
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
            Stream.map((event): Events => {
              if (event._tag === "Rows") {
                // Only these rows changed, in ways that can't move them: patch each `<tr>` by id.
                return event.rows.map((row) => Datastar.patchElements(render(<RowView row={row} lookups={lookups} lock={lock} />)))
              }
              const page = event.page
              if (page.page > page.pages) {
                // Out of range (e.g. after deleting the last row on the last page): clamp.
                return Datastar.patchSignals({ [ns]: { query: { page: page.pages } } })
              }
              const events = [
                Datastar.patchElements(render(<TableView page={page} current={q} lookups={lookups} lock={lock} />))
              ]
              const key = JSON.stringify(lookups)
              if (key !== lastOptions) {
                lastOptions = key
                events.push(...relationSelects(lookups))
              }
              if (options.syncUrl && !urlSent) {
                urlSent = true
                events.push(Datastar.patchSignals({ [ns]: { _url: urlFor(full) } }))
              }
              return events
            })
          )
        })).pipe(Stream.catch((error) => Stream.fromEffect(unexpected(error))))

      const save = (id: IdType | undefined, lock: Lock) =>
        Effect.gen(function*() {
          const repo = yield* RepoTag
          const raw = yield* readDraft
          // The lock is not in the form; the server sets it (and ignores any sent value).
          const draft = lockKey !== undefined && lock !== undefined ? { ...raw, [lockKey]: lock } : raw
          // Unlocked tables skip the check: the update itself reports a missing row.
          if (id !== undefined && lock !== undefined) yield* findInScope(id, lock)
          const row = id === undefined
            ? yield* repo.insert(construct(model.insert, yield* Form.decode(model.jsonCreate, draft)))
            : yield* repo.update(construct(model.update, { ...(yield* Form.decode(model.jsonUpdate, draft)), [idColumn]: id }))
          return [closeDialog, toast(`${id === undefined ? "Created" : "Saved"} ${label(row)}`)]
        }).pipe(
          Effect.catchTags({
            SchemaError: (e) => Effect.succeed(fieldErrors(Form.errors(keys, e))),
            SqlError: saveError,
            SignalsError: unexpected,
            NoSuchElementError: goneToast
          })
        )

      const openEdit = (id: IdType, lock: Lock) =>
        Effect.gen(function*() {
          const row = yield* findInScope(id, lock)
          const { [lockKey ?? ""]: _locked, ...draft } = Form.toDraft(model.jsonUpdate, row, row[idColumn])
          return Datastar.patchSignals({ [ns]: { dialog: true, draft, errors: noErrors } })
        }).pipe(
          Effect.catchTags({ NoSuchElementError: goneToast, SchemaError: unexpected, SqlError: unexpected })
        )

      const removeRow = (id: IdType, lock: Lock, deleted: Events) =>
        Effect.gen(function*() {
          const repo = yield* RepoTag
          if (lock !== undefined) yield* findInScope(id, lock)
          yield* repo.delete(id)
          return deleted
        }).pipe(
          Effect.catchTags({
            SqlError: (e) =>
              e.reason._tag === "ConstraintError"
                ? Effect.succeed(
                  toast(messages.deleteRestricted ?? `This ${config.noun} is still referenced elsewhere.`, "error")
                )
                : unexpected(e),
            SchemaError: unexpected,
            NoSuchElementError: goneToast
          })
        )

      // --- views -------------------------------------------------------------

      const columnsFor = (lookups: Components.Lookups): ReadonlyArray<Components.Column<Row>> =>
        columns.map((field) => ({
          field,
          sortable: (query.sortable as ReadonlyArray<string>).includes(field.key),
          render: cell(field, lookups, { link: true })
        }))

      const rowId = (row: Row) => `${ns}-${String(row[idColumn])}`
      const actions = (lock: Lock) => (row: Row) => {
        const id = String(row[idColumn])
        return (
          <Components.RowActions
            edit={edit.call({ id }, { search: search(lock) })}
            remove={`confirm(${JSON.stringify(`Delete ${label(row)}?`)}) && ${remove.call({ id }, { search: search(lock) })}`}
          />
        )
      }

      /** A single row, as rendered in the table (same id), for row-level patches. */
      const RowView = (props: { readonly row: Row; readonly lookups: Components.Lookups; readonly lock: Lock }) => (
        <Components.TableRow row={props.row} columns={columnsFor(props.lookups)} rowId={rowId} actions={actions(props.lock)} />
      )

      const TableView = (props: {
        readonly page: Repo.Page<Row>
        readonly current: { readonly sort: string; readonly dir: Query.Dir }
        readonly lookups: Components.Lookups
        readonly lock: Lock
      }) => (
        <Components.TablePanel id={`${ns}-table`}>
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
        </Components.TablePanel>
      )

      /** The create/edit dialog (create when `draft.id` is blank). */
      const Dialog = (props: { readonly lock: Lock; readonly lookups?: Components.Lookups | undefined }) => (
        <Components.FormDialog
          prefix={ns}
          noun={config.noun}
          fields={fields}
          draft={path("draft")}
          errors={path("errors")}
          open={path("dialog")}
          submit={`${$("draft", "id")} ? ${
            update.call({ id: Endpoint.js($("draft", "id")) }, { include: [path("draft")], search: search(props.lock) })
          } : ${create.call(undefined, { include: [path("draft")], search: search(props.lock) })}`}
          lookups={props.lookups}
        />
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
      const View = (props: { readonly query: Q; readonly lock: Lock; readonly initial?: Initial | undefined }) => {
        const liveCall = view.call(undefined, { include: [path("query")], search: search(props.lock) })
        return (
          <section
            id={`${ns}-section`}
            {...stylex.props(styles.section)}
            {...ds.merge(
              signals.init({ [ns]: { query: props.query, draft: blankDraft, errors: noErrors, dialog: false } }),
              options.syncUrl &&
                ds.effect(`${$("_url")} && ${$("_url")} !== location.pathname + location.search && history.replaceState(null, '', ${$("_url")})`)
            )}
          >
            <header {...stylex.props(styles.bar)}>
              {options.heading === "h1"
                ? <h1 {...stylex.props(styles.h1)}>{options.title}</h1>
                : <h2 {...stylex.props(styles.h2)}>{options.title}</h2>}
              <Button
                variant="primary"
                icon="plus"
                {...ds.on(
                  "click",
                  `${$("draft")} = ${JSON.stringify(blankDraft)}; ${$("errors")} = ${JSON.stringify(noErrors)}; ${$("dialog")} = true`
                )}
              >
                {`New ${config.noun}`}
              </Button>
            </header>
            <Components.FilterBar prefix={ns} filters={options.query.filters} query={path("query")} lookups={props.initial?.lookups} />
            <div
              id={`${ns}-live`}
              {...ds.merge(ds.init(liveCall), ds.onSignalPatch(liveCall, { include: [path("query")], debounce: "200ms" }))}
            >
              {props.initial
                ? <TableView page={props.initial.page} current={props.query} lookups={props.initial.lookups} lock={props.lock} />
                : (
                  <Components.TablePanel id={`${ns}-table`} busy>
                    <div {...stylex.props(styles.loading)}>
                      <Skeleton lines={4} />
                    </div>
                  </Components.TablePanel>
                )}
            </div>
            <Dialog lock={props.lock} lookups={props.initial?.lookups} />
          </section>
        )
      }

      /** Just the edit dialog and its signals, for a page without the table (the detail page). */
      const Editor = (props: { readonly lookups: Components.Lookups }) => (
        <div {...editorSignals.init({ [ns]: { draft: blankDraft, errors: noErrors, dialog: false } })}>
          <Dialog lock={undefined} lookups={props.lookups} />
        </div>
      )

      /** First page + lookups for the initial render; `None` (and logged) on failure, so the shell is still served. */
      const initial = (q: Q, lock: Lock) =>
        Effect.gen(function*() {
          const repo = yield* RepoTag
          const services = yield* relationServices
          let current = q
          let page = yield* repo.list(options.full(current, lock))
          if (page.page > page.pages) {
            current = { ...current, page: page.pages }
            page = yield* repo.list(options.full(current, lock))
          }
          return { query: current, page, lookups: yield* lookupsFor(services) }
        }).pipe(
          Effect.tapError((e) => Effect.logError("initial render failed", e)),
          Effect.option
        )

      const handlers: Table = { view: liveView, save, edit: openEdit, remove: removeRow }
      return { handlers, View, Editor, initial, fieldSelects }
    }

    // --- the list page -----------------------------------------------------

    const listTable = table({
      ns: name,
      title: config.title,
      heading: "h1",
      query,
      lockKey: undefined,
      full: (q) => q,
      syncUrl: true
    })
    const list = listTable.handlers

    const html = (element: ReactNode, status = 200) =>
      Effect.sync(() => HttpServerResponse.html(document(element)).pipe(HttpServerResponse.setStatus(status)))

    /** The list page, server-rendered for the query in the URL. */
    const Page = (props: {
      readonly query: Query.ListQuery<Sortable, FK>
      readonly initial?: { readonly page: Repo.Page<Row>; readonly lookups: Components.Lookups } | undefined
      /** A toast carried over a redirect (e.g. "Deleted" after a delete on the detail page). */
      readonly flash?: Flash.Flash | undefined
    }) => (
      <main>
        <listTable.View query={props.query} lock={undefined} initial={props.initial} />
        <Components.Toast message={props.flash?.message} kind={props.flash?.kind} />
      </main>
    )

    const page = HttpRouter.route(
      "GET",
      prefix,
      Effect.gen(function*() {
        const params = yield* searchParams
        const q = query.fromSearchParams(params)
        const initial = yield* listTable.initial(q, undefined)
        const flash = Option.getOrUndefined(yield* Flash.take)
        const response = yield* html(config.layout({
          title: config.title,
          active: prefix,
          children: initial._tag === "Some"
            ? <Page query={initial.value.query} initial={initial.value} flash={flash} />
            : <Page query={q} flash={flash} />
        }))
        return flash === undefined ? response : Flash.clear(response)
      })
    )

    // --- embeds ------------------------------------------------------------

    const embedSections = new Map<string, (value: unknown) => Section<unknown>>()
    for (const embed of embeds) {
      if (tables.has(embed.name)) throw new Error(`Resource ${name}: two embeds are named "${embed.name}"`)
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
      tables.set(embed.name, { table: embedded.handlers, parse: locked.parse })
      embedSections.set(embed.name, (value) =>
        Effect.gen(function*() {
          const lock = locked.parse(String(value))
          if (lock === undefined) {
            return <Alert tone="danger">{`Cannot show ${embed.title}: invalid ${embed.lock}.`}</Alert>
          }
          const initial = yield* embedded.initial(locked.initial, lock)
          return initial._tag === "Some"
            ? <embedded.View query={initial.value.query} lock={lock} initial={initial.value} />
            : <embedded.View query={locked.initial} lock={lock} />
        }))
    }

    // --- the detail page ---------------------------------------------------

    /** The row's fields with Edit and Delete, or a notice once it has been deleted. Re-rendered live. */
    const RecordView = (props: { readonly row: Row | undefined; readonly lookups: Components.Lookups }) => {
      const row = props.row
      if (row === undefined) {
        return (
          <section id={`${name}-record`} {...stylex.props(styles.record)}>
            <h1 {...stylex.props(styles.h1)}>Not found</h1>
            <Alert tone="warning">{`This ${config.noun} no longer exists.`}</Alert>
          </section>
        )
      }
      const id = String(row[idColumn])
      return (
        <section id={`${name}-record`} {...stylex.props(styles.record)}>
          <header {...stylex.props(styles.bar, styles.flush)}>
            <h1 {...stylex.props(styles.h1)}>{label(row)}</h1>
            <span {...stylex.props(styles.actions)}>
              <Button icon="edit" {...ds.on("click", edit.call({ id }))}>Edit</Button>
              <Button
                variant="danger"
                icon="trash"
                {...ds.on(
                  "click",
                  `confirm(${JSON.stringify(`Delete ${label(row)}?`)}) && ${remove.call({ id }, { search: { [FROM]: "detail" } })}`
                )}
              >
                Delete
              </Button>
            </span>
          </header>
          <Card>
            <dl {...stylex.props(styles.dl)}>
              {tableFields.map((field) => {
                const custom = cell(field, props.lookups, { link: false })
                return (
                  <div key={field.key} {...stylex.props(styles.dlRow)}>
                    <dt {...stylex.props(styles.dt)}>{field.label}</dt>
                    <dd id={`${name}-record-${field.key}`} {...stylex.props(styles.dd)}>
                      {custom ? custom(row) : <Components.CellValue field={field} value={get(row, field.key)} />}
                    </dd>
                  </div>
                )
              })}
            </dl>
          </Card>
        </section>
      )
    }

    const findRecord = (id: IdType) =>
      Effect.flatMap(RepoTag, (repo) => repo.findById(id)).pipe(
        Effect.map((row): Row | undefined => row),
        Effect.catchTag("NoSuchElementError", () => Effect.succeed(undefined))
      )

    /**
     * Live record: re-renders on any change to this table or a related one (e.g.
     * a rename), and re-sends the edit dialog's relation selects when their
     * options change.
     */
    const record = Endpoint.make(
      "GET",
      "/:id/view",
      Stream.unwrap(Effect.gen(function*() {
        const reactivity = yield* Reactivity.Reactivity
        const services = yield* relationServices
        const id = yield* readId
        let lastOptions: string | undefined
        return reactivity.stream(
          [name, ...services.map(([, l]) => l.table)],
          Effect.all([findRecord(id), lookupsFor(services)])
        ).pipe(Stream.map(([row, lookups]): Events => {
          const events = [Datastar.patchElements(render(<RecordView row={row} lookups={lookups} />))]
          const key = JSON.stringify(lookups)
          if (lastOptions !== undefined && key !== lastOptions) events.push(...listTable.fieldSelects(lookups))
          lastOptions = key
          return events
        }))
      })).pipe(Stream.catch((error) => Stream.fromEffect(unexpected(error)))),
      { prefix, include: [] }
    )

    const notFound = html(
      config.layout({
        title: "Not found",
        active: prefix,
        children: (
          <main>
            <Card>
              <EmptyState
                icon="alert"
                title="Not found"
                action={<a href={prefix} {...stylex.props(styles.link)}>{`Back to ${config.title}`}</a>}
              >
                {`There is no such ${config.noun}.`}
              </EmptyState>
            </Card>
          </main>
        )
      }),
      404
    )

    const detail = (sectionOf: (embed: AnyEmbed) => (value: unknown) => Section<unknown>) =>
      HttpRouter.route(
        "GET",
        `${prefix}/:id`,
        Effect.gen(function*() {
          const id = yield* Effect.option(readId)
          if (id._tag === "None") return yield* notFound
          const row = yield* findRecord(id.value)
          if (row === undefined) return yield* notFound
          const lookups = yield* lookupsFor(yield* relationServices)
          const extra = yield* Effect.all(
            sections.map((section) => typeof section === "function" ? section(row) : sectionOf(section)(row[idColumn]))
          )
          return yield* html(config.layout({
            title: label(row),
            active: prefix,
            children: (
              <main>
                <p {...stylex.props(styles.crumbs)}>
                  <a href={prefix} {...stylex.props(styles.crumb)}>
                    <Icon name="arrowLeft" size={14} />
                    {config.title}
                  </a>
                </p>
                <div id={`${name}-record-live`} {...ds.init(record.call({ id: String(id.value) }))}>
                  <RecordView row={row} lookups={lookups} />
                </div>
                {extra.map((section, i) => <Fragment key={i}>{section}</Fragment>)}
                <listTable.Editor lookups={lookups} />
                <Components.Toast />
              </main>
            )
          }))
        })
      )

    return {
      resource: {
        ...base,
        /** Error messages for database constraint violations, with the defaults for relations filled in. */
        messages,
        endpoints: { view, create, update, edit, remove, record },
        Page
      },
      section: (embed: AnyEmbed) => embedSections.get(embed.name)!,
      routes: (sectionOf: (embed: AnyEmbed) => (value: unknown) => Section<unknown>) =>
        HttpRouter.addAll([
          page,
          detail(sectionOf),
          view.route,
          create.route,
          update.route,
          edit.route,
          remove.route,
          record.route
        ]) as Layer.Layer<never>
    }
  }

  // --- the definition --------------------------------------------------------

  /**
   * This resource's table as a section of another resource's detail page, with
   * the `eq` filter `lock` fixed to that page's row id:
   *
   *   Teams.with({ sections: [Users.embed({ name: "members", title: "Members", lock: "teamId" })] })
   *
   * The client never sees or sends the locked filter (signals that try to set
   * it are rejected), creates get it from the server, and edits/deletes of rows
   * outside the lock answer "no longer exists". Its query is not synced to the
   * URL: the page's URL belongs to the page.
   */
  const embed = <const Lock extends EqKeys<Filters> & FK & keyof Row>(options: {
    /** Signal namespace, DOM id prefix and `?embed=` value. Must differ from every other table on the page. */
    readonly name: string
    readonly title: string
    readonly lock: Lock
  }): Embed<Name, NonNullable<Row[Lock]>> => ({ _tag: "Embed", target: name, ...options })

  /**
   * Relations (foreign key -> the resource it references) and detail-page
   * sections (embeds of other resources, or any `(row) => Effect<ReactNode>`).
   */
  const with_ = <
    const R extends Relations<M> = {},
    const S extends ReadonlyArray<SectionInput<Row, IdType>> = readonly []
  >(options: { readonly relations?: R; readonly sections?: S }) => {
    const relations = Object.entries(options.relations ?? {}).flatMap(([key, target]) =>
      target === undefined ? [] : [[key, (target as Target<never>).Lookup] as const]
    )
    const sections: ReadonlyArray<SectionInput<Row, IdType>> = options.sections ?? []
    const spec: Spec<
      Name,
      RelationNames<R> | EmbedTargets<S[number]>,
      RepoOf<Name> | Reactivity.Reactivity | RelationServices<R> | SectionRequires<S[number]>,
      ReturnType<typeof build>["resource"]
    > = {
      name,
      layer,
      embeds: sections.flatMap((s) => (typeof s === "function" ? [] : [s])),
      build: (embeds) => build(relations, sections, embeds)
    }
    return spec
  }

  const definition = { ...base, embed, with: with_ }
  return { ...definition, ...with_({}) }
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

type Needs<S> = S extends { readonly "~needs"?: infer N } ? Exclude<N, undefined> : never
type Requires<S> = S extends { readonly "~requires"?: infer R } ? Exclude<R, undefined> : never
type ResourceOf<S> = S extends { readonly build: (embeds: never) => Built<infer Res> } ? Res : never
/** A compile error naming the resources that relations or embeds need but the app lacks. */
type Complete<Specs extends ReadonlyArray<AnySpec>> = [Exclude<Needs<Specs[number]>, Specs[number]["name"]>] extends [never]
  ? unknown
  : { readonly "missing resources": Exclude<Needs<Specs[number]>, Specs[number]["name"]> }

/**
 * Assemble resources: each route registered once, embeds wired to the
 * resources they embed, and every `Repo` and `Lookup` in one layer. A relation
 * or embed naming a resource that isn't in the app is a type error.
 */
export const app = <const Specs extends readonly [AnySpec, ...Array<AnySpec>]>(...specs: Specs & Complete<Specs>) => {
  const names = specs.map((s) => s.name)
  const duplicate = names.find((n, i) => names.indexOf(n) !== i)
  if (duplicate !== undefined) throw new Error(`Resource.app: "${duplicate}" is given twice`)
  const embeds = specs.flatMap((s) => s.embeds)
  for (const e of embeds) {
    if (!names.includes(e.target)) throw new Error(`Resource.app: embed "${e.name}" needs resource "${e.target}"`)
    // Its signals and DOM ids would clash with a resource's dialog or table.
    if (names.includes(e.name)) throw new Error(`Resource.app: embed "${e.name}" has a resource's name`)
  }
  const built = new Map(specs.map((s) => [s.name, s.build(embeds.filter((e) => e.target === s.name))]))
  const sectionOf = (e: AnyEmbed) => built.get(e.target)!.section(e)
  const [first, ...rest] = [...built.values()].map((b) => b.routes(sectionOf))
  const [firstLayer, ...restLayers] = specs.map((s) => s.layer)
  type Names = Specs[number]["name"]
  return {
    /** Every resource's routes. */
    routes: Layer.mergeAll(first!, ...rest) as unknown as Layer.Layer<
      never,
      never,
      HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", Requires<Specs[number]>>
    >,
    /** Every resource's `Repo` and `Lookup`. */
    layer: Layer.mergeAll(firstLayer!, ...restLayers) as unknown as Layer.Layer<
      ServicesOf<Names>,
      never,
      SqlClient.SqlClient | Reactivity.Reactivity
    >,
    resources: Object.fromEntries([...built].map(([n, b]) => [n, b.resource])) as {
      readonly [S in Specs[number] as S["name"]]: ResourceOf<S>
    }
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", marginBottom: space["--dw-space-10"] },
  bar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space["--dw-space-4"],
    marginBottom: space["--dw-space-5"]
  },
  flush: { marginBottom: 0 },
  actions: { display: "flex", gap: space["--dw-space-2"] },
  h1: {
    fontSize: font["--dw-text-xl"],
    fontWeight: font["--dw-weight-semibold"],
    letterSpacing: "-0.02em",
    lineHeight: font["--dw-leading-tight"]
  },
  h2: {
    fontSize: font["--dw-text-lg"],
    fontWeight: font["--dw-weight-semibold"],
    letterSpacing: "-0.01em",
    lineHeight: font["--dw-leading-tight"]
  },
  loading: { padding: space["--dw-space-5"] },
  link: {
    color: color["--dw-accent-text"],
    textDecoration: { default: "none", ":hover": "underline" }
  },
  strong: { fontWeight: font["--dw-weight-medium"] },
  subtle: { color: color["--dw-text-subtle"] },
  crumbs: { marginBottom: space["--dw-space-4"] },
  crumb: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["--dw-space-1"],
    color: { default: color["--dw-text-muted"], ":hover": color["--dw-text"] },
    fontSize: font["--dw-text-sm"],
    fontWeight: font["--dw-weight-medium"],
    textDecoration: "none"
  },
  record: { display: "flex", flexDirection: "column", gap: space["--dw-space-5"], marginBottom: space["--dw-space-10"] },
  dl: { display: "flex", flexDirection: "column", gap: space["--dw-space-3"] },
  dlRow: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(120px, 1fr) 3fr", "@media (max-width: 640px)": "minmax(0, 1fr)" },
    gap: { default: space["--dw-space-3"], "@media (max-width: 640px)": "2px" },
    alignItems: "baseline"
  },
  dt: { color: color["--dw-text-muted"], fontSize: font["--dw-text-sm"] },
  dd: { minWidth: 0, overflowWrap: "anywhere" }
})
