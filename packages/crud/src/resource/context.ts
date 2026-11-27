/**
 * Everything a resource derives from its definition, in one value the other
 * modules share: `resolve` (from the config alone: schemas, ids, services) and
 * `wire` (once its relations are known: lookups and messages).
 *
 * Internal to the resource modules.
 */
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import type { Reactivity } from "effect/reactivity"
import type { SqlClient, SqlError } from "effect/sql"
import type { ReactNode } from "react"
import type * as Components from "../components.tsx"
import type * as Field from "../Field.ts"
import { toast } from "../Feedback.tsx"
import * as Form from "../Form.ts"
import * as Lookup from "../Lookup.ts"
import * as Policy from "../Policy.ts"
import * as Query from "../Query.ts"
import * as Repo from "../Repo.ts"
import type * as Scope from "../Scope.ts"
import type { Config, Fields, IdKey, Layout, LookupOf, LookupTag, Messages, ModelLike, RepoOf } from "./types.ts"

/** The most rows one bulk action takes (a page is at most the largest page size). */
export const MAX_SELECTION = 500

/** The search params that pick an embed's table (`?embed=members&scope=3`) or the detail page (`?from=detail`). */
export const EMBED = "embed"
export const SCOPE = "scope"
export const FROM = "from"

/** Signals under one namespace: `{ [ns]: schema }` read back as `schema`'s type. */
export const readSignals = <S extends Schema.Codec<any, any, never, never>>(ns: string, schema: S) =>
  Effect.map(Datastar.signals(Schema.Struct({ [ns]: schema })), (s) => (s as Readonly<Record<string, S["Type"]>>)[ns]!)

/** `variant.make(value)` for a model variant whose input TS can't relate to `value` generically. */
export const construct = <T>(variant: unknown, value: unknown): T => (variant as { make: (v: unknown) => T }).make(value)

/** The request's search params. */
export const searchParams = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => new URL(request.url, "http://localhost").searchParams
)

/** A resource's definition, resolved: what every part of it shares. */
export interface Ctx<Name extends string, M extends ModelLike, Id extends IdKey<M>, Sortable extends Fields<M>, FK extends string, T, L, A = never> {
  readonly name: Name
  readonly prefix: `/${Name}`
  readonly title: string
  readonly noun: string
  readonly model: M
  readonly idColumn: Id
  readonly display: string
  readonly layout: Layout<L>
  readonly authorize: Policy.Policy<A> | undefined
  readonly capabilities: Effect.Effect<Policy.Capabilities, never, A>
  readonly require: (action: Policy.CrudAction) => Effect.Effect<void, Policy.Forbidden, A>
  readonly columns: Readonly<Record<string, ((row: M["Type"], lookups: Components.Lookups) => ReactNode) | undefined>>
  readonly config: Pick<Config<Name, M, Id, Sortable, Record<string, Query.Operator>>, "messages" | "bulk">
  readonly query: Query.QueryDef<Sortable, FK>
  /** The tenant: its column and service (for `Context.pick`), and the scope `Repo` and `Lookup` read. */
  readonly tenant: { readonly column: string; readonly service: Context.Key<T, { readonly id: unknown }> } | undefined
  readonly scope: Scope.Scope<T> | undefined
  readonly reference: Scope.ReferenceTarget
  /** The form's fields (never the tenant column) and the table's columns (not hidden ones). */
  readonly formFields: ReadonlyArray<Field.FieldInfo>
  readonly tableFields: ReadonlyArray<Field.FieldInfo>
  /** The id in the path (`/users/:id`). */
  readonly readId: Effect.Effect<M["fields"][Id]["Type"], Schema.SchemaError, HttpRouter.RouteContext>
  /** Row ids as signals hold them (the id field's encoded form), for the bulk selection. */
  readonly IdsSchema: Schema.Codec<ReadonlyArray<M["fields"][Id]["Type"]>, ReadonlyArray<number>>
  readonly SelectionSchema: Schema.Codec<ReadonlyArray<M["fields"][Id]["Type"]>, ReadonlyArray<number>>
  readonly encodeId: (id: M["fields"][Id]["Type"]) => number
  readonly encodeIds: (ids: ReadonlyArray<M["fields"][Id]["Type"]>) => ReadonlyArray<number>
  readonly pageIds: (rows: ReadonlyArray<M["Type"]>) => ReadonlyArray<number>
  readonly get: (row: M["Type"], key: string) => unknown
  /** The row's display value. */
  readonly label: (row: M["Type"]) => string
  /** Link to a row's detail page. */
  readonly href: (id: M["fields"][Id]["Type"]) => string
  readonly Repo: Context.Service<RepoOf<Name>, Repo.Repo<M, Id, Sortable, FK, T>>
  readonly Lookup: Context.Service<LookupOf<Name>, Lookup.Lookup<T>>
  /** `Repo` (checking `references` against the tenant) and `Lookup`. */
  readonly layerWith: (
    references: ReadonlyArray<readonly [string, Scope.ReferenceTarget]>
  ) => Layer.Layer<RepoOf<Name> | LookupOf<Name>, never, SqlClient.SqlClient | Reactivity.Reactivity>
}

