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
 *   - an insert or update in a `dependsOn` table (a related team or tag: a
 *     rename, a new option) can't change this page's rows either: the stream
 *     hands back the page it has (`Related`) to re-render with fresh labels.
 *   - anything else (insert, delete, an update to a sorted or filtered column,
 *     a delete in a dependency, which may cascade, or a bare
 *     `Reactivity.invalidate(["users"])` that didn't come from a repo)
 *     re-runs the full page query.
 *
 * The `Change` travels as the invalidation's payload (`InvalidationPayload`),
 * JSON-encoded: `{ table: "users", change: { _tag: "Update", id: 42, columns:
 * ["name"] } }`. Streams decode the payload of whatever invalidation woke
 * them, so a change made by another server process (through
 * `DistributedReactivity`) is handled exactly like a local one. No payload, or
 * one that doesn't decode, means "unknown change": a full re-query.
 *
 * Bulk changes (`updateMany`, `deleteMany`) run in one transaction and, once it
 * has committed, invalidate once: every row's record key in one invalidation
 * (`{ users: [3, 7, 9] }`), with every row's `Change` in one payload
 * (`{ table, changes: [...] }`). Each stream is woken once and plans the whole
 * batch, so a bulk edit of columns a view doesn't sort or filter on is still one
 * re-fetch of the visible rows, and anything else one re-query. (This is why
 * bulk changes don't use `Reactivity.withBatch`: a batched handler runs after
 * the payload is gone; see "changes" below.)
 *
 * Many-to-many fields (`ManyToMany.Ids`) are read with each row and written in
 * the row's transaction; a change to one is reported as a change to that
 * column of the row, so it is a row patch like any other column. They can't be
 * set in bulk (`updateMany` leaves them out).
 *
 * With a `scope` (a tenant, see `Scope.ts`), every read is filtered by the
 * current tenant, writes set it, rows of other tenants don't exist, references
 * must stay in the tenant, and the reactivity keys are per tenant
 * (`{ "users[orgId=1]": [42] }`, unless `isolateKeys` is off). Streams always
 * listen on the bare table key too, for invalidations from outside the repo.
 * Bulk changes follow the same rules: they only see (and touch) the current
 * tenant's rows, other tenants' ids are `missing`, the tenant column can't be
 * set, references are checked, and the one invalidation is on the tenant's key
 * (`{ "users[orgId=1]": [3, 7, 9] }`). Many-to-many ids are references too:
 * every id must be a row of the current tenant, and the join rows carry the
 * tenant (`through.tenant`) so the database can check it as well.
 */
import { Cause, Data, Effect, Option, Queue, Schema, Stream } from "effect"
import type * as Arr from "effect/Array"
import { Reactivity } from "effect/reactivity"
import * as Payload from "../reactivity/Payload.ts"
import type { Model } from "effect/schema"
import { SqlClient, SqlModel } from "effect/sql"
import type { SqlError } from "effect/sql"
import * as Field from "./Field.ts"
import * as ManyToMany from "./ManyToMany.ts"
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

/** What a bulk mutation did, per requested id. */
export interface BulkResult<Id> {
  /** Updated or deleted. */
  readonly done: ReadonlyArray<Id>
  /** Not found, of another tenant, or excluded by `only`: the caller should treat them as gone. */
  readonly missing: ReadonlyArray<Id>
  /** Deletes the database rejected because other rows still reference them (foreign keys). */
  readonly restricted: ReadonlyArray<Id>
}

export interface BulkOptions<Row> {
  /** Rows to leave alone, as if they didn't exist (e.g. outside an embed's lock). Checked inside the transaction. */
  readonly only?: ((row: Row) => boolean) | undefined
}

/** Why a live stream was woken up. */
export type Signal<Id> =
  /** A mutation made through this repo. */
  | { readonly _tag: "Change"; readonly change: Change<Id> }
  /** The table key was invalidated without a `Change` (outside this repo, or batched). */
  | { readonly _tag: "Table" }
  /**
   * One of the stream's `dependsOn` keys was invalidated: by that table's repo
   * (`table` and `change`), or by someone else (neither).
   */
  | {
    readonly _tag: "Dependency"
    readonly table?: string | undefined
    readonly change?: Change<unknown> | undefined
  }

/** What a live stream emits. */
export type LiveEvent<A> =
  /** The whole page, re-queried. `dependency` means a `dependsOn` key changed too. */
  | { readonly _tag: "Page"; readonly page: Page<A>; readonly reason: "initial" | "table" | "dependency" }
  /** Rows on the current page whose content changed; membership, order and total did not. */
  | { readonly _tag: "Rows"; readonly rows: Arr.NonEmptyReadonlyArray<A> }
  /**
   * Rows of these `dependsOn` tables were inserted or updated, which can't change
   * this page's rows: the current page (with any of its own rows that changed
   * re-fetched), to re-render with the related tables' fresh labels.
   */
  | { readonly _tag: "Related"; readonly tables: Arr.NonEmptyReadonlyArray<string>; readonly page: Page<A> }

export type Plan<Id> =
  | { readonly _tag: "Requery"; readonly reason: "table" | "dependency" }
  | { readonly _tag: "Rows"; readonly ids: Arr.NonEmptyReadonlyArray<Id> }
  | { readonly _tag: "Related"; readonly tables: Arr.NonEmptyReadonlyArray<string>; readonly ids: ReadonlyArray<Id> }
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
  const related = new Set<string>()
  for (const signal of signals) {
    if (signal._tag !== "Dependency") continue
    // Unknown, or a delete (which may cascade to this table's rows).
    if (signal.table === undefined || signal.change === undefined || signal.change._tag === "Delete") {
      return { _tag: "Requery", reason: "dependency" }
    }
    related.add(signal.table)
  }
  const ids = new Set<Id>()
  for (const signal of signals) {
    if (signal._tag === "Dependency") continue
    if (signal._tag !== "Change") return { _tag: "Requery", reason: "table" }
    const change = signal.change
    if (change._tag !== "Update") return { _tag: "Requery", reason: "table" }
    if (change.columns.some((c) => queryColumns.has(c))) return { _tag: "Requery", reason: "table" }
    // Membership and order are unchanged, so a row that isn't visible stays invisible.
    if (change.columns.length > 0 && visible.has(change.id)) ids.add(change.id)
  }
  const [table, ...tables] = related
  if (table !== undefined) return { _tag: "Related", tables: [table, ...tables], ids: [...ids] }
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
   * a related table) is invalidated without a change it can tell is harmless.
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
  /**
   * Set the same values on many rows, in one transaction, with one invalidation
   * once it has committed. `patch` holds `update`-variant values for some fields.
   * With a scope, only the current tenant's rows are touched (others are
   * `missing`), the tenant column is never set, and references are checked
   * (`InvalidReference`), as in `update`.
   */
  readonly updateMany: (
    ids: ReadonlyArray<S["fields"][Id]["Type"]>,
    patch: Partial<S["update"]["Type"]>,
    options?: BulkOptions<S["Type"]>
  ) => Effect.Effect<BulkResult<S["fields"][Id]["Type"]>, Schema.SchemaError | SqlError.SqlError | InvalidReference, R>
  /**
   * Delete many rows in one transaction, with one invalidation once it has
   * committed. Each delete runs in a savepoint: one the database restricts (a
   * foreign key) is reported in `restricted` and the others still go through.
   * With a scope, other tenants' rows are `missing` and left alone.
   */
  readonly deleteMany: (
    ids: ReadonlyArray<S["fields"][Id]["Type"]>,
    options?: BulkOptions<S["Type"]>
  ) => Effect.Effect<BulkResult<S["fields"][Id]["Type"]>, Schema.SchemaError | SqlError.SqlError, R>
  /** The reactivity key this table's changes are announced on, for the current scope. */
  readonly key: Effect.Effect<string, never, R>
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
/** The same reference: equal values, or the same ids in any order (many-to-many). */
const sameReference = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b)
    ? sameValue(ManyToMany.canonical(a), ManyToMany.canonical(b))
    : sameValue(a, b)

