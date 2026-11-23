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
 * Many-to-many fields (`ManyToMany.Ids`) are read with each row and written in
 * the row's transaction; a change to one is reported as a change to that
 * column of the row, so it is a row patch like any other column.
 */
import { Cause, Effect, Option, Queue, Schema, Stream } from "effect"
import type * as Arr from "effect/Array"
import { Reactivity } from "effect/reactivity"
import * as Payload from "../reactivity/Payload.ts"
import type { Model } from "effect/schema"
import { SqlClient, SqlModel } from "effect/sql"
import type { SqlError } from "effect/sql"
import * as Field from "./Field.ts"
import * as ManyToMany from "./ManyToMany.ts"
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

/** The repository a resource works with. */
export interface Repo<S extends Model.Any, Id extends keyof S["fields"], Sortable extends string, FK extends string> {
  readonly findById: (
    id: S["fields"][Id]["Type"]
  ) => Effect.Effect<S["Type"], Cause.NoSuchElementError | Schema.SchemaError | SqlError.SqlError>
  readonly list: (q: ListQuery<Sortable, FK>) => Effect.Effect<Page<S["Type"]>, SqlError.SqlError | Schema.SchemaError>
  /**
   * The page for `q`, then an update per change: a re-queried page, or just the
   * rows whose content changed. Also re-queries when any `dependsOn` key (e.g.
   * a related table) is invalidated without a change it can tell is harmless.
   */
  readonly live: (
    q: ListQuery<Sortable, FK>,
    options?: { readonly dependsOn?: ReadonlyArray<string> | undefined }
  ) => Stream.Stream<LiveEvent<S["Type"]>, SqlError.SqlError | Schema.SchemaError>
  readonly insert: (value: S["insert"]["Type"]) => Effect.Effect<S["Type"], Schema.SchemaError | SqlError.SqlError>
  readonly update: (value: S["update"]["Type"]) => Effect.Effect<S["Type"], Schema.SchemaError | SqlError.SqlError>
  readonly delete: (id: S["fields"][Id]["Type"]) => Effect.Effect<void, Schema.SchemaError | SqlError.SqlError>
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** Any repo's change payload, for the streams that depend on its table (the ids stay encoded). */
const AnyChangeJson = Schema.Struct({
  table: Schema.String,
  change: Schema.Union([
    Schema.TaggedStruct("Insert", { id: Schema.Json }),
    Schema.TaggedStruct("Update", { id: Schema.Json, columns: Schema.Array(Schema.String) }),
    Schema.TaggedStruct("Delete", { id: Schema.Json })
  ])
})
const decodeAnyChange = Schema.decodeUnknownOption(AnyChangeJson)

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

    // --- many-to-many fields ---------------------------------------------------
    // Read with every row (a correlated subquery per field, in the same
    // statement), so rows always carry them.

    const links = Field.links(model.fields)
    const selectRows = links.length === 0
      ? sql`SELECT * FROM ${table}`
      : sql`SELECT ${table}.*, ${sql.csv(links.map((l) => ManyToMany.select(sql, l, options.table, options.idColumn)))} FROM ${table}`
    const decode = (rows: ReadonlyArray<object>) =>
      decodeRows(ManyToMany.parse(links, rows as ReadonlyArray<Record<string, unknown>>))