export const resolve = <
  Name extends string,
  M extends ModelLike,
  Id extends IdKey<M>,
  Sortable extends Fields<M>,
  Filters extends { readonly [K in Fields<M>]?: Query.Operator },
  TC extends Fields<M>,
  T,
  L,
  A = never
>(config: Config<Name, M, Id, Sortable, Filters & Record<string, Query.Operator>, TC, T, L, A>): Ctx<Name, M, Id, Sortable, Query.Keys<Filters>, T, L, A> => {
  const { name, model, idColumn } = config
  type IdType = M["fields"][Id]["Type"]
  type Row = M["Type"]

  const authorize = config.authorize
  const tenant = config.tenant
  const tenantColumn: string | undefined = tenant?.column
  const encodeTenant = tenant && Schema.encodeUnknownSync(model.fields[tenant.column] as Schema.Codec<unknown, string | number>)
  const scope: Scope.Scope<T> | undefined = tenant && encodeTenant && {
    column: tenant.column,
    value: Effect.map(Effect.service(tenant.service), (s) => ({ id: s.id, encoded: encodeTenant(s.id) })),
    isolateKeys: tenant.isolateKeys ?? true
  }

  const query = Query.make(model, config.query) as Query.QueryDef<Sortable, Query.Keys<Filters>>
  // The tenant column is never in a form, filter or column: the server owns it.
  const formFields = Form.fields(model.jsonCreate).filter((f) => f.key !== tenantColumn)
  const hidden: ReadonlyArray<string> = [...(config.hidden ?? [idColumn]), ...(tenantColumn ? [tenantColumn] : [])]
  const tableFields = Form.fields(model).filter((f) => !hidden.includes(f.key))

  // Ids are numbers in the path (TS can't see that through the generic model).
  const IdSchema = model.fields[idColumn] as unknown as Schema.Codec<IdType, number>
  const IdParams = Schema.Struct({ id: Schema.NumberFromString.pipe(Schema.decodeTo(IdSchema)) })
  const IdsSchema = Schema.Array(IdSchema)
  const encodeIds = Schema.encodeSync(IdsSchema)
  const get = (row: Row, key: string): unknown => (row as Record<string, unknown>)[key]
  const href = (id: IdType) => `/${name}/${encodeURIComponent(String(id))}`

  const RepoTag = Context.Service<RepoOf<Name>, Repo.Repo<M, Id, Sortable, Query.Keys<Filters>, T>>(`${name}/Repo`)
  const LookupTag = Context.Service<LookupOf<Name>, Lookup.Lookup<T>>(`${name}/Lookup`)

  return {
    name,
    prefix: `/${name}`,
    title: config.title,
    noun: config.noun,
    model,
    idColumn,
    display: config.display,
    layout: config.layout,
    authorize,
    capabilities: Policy.capabilities(authorize),
    require: (action) => Policy.require(authorize, action, `Not allowed to ${action} ${config.noun}s`),
    columns: (config.columns ?? {}) as Ctx<Name, M, Id, Sortable, Query.Keys<Filters>, T, L, A>["columns"],
    config,
    query,
    tenant: tenant as Ctx<Name, M, Id, Sortable, Query.Keys<Filters>, T, L, A>["tenant"],
    scope,
    reference: { table: name, idColumn, tenantColumn },
    formFields,
    tableFields,
    readId: Effect.map(HttpRouter.schemaPathParams(IdParams), (p) => p.id),
    IdsSchema,
    SelectionSchema: IdsSchema.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SELECTION)),
    encodeId: Schema.encodeSync(IdSchema),
    encodeIds,
    pageIds: (rows) => encodeIds(rows.map((row) => row[idColumn])),
    get,
    label: (row) => String(get(row, config.display)),
    href,
    Repo: RepoTag,
    Lookup: LookupTag,
    layerWith: (references) =>
      Layer.mergeAll(
        Layer.effect(RepoTag, Repo.make(model, { table: name, idColumn, query, scope, references })),
        Layer.effect(
          LookupTag,
          Lookup.make({
            table: name,
            value: idColumn,
            label: config.display,
            href,
            scope,
            // A color field (`Schemas.Color`) colors this resource's chips in other resources' tables.
            color: Form.fields(model).find((f) => f.widget === "color")?.key
          })
        )
      )
  }
}

