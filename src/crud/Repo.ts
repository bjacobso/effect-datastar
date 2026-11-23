/**
 * CRUD repository = `SqlModel.makeRepository` (insert/update/findById/delete)
 * + derived paginated `list` + fine-grained live updates.
 *
 * Every mutation invalidates the row's reactivity key in record form
 * (`{ users: [42] }`, i.e. `users` and `users:42`) and says what happened: a
 * `Change` (insert, update with the columns that changed, or delete) is handed
 * to the table's live streams along with the invalidation.
 *
 * `live(q)` uses that to do as little as possible per change:
 *   - an update that touches none of the query's sort or active filter columns
 *     can't change which rows are on the page, their order, or the total. If
 *     the row is on the page, only that row is re-fetched; otherwise nothing is.
 *   - anything else (insert, delete, an update to a sorted or filtered column,
 *     a dependency changing, or a bare `Reactivity.invalidate(["users"])` that
 *     didn't come from this repo) re-runs the full page query.
 *
 * The `Change` travels as the invalidation's payload (`InvalidationPayload`),
 * JSON-encoded: `{ table: "users", change: { _tag: "Update", id: 42, columns:
 * ["name"] } }`. Streams decode the payload of whatever invalidation woke
 * them, so a change made by another server process (through
 * `DistributedReactivity`) is handled exactly like a local one. No payload, or
 * one that doesn't decode, means "unknown change": a full re-query.
 *
 * With a `scope` (a tenant, see `Scope.ts`), every read is filtered by the
 * current tenant, writes set it, rows of other tenants don't exist, references
 * must stay in the tenant, and the reactivity keys are per tenant
 * (`{ "users[orgId=1]": [42] }`, unless `isolateKeys` is off). Streams always
 * listen on the bare table key too, for invalidations from outside the repo.
 */
import { Cause, Data, Effect, Option, Queue, Schema, Stream } from "effect"
import type * as Arr from "effect/Array"
import { Reactivity } from "effect/reactivity"
import * as Payload from "../reactivity/Payload.ts"
import type { Model } from "effect/schema"
import { SqlClient, SqlModel } from "effect/sql"
import type { SqlError } from "effect/sql"
import type { ListQuery, QueryDef } from "./Query.ts"
import * as Scope from "./Scope.ts"

/** A reference column points at a row of another tenant (or at none at all). */
export class InvalidReference extends Data.TaggedError("InvalidReference")<{ readonly column: string }> {}

export interface Page<A> {
  readonly rows: ReadonlyArray<A>
  readonly total: number
  readonly page: number
  readonly pages: number
}

/** What a mutation did to one row. */
export type Change<Id> =
  | { readonly _tag: "Insert"; readonly id: Id }
  | { readonly _tag: "Update"; readonly id: Id; readonly columns: ReadonlyArray<string> }
  | { readonly _tag: "Delete"; readonly id: Id }

/** Why a live stream was woken up. */
export type Signal<Id> =
  /** A mutation made through this repo. */
  | { readonly _tag: "Change"; readonly change: Change<Id> }
  /** The table key was invalidated without a `Change` (outside this repo, or batched). */
  | { readonly _tag: "Table" }
  /** One of the stream's `dependsOn` keys was invalidated. */
  | { readonly _tag: "Dependency" }

/** What a live stream emits. */
export type LiveEvent<A> =
  /** The whole page, re-queried. `dependency` means a `dependsOn` key changed too. */
  | { readonly _tag: "Page"; readonly page: Page<A>; readonly reason: "initial" | "table" | "dependency" }
  /** Rows on the current page whose content changed; membership, order and total did not. */
  | { readonly _tag: "Rows"; readonly rows: Arr.NonEmptyReadonlyArray<A> }

export type Plan<Id> =
  | { readonly _tag: "Requery"; readonly reason: "table" | "dependency" }
  | { readonly _tag: "Rows"; readonly ids: Arr.NonEmptyReadonlyArray<Id> }
  | { readonly _tag: "Skip" }

