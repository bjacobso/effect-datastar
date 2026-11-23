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
 * Bulk changes (`updateMany`, `deleteMany`) run in one transaction and, once it
 * has committed, invalidate once: every row's record key in one invalidation
 * (`{ users: [3, 7, 9] }`), with every row's `Change` in one payload
 * (`{ table, changes: [...] }`). Each stream is woken once and plans the whole
 * batch, so a bulk edit of columns a view doesn't sort or filter on is still one
 * re-fetch of the visible rows, and anything else one re-query. (This is why
 * bulk changes don't use `Reactivity.withBatch`: a batched handler runs after
 * the payload is gone; see "changes" below.)
 */
import { type Cause, Effect, Option, Queue, Schema, Stream } from "effect"
import type * as Arr from "effect/Array"
import { Reactivity } from "effect/reactivity"
import * as Payload from "../reactivity/Payload.ts"
import type { Model } from "effect/schema"
import { SqlClient, SqlModel } from "effect/sql"
import type { SqlError } from "effect/sql"
import type { ListQuery, QueryDef } from "./Query.ts"

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
  /** Not found, or excluded by `only`: the caller should treat them as gone. */
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

/** The repository a resource works with. */
export interface Repo<S extends Model.Any, Id extends keyof S["fields"], Sortable extends string, FK extends string> {
  readonly findById: (
    id: S["fields"][Id]["Type"]
  ) => Effect.Effect<S["Type"], Cause.NoSuchElementError | Schema.SchemaError | SqlError.SqlError>
  readonly list: (q: ListQuery<Sortable, FK>) => Effect.Effect<Page<S["Type"]>, SqlError.SqlError | Schema.SchemaError>
  /**
   * The page for `q`, then an update per change: a re-queried page, or just the
   * rows whose content changed. Also re-queries when any `dependsOn` key (e.g.
   * a related table) is invalidated.
   */
  readonly live: (
    q: ListQuery<Sortable, FK>,
    options?: { readonly dependsOn?: ReadonlyArray<string> | undefined }
  ) => Stream.Stream<LiveEvent<S["Type"]>, SqlError.SqlError | Schema.SchemaError>
  readonly insert: (value: S["insert"]["Type"]) => Effect.Effect<S["Type"], Schema.SchemaError | SqlError.SqlError>
  readonly update: (value: S["update"]["Type"]) => Effect.Effect<S["Type"], Schema.SchemaError | SqlError.SqlError>
  readonly delete: (id: S["fields"][Id]["Type"]) => Effect.Effect<void, Schema.SchemaError | SqlError.SqlError>
  /**
   * Set the same values on many rows, in one transaction, with one invalidation
   * once it has committed. `patch` holds `update`-variant values for some fields.
   */
  readonly updateMany: (
    ids: ReadonlyArray<S["fields"][Id]["Type"]>,
    patch: Partial<S["update"]["Type"]>,
    options?: BulkOptions<S["Type"]>
  ) => Effect.Effect<BulkResult<S["fields"][Id]["Type"]>, Schema.SchemaError | SqlError.SqlError>
  /**
   * Delete many rows in one transaction, with one invalidation once it has
   * committed. Each delete runs in a savepoint: one the database restricts (a
   * foreign key) is reported in `restricted` and the others still go through.
   */
  readonly deleteMany: (
    ids: ReadonlyArray<S["fields"][Id]["Type"]>,
    options?: BulkOptions<S["Type"]>
  ) => Effect.Effect<BulkResult<S["fields"][Id]["Type"]>, Schema.SchemaError | SqlError.SqlError>
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

export const make = <
  S extends Model.Any & Schema.Codec<any, any, never, never>,
  const Id extends (keyof S["Type"]) & (keyof S["update"]["Type"]) & (keyof S["fields"]) & string,
  Sortable extends string,
  FK extends string
>(
  model: S,
  options: { readonly table: string; readonly idColumn: Id; readonly query: QueryDef<Sortable, FK> }
): Effect.Effect<Repo<S, Id, Sortable, FK>, never, SqlClient.SqlClient | Reactivity.Reactivity> =>
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