/** A resolved definition with its relations attached (in `app`). */
export interface Wired<Name extends string, M extends ModelLike, Id extends IdKey<M>, Sortable extends Fields<M>, FK extends string, T, L, A = never>
  extends Ctx<Name, M, Id, Sortable, FK, T, L, A>
{
  /** Field -> the lookup of the resource it references (foreign keys and many-to-many fields). */
  readonly relations: ReadonlyArray<readonly [string, LookupTag]>
  readonly messages: Messages
  /** The relations' lookup services. */
  readonly relationServices: Effect.Effect<ReadonlyArray<readonly [string, Lookup.Lookup<T>]>, never, LookupOf<string>>
  /** The options of each relation. */
  readonly lookupsFor: (
    services: ReadonlyArray<readonly [string, Lookup.Lookup<T>]>
  ) => Effect.Effect<Components.Lookups, SqlError.SqlError, T>
  /** The configured field whose column name appears in a database error (else the first). */
  readonly pick: (
    messages: Partial<Record<string, string>> | undefined,
    e: SqlError.SqlError
  ) => readonly [string, string] | undefined
  /** The toast for a row that no longer exists. */
  readonly goneToast: () => Effect.Effect<Datastar.DatastarEvent>
}

export const wire = <Name extends string, M extends ModelLike, Id extends IdKey<M>, Sortable extends Fields<M>, FK extends string, T, L, A = never>(
  ctx: Ctx<Name, M, Id, Sortable, FK, T, L, A>,
  relations: ReadonlyArray<readonly [string, LookupTag]>
): Wired<Name, M, Id, Sortable, FK, T, L, A> => {
  const configured = ctx.config.messages
  const messages: Messages = {
    unique: configured?.unique ?? {},
    invalidReference: {
      ...Object.fromEntries(
        relations.map(([k]) => [k, `${ctx.formFields.find((f) => f.key === k)?.label ?? k} no longer exists`])
      ),
      ...configured?.invalidReference
    },
    deleteRestricted: configured?.deleteRestricted,
    bulkDeleteRestricted: configured?.bulkDeleteRestricted ?? ((n) => `${n} still referenced elsewhere`)
  }
  const dbText = (e: SqlError.SqlError) => `${e.reason.message ?? ""} ${String(e.reason.cause ?? "")}`
  return {
    ...ctx,
    relations,
    messages,
    // A relation's lookup needs its target's tenant service; that requirement is
    // tracked in the spec (`RelationTenants`), so here it is treated as this one's.
    relationServices: Effect.forEach(
      relations,
      ([key, tag]) => Effect.map(Effect.service(tag), (l) => [key, l as unknown as Lookup.Lookup<T>] as const)
    ),
    lookupsFor: (services) =>
      Effect.map(
        Effect.forEach(services, ([key, l]) => Effect.map(l.options, (o) => [key, o] as const)),
        (entries): Components.Lookups => Object.fromEntries(entries)
      ),
    pick: (configured, e) => {
      const entries = Object.entries(configured ?? {}).filter((x): x is [string, string] => x[1] !== undefined)
      const text = dbText(e)
      return entries.find(([k]) => text.includes(k)) ?? entries[0]
    },
    goneToast: () => Effect.succeed(toast(`That ${ctx.noun} no longer exists`, "error"))
  }
}