/**
 * Decide how a live stream handles a batch of signals, given the ids on its
 * current page and the columns its query sorts or filters on.
 */
export const plan = <Id>(
  signals: ReadonlyArray<Signal<Id>>,
  visible: ReadonlySet<Id>,
  queryColumns: ReadonlySet<string>
): Plan<Id> => {
  if (signals.some((s) => s._tag === "Dependency")) return { _tag: "Requery", reason: "dependency" }
  const ids = new Set<Id>()
  for (const signal of signals) {
    if (signal._tag !== "Change") return { _tag: "Requery", reason: "table" }
    const change = signal.change
    if (change._tag !== "Update") return { _tag: "Requery", reason: "table" }
    if (change.columns.some((c) => queryColumns.has(c))) return { _tag: "Requery", reason: "table" }
    // Membership and order are unchanged, so a row that isn't visible stays invisible.
    if (change.columns.length > 0 && visible.has(change.id)) ids.add(change.id)
  }
  const [first, ...rest] = ids
  return first === undefined ? { _tag: "Skip" } : { _tag: "Rows", ids: [first, ...rest] }
}

/**
 * The repository a resource works with. `R` is what its scope needs (the
 * tenant service), `never` for an unscoped table.
 */
export interface Repo<S extends Model.Any, Id extends keyof S["fields"], Sortable extends string, FK extends string, R = never> {
  readonly findById: (
    id: S["fields"][Id]["Type"]
  ) => Effect.Effect<S["Type"], Cause.NoSuchElementError | Schema.SchemaError | SqlError.SqlError, R>
  readonly list: (q: ListQuery<Sortable, FK>) => Effect.Effect<Page<S["Type"]>, SqlError.SqlError | Schema.SchemaError, R>
  /**
   * The page for `q`, then an update per change: a re-queried page, or just the
   * rows whose content changed. Also re-queries when any `dependsOn` key (e.g.
   * a related table) is invalidated.
   */
  readonly live: (
    q: ListQuery<Sortable, FK>,
    options?: { readonly dependsOn?: ReadonlyArray<string> | undefined }
  ) => Stream.Stream<LiveEvent<S["Type"]>, SqlError.SqlError | Schema.SchemaError, R>
  /** Inserts; with a scope, the tenant column is set to the current tenant. */
  readonly insert: (
    value: S["insert"]["Type"]
  ) => Effect.Effect<S["Type"], Schema.SchemaError | SqlError.SqlError | InvalidReference, R>
  /** Updates; with a scope, a row of another tenant is a `NoSuchElementError`. */
  readonly update: (
    value: S["update"]["Type"]
  ) => Effect.Effect<S["Type"], Cause.NoSuchElementError | Schema.SchemaError | SqlError.SqlError | InvalidReference, R>
  readonly delete: (
    id: S["fields"][Id]["Type"]
  ) => Effect.Effect<void, Cause.NoSuchElementError | Schema.SchemaError | SqlError.SqlError, R>
  /** The reactivity key this table's changes are announced on, for the current scope. */
  readonly key: Effect.Effect<string, never, R>
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

export const make = <
  S extends Model.Any & Schema.Codec<any, any, never, never>,
  const Id extends (keyof S["Type"]) & (keyof S["update"]["Type"]) & (keyof S["fields"]) & string,
  Sortable extends string,
  FK extends string,
  R = never
>(
  model: S,
  options: {
    readonly table: string
    readonly idColumn: Id
    readonly query: QueryDef<Sortable, FK>
    /** Tenant scope (see `Scope.ts`). */
    readonly scope?: Scope.Scope<R> | undefined
    /** Columns that reference other tables; checked against the current tenant on writes. */
    readonly references?: ReadonlyArray<readonly [column: string, target: Scope.ReferenceTarget]> | undefined
  }
): Effect.Effect<Repo<S, Id, Sortable, FK, R>, never, SqlClient.SqlClient | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    type Row = S["Type"]
    type RowId = S["fields"][Id]["Type"]
    const sql = yield* SqlClient.SqlClient
    const reactivity = yield* Reactivity.Reactivity
    const base = yield* SqlModel.makeRepository(model, {
      tableName: options.table,
      spanPrefix: options.table,
      idColumn: options.idColumn
    })
    const decodeRows = Schema.decodeUnknownEffect(Schema.Array(model))
    const encodeRow = Schema.encodeUnknownEffect(model)
    const table = sql(options.table)
    const idOf = (row: Row): RowId => row[options.idColumn]
    const columns = Object.keys(model.fields)