    const list = (q: ListQuery<Sortable, FK>): Effect.Effect<Page<Row>, SqlError.SqlError | Schema.SchemaError> =>
      Effect.gen(function*() {
        const where = options.query.where(sql, q)
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

    const findByIds = (ids: ReadonlyArray<RowId>) =>
      sql`SELECT * FROM ${table} WHERE ${sql.in(options.idColumn, ids)}`.pipe(
        Effect.flatMap(decodeRows),
        Effect.withSpan(`${options.table}.findByIds`)
      )

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
    const ChangeJson = Schema.Union([
      Schema.Struct({ table: Schema.Literal(options.table), change: ChangeSchema }),
      Schema.Struct({ table: Schema.Literal(options.table), changes: Schema.Array(ChangeSchema) })
    ])
    const encodeChange = Schema.encodeSync(ChangeJson)
    const decodeChange = Schema.decodeUnknownOption(ChangeJson)

    const announce = (change: Change<RowId>) =>
      Effect.sync(() => {
        const payload: Schema.Json = encodeChange({ table: options.table, change })
        payloads.invalidateUnsafe({ [options.table]: [change.id] }, payload)
      })

    /** One invalidation for many changed rows (nothing if there are none). */
    const announceAll = (changes: ReadonlyArray<Change<RowId>>) =>
      Effect.sync(() => {
        if (changes.length === 0) return
        const payload: Schema.Json = encodeChange({ table: options.table, changes })
        payloads.invalidateUnsafe({ [options.table]: changes.map((c) => c.id) }, payload)
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
      Effect.tap(base.insert(value), (row: Row) => announce({ _tag: "Insert", id: idOf(row) }))

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
        const id: RowId = value[options.idColumn]
        const before = watchers === 0 && !payloads.crossProcess
          ? undefined
          : yield* base.findById(id).pipe(Effect.catchTag("NoSuchElementError", () => Effect.succeed(undefined)))
        const after = yield* base.update(value)
        yield* announce({ _tag: "Update", id: idOf(after), columns: yield* changedColumns(before, after) })
        return after
      })

    const remove = (id: RowId) => Effect.tap(base.delete(id), () => announce({ _tag: "Delete", id }))

    // --- bulk ------------------------------------------------------------------

    const updateFields = (model.update as unknown as { readonly fields: Schema.Struct.Fields }).fields

    /** The requested rows that exist and pass `only`, read inside the transaction. */
    const inScope = (ids: ReadonlyArray<RowId>, bulk?: BulkOptions<Row>) =>
      Effect.map(ids.length === 0 ? Effect.succeed([]) : findByIds(ids), (rows) => {
        const found = rows.filter((row) => bulk?.only === undefined || bulk.only(row))
        const ok = new Set(found.map(idOf))
        return { found, missing: ids.filter((id) => !ok.has(id)) }
      })

    const unique = (ids: ReadonlyArray<RowId>) => [...new Set(ids)]

    const updateMany = (ids: ReadonlyArray<RowId>, patch: Partial<S["update"]["Type"]>, bulk?: BulkOptions<Row>) =>
      Effect.gen(function*() {
        const keys = Object.keys(patch).filter((k) => k !== options.idColumn && k in updateFields)
        const encoded = (yield* Schema.encodeUnknownEffect(
          Schema.Struct(Object.fromEntries(keys.map((k) => [k, updateFields[k]!])))
        )(patch)) as Record<string, unknown>
        const { changes, result } = yield* sql.withTransaction(Effect.gen(function*() {
          const { found, missing } = yield* inScope(unique(ids), bulk)
          const done = found.map(idOf)
          if (done.length > 0 && keys.length > 0) {
            yield* sql`UPDATE ${table} SET ${sql.update(encoded)} WHERE ${sql.in(options.idColumn, done)}`
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
        yield* announceAll(changes)
        return result
      }).pipe(Effect.withSpan(`${options.table}.updateMany`))

    const deleteMany = (ids: ReadonlyArray<RowId>, bulk?: BulkOptions<Row>) =>
      Effect.gen(function*() {
        const result = yield* sql.withTransaction(Effect.gen(function*() {
          const { found, missing } = yield* inScope(unique(ids), bulk)
          const done: Array<RowId> = []
          const restricted: Array<RowId> = []
          for (const row of found) {
            const id = idOf(row)
            // A savepoint each: a restricted delete rolls back alone.
            const outcome = yield* sql.withTransaction(base.delete(id)).pipe(
              Effect.as("done" as const),
              Effect.catchTag("SqlError", (e) =>
                e.reason._tag === "ConstraintError" ? Effect.succeed("restricted" as const) : Effect.fail(e))
            )
            ;(outcome === "done" ? done : restricted).push(id)
          }
          const result: BulkResult<RowId> = { done, missing, restricted }
          return result
        }))
        yield* announceAll(result.done.map((id): Change<RowId> => ({ _tag: "Delete", id })))
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
        // Registered before the first query, so no change can slip in between.
        yield* register([options.table], tableSignals)
        const dependsOn = liveOptions?.dependsOn ?? []
        if (dependsOn.length > 0) yield* register(dependsOn, () => [{ _tag: "Dependency" }])

        const queryColumns = new Set(options.query.columns(q))
        let current: Page<Row> | undefined

        const requery = (reason: "initial" | "table" | "dependency") =>
          Effect.map(list(q), (page): ReadonlyArray<LiveEvent<Row>> => {
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
                const fetched = yield* findByIds(next.ids)
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
    const repo = { findById: base.findById, list, live, insert, update, delete: remove, updateMany, deleteMany }
    return repo as unknown as Repo<S, Id, Sortable, FK>
  })