/** Any repo's change payload (one change, or a bulk change's several), for the streams that depend on its table (the ids stay encoded). */
const AnyChange = Schema.Union([
  Schema.TaggedStruct("Insert", { id: Schema.Json }),
  Schema.TaggedStruct("Update", { id: Schema.Json, columns: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Delete", { id: Schema.Json })
])
const AnyChangeJson = Schema.Union([
  Schema.Struct({ table: Schema.String, change: AnyChange }),
  Schema.Struct({ table: Schema.String, changes: Schema.Array(AnyChange) })
])
const decodeAnyChange = Schema.decodeUnknownOption(AnyChangeJson)

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

    // --- many-to-many fields ---------------------------------------------------
    // Read with every row (a correlated subquery per field, in the same
    // statement), so rows always carry them.

    const links = Field.links(model.fields)
    const linkKeys = new Set(links.map((l) => l.key))
    const selectRows = links.length === 0
      ? sql`SELECT * FROM ${table}`
      : sql`SELECT ${table}.*, ${sql.csv(links.map((l) => ManyToMany.select(sql, l, options.table, options.idColumn)))} FROM ${table}`
    const decode = (rows: ReadonlyArray<object>) =>
      decodeRows(ManyToMany.parse(links, rows as ReadonlyArray<Record<string, unknown>>))

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
    /**
     * Every non-null reference must point at a row of the current tenant (the
     * foreign key alone can't tell). A many-to-many field's ids are references
     * too: all of them must be (one statement for the lot). `before` is the
     * row as read within the tenant: a reference it already has is left
     * unchecked (it was checked when written, and rows never change tenant).
     */
    const checkReferences = (value: unknown, v: Current, before?: Row) =>
      Effect.forEach(references, (ref) =>
        Effect.gen(function*() {
          const raw = (value as Readonly<Record<string, unknown>>)[ref.column]
          if (v === undefined || raw === null || raw === undefined) return
          if (before !== undefined && sameReference(raw, (before as Readonly<Record<string, unknown>>)[ref.column])) return
          const encoded = yield* ref.encode(raw)
          const wanted = [...new Set(Array.isArray(encoded) ? encoded : [encoded])] as Array<string | number>
          if (wanted.length === 0) return
          const found = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(ref.target.table)}
            WHERE ${sql.in(ref.target.idColumn, wanted)} AND ${sql(ref.tenantColumn)} = ${v.encoded}`
          if ((found[0]?.n ?? 0) !== wanted.length) return yield* Effect.fail(new InvalidReference({ column: ref.column }))
        }), { discard: true })
    /** `value` with the tenant column set to the current tenant. */
    const withTenant = <A,>(value: A, v: Current): A =>
      v === undefined || scope === undefined ? value : { ...value, [scope.column]: v.id }

    const listIn = (q: ListQuery<Sortable, FK>, v: Current): Effect.Effect<Page<Row>, SqlError.SqlError | Schema.SchemaError> =>
      Effect.gen(function*() {
        const where = options.query.where(sql, q, options.idColumn, inScope(v))
        const [rows, counted] = yield* Effect.all([
          sql`${selectRows} ${where} ${options.query.orderBy(sql, q, options.idColumn)}
              LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
          sql<{ total: number }>`SELECT COUNT(*) AS total FROM ${table} ${where}`
        ], { concurrency: "unbounded" })
        const total = counted[0]?.total ?? 0
        return {
          rows: yield* decode(rows),
          total,
          page: q.page,
          pages: Math.max(1, Math.ceil(total / q.pageSize))
        }
      }).pipe(Effect.withSpan(`${options.table}.list`))
    const list = (q: ListQuery<Sortable, FK>) => Effect.flatMap(tenant, (v) => listIn(q, v))

    const findByIds = (ids: ReadonlyArray<RowId>, v: Current) =>
      sql`${selectRows} WHERE ${sql.and([sql.in(options.idColumn, ids), ...inScope(v)])}`.pipe(
        Effect.flatMap(decode),
        Effect.withSpan(`${options.table}.findByIds`)
      )

    /** `findById` within the tenant: another tenant's row is a `NoSuchElementError`. */
    const findIn = (
      id: RowId,
      v: Current
    ): Effect.Effect<Row, Cause.NoSuchElementError | SqlError.SqlError | Schema.SchemaError> =>
      v === undefined && links.length === 0
        // The model needs no services (see `make`'s constraint), which TS can't see through the generic.
        ? base.findById(id) as Effect.Effect<Row, Cause.NoSuchElementError | SqlError.SqlError | Schema.SchemaError>
        : Effect.gen(function*() {
          const encoded = yield* encodeId(id)
          const rows = yield* decode(
            yield* sql`${selectRows} WHERE ${sql.and([sql`${sql(options.idColumn)} = ${encoded as string | number}`, ...inScope(v)])}`
          )
          const row = rows[0]
          return row === undefined ? yield* Effect.fail(new Cause.NoSuchElementError()) : row
        }).pipe(Effect.withSpan(`${options.table}.findById`))
    const findById = (id: RowId) => Effect.flatMap(tenant, (v) => findIn(id, v))

    /**
     * Insert or update a row with many-to-many fields: the row, then its join
     * rows (callers run it in a transaction). Both are written from the
     * variant's encoded value, with the link fields split off. `before` is the
     * row's current version when the caller read it in the same transaction:
     * its ids are what the join table holds, so they needn't be read again.
     * With a scope, the update is bounded by the tenant, and join rows get the
     * tenant in `through.tenant` (for the database's composite foreign keys).
     */
    const encodeInsert = Schema.encodeUnknownEffect(model.insert as Schema.Codec<unknown, unknown>)
    const encodeUpdate = Schema.encodeUnknownEffect(model.update as Schema.Codec<unknown, unknown>)
    const split = (encoded: unknown) => {
      const row: Record<string, unknown> = { ...(encoded as Record<string, unknown>) }
      const linked = links.map((l) => {
        const ids = (row[l.key] ?? []) as ReadonlyArray<unknown>
        delete row[l.key]
        return [l, ids] as const
      })
      return { row, linked }
    }
    const joinExtra = (link: ManyToMany.Link, v: Current): Readonly<Record<string, unknown>> =>
      v === undefined || link.through.tenant === undefined ? {} : { [link.through.tenant]: v.encoded }
    const writeLinked = (
      encoded: unknown,
      mode: { readonly fresh: true } | { readonly fresh: false; readonly before: Row | undefined },
      v: Current
    ) =>
      Effect.gen(function*() {
        const { row, linked } = split(encoded)
        const id = row[options.idColumn]
        const written = mode.fresh
          ? yield* sql`INSERT INTO ${table} ${sql.insert(row as Record<string, never>).returning("*")}`
          : yield* sql`UPDATE ${table} SET ${sql.update(row as Record<string, never>, [options.idColumn])}
                        WHERE ${sql.and([sql`${sql(options.idColumn)} = ${id as never}`, ...inScope(v)])} RETURNING *`
        const saved = written[0] as Record<string, unknown> | undefined
        // As `makeRepository`: the row was there a moment ago (callers check first).
        if (saved === undefined) return yield* Effect.die(new Cause.NoSuchElementError(`${options.table}: no row ${String(id)}`))
        const previous = mode.fresh || mode.before === undefined
          ? undefined
          : (yield* encodeRow(mode.before)) as Record<string, ReadonlyArray<unknown>>
        for (const [link, ids] of linked) {
          yield* ManyToMany.write(sql, link, saved[options.idColumn], ids, mode.fresh ? [] : previous?.[link.key], joinExtra(link, v))
          saved[link.key] = JSON.stringify(ManyToMany.canonical(ids))
        }
        const [decoded] = yield* decode([saved])
        return decoded as Row
      })

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
    const ChangeSchema = Schema.Union([
      Schema.TaggedStruct("Insert", { id: IdJson }),
      Schema.TaggedStruct("Update", { id: IdJson, columns: Schema.Array(Schema.String) }),
      Schema.TaggedStruct("Delete", { id: IdJson })
    ])
    // One change (single-row mutations, and what older senders send), or several (bulk).
    // The payload names the table, not the tenant: it only ever travels with an
    // invalidation of the tenant's own key, so only that tenant's streams read it.
    const ChangeJson = Schema.Union([
      Schema.Struct({ table: Schema.Literal(options.table), change: ChangeSchema }),
      Schema.Struct({ table: Schema.Literal(options.table), changes: Schema.Array(ChangeSchema) })
    ])
    const encodeChange = Schema.encodeSync(ChangeJson)
    const decodeChange = Schema.decodeUnknownOption(ChangeJson)

    const announce = (change: Change<RowId>, v: Current) =>
      Effect.sync(() => {
        const payload: Schema.Json = encodeChange({ table: options.table, change })
        payloads.invalidateUnsafe({ [keyFor(v)]: [change.id] }, payload)
      })

    /** One invalidation, on the tenant's key, for many changed rows (nothing if there are none). */
    const announceAll = (changes: ReadonlyArray<Change<RowId>>, v: Current) =>
      Effect.sync(() => {
        if (changes.length === 0) return
        const payload: Schema.Json = encodeChange({ table: options.table, changes })
        payloads.invalidateUnsafe({ [keyFor(v)]: changes.map((c) => c.id) }, payload)
      })

    /** Why this table's key was invalidated, from the current payload (local or remote). */
    const tableSignals = (): ReadonlyArray<Signal<RowId>> => {
      const payload = payloads.current()
      const decoded = payload === undefined ? Option.none() : decodeChange(payload)
      if (Option.isNone(decoded)) return [{ _tag: "Table" }]
      const value = decoded.value
      return "change" in value
        ? [{ _tag: "Change", change: value.change }]
        : value.changes.map((change): Signal<RowId> => ({ _tag: "Change", change }))
    }

    /** Why a `dependsOn` key was invalidated: another repo's change(s), if the payload says. */
    const dependencySignals = (): ReadonlyArray<Signal<RowId>> => {
      const payload = payloads.current()
      const decoded = payload === undefined ? Option.none() : decodeAnyChange(payload)
      if (Option.isNone(decoded)) return [{ _tag: "Dependency" }]
      const value = decoded.value
      const changes = "change" in value ? [value.change] : value.changes
      return changes.map((change): Signal<RowId> => ({ _tag: "Dependency", table: value.table, change }))
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
        const scoped = withTenant(value, v)
        const row: Row = links.length === 0
          ? yield* base.insert(scoped)
          : yield* Effect.flatMap(encodeInsert(scoped), (encoded) => {
            const write = writeLinked(encoded, { fresh: true }, v)
            // A new row without join rows is one statement: no transaction needed.
            return split(encoded).linked.every(([, ids]) => ids.length === 0) ? write : sql.withTransaction(write)
          })
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
        // With many-to-many fields, the row and its join rows are written in one
        // transaction, and the previous version is read inside it (its ids tell
        // which join rows to change).
        const v = yield* tenant
        const id: RowId = value[options.idColumn]
        const readBefore: Effect.Effect<Row | undefined, Cause.NoSuchElementError | SqlError.SqlError | Schema.SchemaError> =
          v !== undefined
            ? findIn(id, v)
            : watchers === 0 && !payloads.crossProcess
            ? Effect.succeed(undefined)
            : findIn(id, v).pipe(Effect.catchTag("NoSuchElementError", () => Effect.succeed(undefined)))
        const scoped = withTenant(value, v)
        const [before, after] = links.length === 0
          ? yield* Effect.gen(function*() {
            const before = yield* readBefore
            yield* checkReferences(value, v, before)
            return [before, yield* base.update(scoped)] as const
          })
          : yield* sql.withTransaction(Effect.gen(function*() {
            const encoded = yield* encodeUpdate(scoped)
            const before = yield* readBefore
            yield* checkReferences(value, v, before)
            return [before, yield* writeLinked(encoded, { fresh: false, before }, v)] as const
          }))
        yield* announce({ _tag: "Update", id: idOf(after), columns: yield* changedColumns(before, after) }, v)
        return after
      })

    const remove = (id: RowId) =>
      Effect.gen(function*() {
        const v = yield* tenant
        if (v !== undefined) yield* findIn(id, v)
        // Join rows go with the row (`ON DELETE CASCADE`).
        yield* base.delete(id)
        yield* announce({ _tag: "Delete", id }, v)
      })

    // --- bulk ------------------------------------------------------------------
    // Same rules as the single-row writes: the rows are read within the tenant
    // (another tenant's id is `missing`, like a `NoSuchElementError`), the
    // statements are bounded by the tenant too, references are checked with
    // `checkReferences`, and the invalidation is on the tenant's key.

    const updateFields = (model.update as unknown as { readonly fields: Schema.Struct.Fields }).fields

    /** The requested rows that exist in the tenant and pass `only`, read inside the transaction. */
    const findForBulk = (ids: ReadonlyArray<RowId>, v: Current, bulk?: BulkOptions<Row>) =>
      Effect.map(ids.length === 0 ? Effect.succeed([]) : findByIds(ids, v), (rows) => {
        const found = rows.filter((row) => bulk?.only === undefined || bulk.only(row))
        const ok = new Set(found.map(idOf))
        return { found, missing: ids.filter((id) => !ok.has(id)) }
      })

    const unique = (ids: ReadonlyArray<RowId>) => [...new Set(ids)]

    const updateMany = (ids: ReadonlyArray<RowId>, patch: Partial<S["update"]["Type"]>, bulk?: BulkOptions<Row>) =>
      Effect.gen(function*() {
        const v = yield* tenant
        // Never the id, and never the tenant column: the server owns it, and a row never changes tenant.
        // Nor many-to-many fields: they live in join tables, which bulk updates don't write.
        const keys = Object.keys(patch).filter((k) =>
          k !== options.idColumn && k !== scope?.column && !linkKeys.has(k) && k in updateFields
        )
        const values: Record<string, unknown> = Object.fromEntries(
          keys.map((k) => [k, (patch as Record<string, unknown>)[k]])
        )
        const encoded = (yield* Schema.encodeUnknownEffect(
          Schema.Struct(Object.fromEntries(keys.map((k) => [k, updateFields[k]!])))
        )(values)) as Record<string, unknown>
        const { changes, result } = yield* sql.withTransaction(Effect.gen(function*() {
          const { found, missing } = yield* findForBulk(unique(ids), v, bulk)
          const done = found.map(idOf)
          if (done.length > 0 && keys.length > 0) {
            // Like `update`: references must point into the tenant (checked once: every row gets the same values).
            yield* checkReferences(values, v)
            yield* sql`UPDATE ${table} SET ${sql.update(encoded)}
              WHERE ${sql.and([sql.in(options.idColumn, done), ...inScope(v)])}`
          }
          const changes = yield* Effect.forEach(found, (row) =>
            Effect.map(encodeRow(row), (before): Change<RowId> => ({
              _tag: "Update",
              id: idOf(row),
              columns: keys.filter((k) => !sameValue((before as Record<string, unknown>)[k], encoded[k]))
            })))
          const result: BulkResult<RowId> = { done, missing, restricted: [] }
          return { changes, result }
        }))
        // Committed: one invalidation for all of them (a row whose values didn't change goes
        // along with no columns, which streams skip).
        yield* announceAll(changes, v)
        return result
      }).pipe(Effect.withSpan(`${options.table}.updateMany`))

    const deleteMany = (ids: ReadonlyArray<RowId>, bulk?: BulkOptions<Row>) =>
      Effect.gen(function*() {
        const v = yield* tenant
        const result = yield* sql.withTransaction(Effect.gen(function*() {
          const { found, missing } = yield* findForBulk(unique(ids), v, bulk)
          const done: Array<RowId> = []
          const restricted: Array<RowId> = []
          // Each row's join rows go with it (`ON DELETE CASCADE`).
          for (const row of found) {
            const id = idOf(row)
            const encodedId = (yield* encodeId(id)) as string | number
            // A savepoint each: a restricted delete rolls back alone.
            const outcome = yield* sql.withTransaction(
              sql`DELETE FROM ${table} WHERE ${sql.and([sql`${sql(options.idColumn)} = ${encodedId}`, ...inScope(v)])}`
            ).pipe(
              Effect.as("done" as const),
              Effect.catchTag("SqlError", (e) =>
                e.reason._tag === "ConstraintError" ? Effect.succeed("restricted" as const) : Effect.fail(e))
            )
            ;(outcome === "done" ? done : restricted).push(id)
          }
          const result: BulkResult<RowId> = { done, missing, restricted }
          return result
        }))
        yield* announceAll(result.done.map((id): Change<RowId> => ({ _tag: "Delete", id })), v)
        return result
      }).pipe(Effect.withSpan(`${options.table}.deleteMany`))

    // --- live ----------------------------------------------------------------

    const live = (q: ListQuery<Sortable, FK>, liveOptions?: { readonly dependsOn?: ReadonlyArray<string> | undefined }) =>
      Stream.unwrap(Effect.gen(function*() {
        const signals = yield* Queue.unbounded<Signal<RowId>>()
        yield* Effect.acquireRelease(Effect.sync(() => watchers++), () => Effect.sync(() => watchers--))
        const register = (keys: ReadonlyArray<string>, signal: () => ReadonlyArray<Signal<RowId>>) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              reactivity.registerUnsafe(keys, () => {
                for (const s of signal()) Queue.offerUnsafe(signals, s)
              })
            ),
            (cancel) => Effect.sync(cancel)
          )
        const v = yield* tenant
        // Registered before the first query, so no change can slip in between. The
        // bare table key also catches invalidations from outside the repo.
        const key = keyFor(v)
        yield* register(key === options.table ? [key] : [key, options.table], tableSignals)
        const dependsOn = liveOptions?.dependsOn ?? []
        if (dependsOn.length > 0) yield* register(dependsOn, dependencySignals)

        const queryColumns = new Set(options.query.columns(q))
        let current: Page<Row> | undefined

        const requery = (reason: "initial" | "table" | "dependency") =>
          Effect.map(listIn(q, v), (page): ReadonlyArray<LiveEvent<Row>> => {
            current = page
            return [{ _tag: "Page", page, reason }]
          })

        /** Re-fetches rows of the current page; `undefined` if one vanished (deleted meanwhile). */
        const refetch = (ids: ReadonlyArray<RowId>) =>
          Effect.map(findByIds(ids, v), (fetched) => {
            if (fetched.length !== ids.length) return undefined
            const byId = new Map(fetched.map((row) => [idOf(row), row] as const))
            if (current) current = { ...current, rows: current.rows.map((row) => byId.get(idOf(row)) ?? row) }
            return fetched
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
                const fetched = yield* refetch(next.ids)
                const [first, ...rest] = fetched ?? []
                if (first === undefined) return yield* requery("table")
                return [{ _tag: "Rows", rows: [first, ...rest] }] as ReadonlyArray<LiveEvent<Row>>
              }
              case "Related": {
                if (next.ids.length > 0 && (yield* refetch(next.ids)) === undefined) return yield* requery("table")
                if (current === undefined) return yield* requery("dependency")
                return [{ _tag: "Related", tables: next.tables, page: current }] as ReadonlyArray<LiveEvent<Row>>
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
    const repo = {
      findById,
      list,
      live,
      insert,
      update,
      delete: remove,
      updateMany,
      deleteMany,
      key: Effect.map(tenant, keyFor)
    }
    return repo as unknown as Repo<S, Id, Sortable, FK, R>
  })