    // --- scope ---------------------------------------------------------------

    const scope = options.scope
    /** The current tenant (`undefined` when unscoped). */
    type Current = Scope.Current | undefined
    const tenant: Effect.Effect<Current, never, R> = scope === undefined ? Effect.succeed(undefined) : scope.value
    const inScope = (v: Current) => (v === undefined || scope === undefined ? [] : [sql`${sql(scope.column)} = ${v.encoded}`])
    const keyFor = (v: Current) =>
      v === undefined || scope === undefined || !scope.isolateKeys ? options.table : Scope.key(options.table, scope.column, v.encoded)
    const encodeId = Schema.encodeUnknownEffect(model.fields[options.idColumn] as Schema.Codec<RowId, unknown>)
    const references = (options.references ?? []).flatMap(([column, target]) => {
      const tenantColumn = target.tenantColumn
      if (tenantColumn === undefined) return []
      const encode = Schema.encodeUnknownEffect(model.fields[column] as Schema.Codec<unknown, unknown>)
      return [{ column, target, tenantColumn, encode }]
    })
    /** Every non-null reference must point at a row of the current tenant (the foreign key alone can't tell). */
    const checkReferences = (value: unknown, v: Current) =>
      Effect.forEach(references, (ref) =>
        Effect.gen(function*() {
          const raw = (value as Readonly<Record<string, unknown>>)[ref.column]
          if (v === undefined || raw === null || raw === undefined) return
          const encoded = yield* ref.encode(raw)
          const found = yield* sql`SELECT 1 AS ok FROM ${sql(ref.target.table)}
            WHERE ${sql(ref.target.idColumn)} = ${encoded as string | number}
            AND ${sql(ref.tenantColumn)} = ${v.encoded} LIMIT 1`
          if (found.length === 0) return yield* Effect.fail(new InvalidReference({ column: ref.column }))
        }), { discard: true })
    /** `value` with the tenant column set to the current tenant. */
    const withTenant = <A,>(value: A, v: Current): A =>
      v === undefined || scope === undefined ? value : { ...value, [scope.column]: v.id }