    const list = (q: ListQuery<Sortable, FK>): Effect.Effect<Page<Row>, SqlError.SqlError | Schema.SchemaError> =>
      Effect.gen(function*() {
        const where = options.query.where(sql, q, options.idColumn)
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

    const findByIds = (ids: ReadonlyArray<RowId>) =>
      sql`${selectRows} WHERE ${sql.in(options.idColumn, ids)}`.pipe(
        Effect.flatMap(decode),
        Effect.withSpan(`${options.table}.findByIds`)
      )

    const findById = (id: RowId): Effect.Effect<Row, Cause.NoSuchElementError | Schema.SchemaError | SqlError.SqlError> =>
      links.length === 0
        // The model needs no services (see `make`'s constraint), which TS can't see through the generic.
        ? base.findById(id) as Effect.Effect<Row, Cause.NoSuchElementError | Schema.SchemaError | SqlError.SqlError>
        : Effect.flatMap(
          sql`${selectRows} WHERE ${sql(options.idColumn)} = ${id}`.pipe(Effect.flatMap(decode)),
          (rows) => rows[0] === undefined ? Effect.fail(new Cause.NoSuchElementError()) : Effect.succeed(rows[0])
        )

    /**
     * Insert or update a row with many-to-many fields: the row, then its join
     * rows (callers run it in a transaction). Both are written from the
     * variant's encoded value, with the link fields split off. `before` is the
     * row's current version when the caller read it in the same transaction:
     * its ids are what the join table holds, so they needn't be read again.
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
    const writeLinked = (
      encoded: unknown,
      mode: { readonly fresh: true } | { readonly fresh: false; readonly before: Row | undefined }
    ) =>
      Effect.gen(function*() {
        const { row, linked } = split(encoded)
        const id = row[options.idColumn]
        const written = mode.fresh
          ? yield* sql`INSERT INTO ${table} ${sql.insert(row as Record<string, never>).returning("*")}`
          : yield* sql`UPDATE ${table} SET ${sql.update(row as Record<string, never>, [options.idColumn])}
                        WHERE ${sql(options.idColumn)} = ${id as never} RETURNING *`
        const saved = written[0] as Record<string, unknown> | undefined
        // As `makeRepository`: the row was there a moment ago (callers check first).
        if (saved === undefined) return yield* Effect.die(new Cause.NoSuchElementError(`${options.table}: no row ${String(id)}`))
        const previous = mode.fresh || mode.before === undefined
          ? undefined
          : (yield* encodeRow(mode.before)) as Record<string, ReadonlyArray<unknown>>
        for (const [link, ids] of linked) {
          yield* ManyToMany.write(sql, link, saved[options.idColumn], ids, mode.fresh ? [] : previous?.[link.key])
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

    const announce = (change: Change<RowId>) =>
      Effect.sync(() => {
        const payload: Schema.Json = encodeChange({ table: options.table, change })
        payloads.invalidateUnsafe({ [options.table]: [change.id] }, payload)
      })

    /** Why this table's key was invalidated, from the current payload (local or remote). */
    const tableSignal = (): Signal<RowId> => {
      const payload = payloads.current()
      const decoded = payload === undefined ? Option.none() : decodeChange(payload)
      return Option.isSome(decoded) ? { _tag: "Change", change: decoded.value.change } : { _tag: "Table" }
    }

    /** Why a `dependsOn` key was invalidated: another repo's change, if the payload says. */
    const dependencySignal = (): Signal<RowId> => {
      const payload = payloads.current()
      const decoded = payload === undefined ? Option.none() : decodeAnyChange(payload)
      return Option.isSome(decoded)
        ? { _tag: "Dependency", table: decoded.value.table, change: decoded.value.change }
        : { _tag: "Dependency" }
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
      Effect.tap(
        links.length === 0
          ? base.insert(value)
          : Effect.flatMap(encodeInsert(value), (encoded) => {
            const write = writeLinked(encoded, { fresh: true })
            // A new row without join rows is one statement: no transaction needed.
            return split(encoded).linked.every(([, ids]) => ids.length === 0) ? write : sql.withTransaction(write)
          }),
        (row: Row) => announce({ _tag: "Insert", id: idOf(row) })
      )

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
        // With many-to-many fields, the row and its join rows are written in one
        // transaction, and the previous version is read inside it (its ids tell
        // which join rows to change).
        const id: RowId = value[options.idColumn]
        const readBefore = watchers === 0 && !payloads.crossProcess
          ? Effect.succeed(undefined)
          : findById(id).pipe(Effect.catchTag("NoSuchElementError", () => Effect.succeed(undefined)))
        const [before, after] = links.length === 0
          ? [yield* readBefore, yield* base.update(value)] as const
          : yield* sql.withTransaction(Effect.gen(function*() {
            const encoded = yield* encodeUpdate(value)
            const before = yield* readBefore
            return [before, yield* writeLinked(encoded, { fresh: false, before })] as const
          }))
        yield* announce({ _tag: "Update", id: idOf(after), columns: yield* changedColumns(before, after) })
        return after
      })

    // Join rows go with the row (`ON DELETE CASCADE`).
    const remove = (id: RowId) => Effect.tap(base.delete(id), () => announce({ _tag: "Delete", id }))

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
        // Registered before the first query, so no change can slip in between.
        yield* register([options.table], tableSignal)
        const dependsOn = liveOptions?.dependsOn ?? []
        if (dependsOn.length > 0) yield* register(dependsOn, dependencySignal)

        const queryColumns = new Set(options.query.columns(q))
        let current: Page<Row> | undefined

        const requery = (reason: "initial" | "table" | "dependency") =>
          Effect.map(list(q), (page): ReadonlyArray<LiveEvent<Row>> => {
            current = page
            return [{ _tag: "Page", page, reason }]
          })

        /** Re-fetches rows of the current page; `undefined` if one vanished (deleted meanwhile). */
        const refetch = (ids: ReadonlyArray<RowId>) =>
          Effect.map(findByIds(ids), (fetched) => {
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
    const repo = { findById, list, live, insert, update, delete: remove }
    return repo as unknown as Repo<S, Id, Sortable, FK>
  })