    const listIn = (q: ListQuery<Sortable, FK>, v: Current): Effect.Effect<Page<Row>, SqlError.SqlError | Schema.SchemaError> =>
      Effect.gen(function*() {
        const where = options.query.where(sql, q, inScope(v))
        const [rows, counted] = yield* Effect.all([
          sql`SELECT * FROM ${table} ${where} ${options.query.orderBy(sql, q, options.idColumn)}
              LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
          sql<{ total: number }>`SELECT COUNT(*) AS total FROM ${table} ${where}`
        ], { concurrency: "unbounded" })
        const total = counted[0]?.total ?? 0
        return {
          rows: yield* decodeRows(rows),
          total,
          page: q.page,
          pages: Math.max(1, Math.ceil(total / q.pageSize))
        }
      }).pipe(Effect.withSpan(`${options.table}.list`))
    const list = (q: ListQuery<Sortable, FK>) => Effect.flatMap(tenant, (v) => listIn(q, v))

    const findByIds = (ids: ReadonlyArray<RowId>, v: Current) =>
      sql`SELECT * FROM ${table} WHERE ${sql.and([sql.in(options.idColumn, ids), ...inScope(v)])}`.pipe(
        Effect.flatMap(decodeRows),
        Effect.withSpan(`${options.table}.findByIds`)
      )

    /** `findById` within the tenant: another tenant's row is a `NoSuchElementError`. */
    const findIn = (
      id: RowId,
      v: Current
    ): Effect.Effect<Row, Cause.NoSuchElementError | SqlError.SqlError | Schema.SchemaError> =>
      v === undefined
        ? base.findById(id) as Effect.Effect<Row, Cause.NoSuchElementError | SqlError.SqlError | Schema.SchemaError>
        : Effect.gen(function*() {
          const encoded = yield* encodeId(id)
          const rows = yield* decodeRows(
            yield* sql`SELECT * FROM ${table} WHERE ${sql.and([sql`${sql(options.idColumn)} = ${encoded as string | number}`, ...inScope(v)])}`
          )
          const row = rows[0]
          return row === undefined ? yield* Effect.fail(new Cause.NoSuchElementError()) : row
        }).pipe(Effect.withSpan(`${options.table}.findById`))
    const findById = (id: RowId) => Effect.flatMap(tenant, (v) => findIn(id, v))

    // --- changes -------------------------------------------------------------
    // Reactivity handlers take no arguments, so the change rides along as the
    // invalidation's payload, which handlers read while they (synchronously)
    // run. A handler that runs without a decodable one was triggered by
    // someone else. The invalidation runs right away even inside
    // `Reactivity.withBatch`: a batched handler would run after the payload is
    // gone and only see a bare table signal.

    const payloads = Option.getOrElse(
      yield* Effect.serviceOption(Payload.InvalidationPayload),
      () => Payload.local(reactivity)
    )
    const IdJson = Schema.toCodecJson(model.fields[options.idColumn] as Schema.Codec<RowId, unknown>)
    const ChangeJson = Schema.Struct({
      table: Schema.Literal(options.table),
      change: Schema.Union([
        Schema.TaggedStruct("Insert", { id: IdJson }),
        Schema.TaggedStruct("Update", { id: IdJson, columns: Schema.Array(Schema.String) }),
        Schema.TaggedStruct("Delete", { id: IdJson })
      ])
    })
    const encodeChange = Schema.encodeSync(ChangeJson)
    const decodeChange = Schema.decodeUnknownOption(ChangeJson)

    const announce = (change: Change<RowId>, v: Current) =>
      Effect.sync(() => {
        const payload: Schema.Json = encodeChange({ table: options.table, change })
        payloads.invalidateUnsafe({ [keyFor(v)]: [change.id] }, payload)
      })

    /** Why this table's key was invalidated, from the current payload (local or remote). */
    const tableSignal = (): Signal<RowId> => {
      const payload = payloads.current()
      const decoded = payload === undefined ? Option.none() : decodeChange(payload)
      return Option.isSome(decoded) ? { _tag: "Change", change: decoded.value.change } : { _tag: "Table" }
    }

    /** Columns whose stored (encoded) value differs between two versions of a row (all, if unknown). */
    const changedColumns = (before: Row | undefined, after: Row) =>
      Effect.gen(function*() {
        if (before === undefined) return columns
        const [a, b] = yield* Effect.all([encodeRow(before), encodeRow(after)])
        const encodedBefore = a as Record<string, unknown>
        const encodedAfter = b as Record<string, unknown>
        return columns.filter((c) => !sameValue(encodedBefore[c], encodedAfter[c]))
      })

    const insert = (value: S["insert"]["Type"]) =>
      Effect.gen(function*() {
        const v = yield* tenant
        yield* checkReferences(value, v)
        const row: Row = yield* base.insert(withTenant(value, v))
        yield* announce({ _tag: "Insert", id: idOf(row) }, v)
        return row
      })

    /**
     * Open live streams on this table. Without any, there is nobody to diff
     * columns for, unless other processes may be listening.
     */
    let watchers = 0

    const update = (value: S["update"]["Type"]) =>
      Effect.gen(function*() {
        // The previous version tells which columns changed. It is read outside a
        // transaction: if another update slips in between, the two announced
        // changes still cover every column that changed (if a column differs
        // between its version and ours, it differs from the one we read in at
        // least one of them), and streams act on both.
        // With a scope the previous version is always read: it also proves the
        // row is in the tenant (the tenant column never changes: writes set it).
        const v = yield* tenant
        const id: RowId = value[options.idColumn]
        const before = v !== undefined
          ? yield* findIn(id, v)
          : watchers === 0 && !payloads.crossProcess
          ? undefined
          : yield* base.findById(id).pipe(Effect.catchTag("NoSuchElementError", () => Effect.succeed(undefined)))
        yield* checkReferences(value, v)
        const after = yield* base.update(withTenant(value, v))
        yield* announce({ _tag: "Update", id: idOf(after), columns: yield* changedColumns(before, after) }, v)
        return after
      })

    const remove = (id: RowId) =>
      Effect.gen(function*() {
        const v = yield* tenant
        if (v !== undefined) yield* findIn(id, v)
        yield* base.delete(id)
        yield* announce({ _tag: "Delete", id }, v)
      })

    // --- live ----------------------------------------------------------------

    const live = (q: ListQuery<Sortable, FK>, liveOptions?: { readonly dependsOn?: ReadonlyArray<string> | undefined }) =>
      Stream.unwrap(Effect.gen(function*() {
        const signals = yield* Queue.unbounded<Signal<RowId>>()
        yield* Effect.acquireRelease(Effect.sync(() => watchers++), () => Effect.sync(() => watchers--))
        const register = (keys: ReadonlyArray<string>, signal: () => Signal<RowId>) =>
          Effect.acquireRelease(
            Effect.sync(() => reactivity.registerUnsafe(keys, () => Queue.offerUnsafe(signals, signal()))),
            (cancel) => Effect.sync(cancel)
          )
        const v = yield* tenant
        // Registered before the first query, so no change can slip in between. The
        // bare table key also catches invalidations from outside the repo.
        const key = keyFor(v)
        yield* register(key === options.table ? [key] : [key, options.table], tableSignal)
        const dependsOn = liveOptions?.dependsOn ?? []
        if (dependsOn.length > 0) yield* register(dependsOn, () => ({ _tag: "Dependency" }))

        const queryColumns = new Set(options.query.columns(q))
        let current: Page<Row> | undefined

        const requery = (reason: "initial" | "table" | "dependency") =>
          Effect.map(listIn(q, v), (page): ReadonlyArray<LiveEvent<Row>> => {
            current = page
            return [{ _tag: "Page", page, reason }]
          })

        const handle = (batch: ReadonlyArray<Signal<RowId>>) =>
          Effect.gen(function*() {
            const visible = new Set((current?.rows ?? []).map(idOf))
            const next = plan(batch, visible, queryColumns)
            switch (next._tag) {
              case "Skip":
                return []
              case "Requery":
                return yield* requery(next.reason)
              case "Rows": {
                const fetched = yield* findByIds(next.ids, v)
                const [first, ...rest] = fetched
                // A row that vanished (deleted meanwhile): the page needs a full re-query.
                if (first === undefined || fetched.length !== next.ids.length) return yield* requery("table")
                const byId = new Map(fetched.map((row) => [idOf(row), row] as const))
                if (current) current = { ...current, rows: current.rows.map((row) => byId.get(idOf(row)) ?? row) }
                return [{ _tag: "Rows", rows: [first, ...rest] }] as ReadonlyArray<LiveEvent<Row>>
              }
            }
          })

        return Stream.fromEffect(requery("initial")).pipe(
          // Everything that arrived while the previous step ran is handled as one batch.
          Stream.concat(Stream.mapEffect(Stream.fromEffectRepeat(Queue.takeAll(signals)), handle)),
          Stream.flattenIterable
        )
      }))

    // The model is constrained to need no services, which TS cannot see through the generic.
    const repo = { findById, list, live, insert, update, delete: remove, key: Effect.map(tenant, keyFor) }
    return repo as unknown as Repo<S, Id, Sortable, FK, R>
  })
