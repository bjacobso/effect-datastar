/**
 * `Broadcast` over a shared SQLite file: an append-only table, polled.
 *
 * - `publish` inserts one row per invalidation.
 * - `subscribe` starts at the current end of the table (old rows are never
 *   replayed) and polls with a cursor on `id`. Each poll first reads
 *   `PRAGMA data_version`, which only changes when another connection commits,
 *   so an idle poll costs one pragma rather than a table read.
 * - Rows older than `retention` are pruned by every process.
 *
 * Ids come from `AUTOINCREMENT`, so they are never reused after pruning, and
 * SQLite's single writer means rows commit in id order: a cursor can't skip a
 * row that commits later with a smaller id.
 */
import { Clock, Config, Duration, Effect, Layer, Schedule, Schema, type Scope, Stream } from "effect"
import * as Arr from "effect/Array"
import { SqlClient, type SqlError } from "effect/sql"
import { Broadcast, BroadcastError, type Invalidation, Keys } from "./Broadcast.ts"

export interface Options {
  /** How often to look for new rows. Defaults to `INVALIDATION_POLL_INTERVAL`, else 100 millis. */
  readonly pollInterval?: Duration.Input | undefined
  /** How long rows are kept. A process that stalls for longer misses them. Defaults to 1 minute. */
  readonly retention?: Duration.Input | undefined
  /** How often to prune. Defaults to 30 seconds. */
  readonly pruneInterval?: Duration.Input | undefined
  /** Defaults to `reactivity_invalidations`. */
  readonly table?: string | undefined
}

const Row = Schema.Struct({ id: Schema.Finite, origin: Schema.String, keys: Schema.fromJsonString(Keys) })
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))
const encodeKeys = Schema.encodeEffect(Schema.fromJsonString(Keys))

const fail = (message: string) => (cause: SqlError.SqlError | Schema.SchemaError) =>
  new BroadcastError({ message, cause })

export const make = (
  options: Options = {}
): Effect.Effect<Broadcast["Service"], BroadcastError, SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const name = options.table ?? "reactivity_invalidations"
    const table = sql(name)
    const pollInterval = options.pollInterval ?? (yield* Config.Duration("INVALIDATION_POLL_INTERVAL").pipe(
      Config.withDefault(Duration.millis(100)),
      Effect.orDie
    ))
    const retention = Duration.toMillis(options.retention ?? Duration.minutes(1))

    yield* sql`CREATE TABLE IF NOT EXISTS ${table} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin TEXT NOT NULL,
      keys TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )`.pipe(Effect.mapError(fail("Could not create the invalidations table")))

    const publish = (messages: ReadonlyArray<Invalidation>) =>
      Effect.gen(function*() {
        const createdAt = yield* Clock.currentTimeMillis
        const rows = yield* Effect.forEach(messages, (m) =>
          Effect.map(encodeKeys(m.keys), (keys) => ({ origin: m.origin, keys, createdAt })))
        if (Arr.isArrayNonEmpty(rows)) yield* sql`INSERT INTO ${table} ${sql.insert(rows)}`
      }).pipe(Effect.mapError(fail("Could not publish invalidations")))

    const subscribe = Effect.gen(function*() {
      // The newest id ever assigned, even if that row is already pruned.
      const start = yield* sql<{ seq: number }>`SELECT seq FROM sqlite_sequence WHERE name = ${name}`
      let cursor = start[0]?.seq ?? 0
      let version: number | undefined

      const poll = Effect.gen(function*() {
        const [current] = yield* sql<{ data_version: number }>`PRAGMA data_version`
        if (current !== undefined && current.data_version === version) return []
        version = current?.data_version
        const rows = yield* decodeRows(yield* sql`SELECT id, origin, keys FROM ${table} WHERE id > ${cursor} ORDER BY id`)
        const last = rows.at(-1)
        if (last !== undefined) cursor = last.id
        return rows.map(({ origin, keys }): Invalidation => ({ origin, keys }))
      }).pipe(
        // A failed poll (e.g. a busy database) is retried on the next tick from the same cursor.
        Effect.catchCause((cause) => Effect.as(Effect.logWarning("Polling invalidations failed", cause), []))
      )

      return Stream.fromEffectSchedule(poll, Schedule.spaced(pollInterval)).pipe(Stream.flattenIterable)
    }).pipe(Effect.mapError(fail("Could not subscribe to invalidations")))

    const prune = Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      yield* sql`DELETE FROM ${table} WHERE createdAt < ${now - retention}`
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Pruning invalidations failed", cause)))

    yield* prune.pipe(
      Effect.repeat(Schedule.spaced(options.pruneInterval ?? Duration.seconds(30))),
      Effect.forkScoped
    )

    return Broadcast.of({ publish, subscribe })
  })

/** Requires the `SqlClient` of the shared database. */
export const layer = (options: Options = {}): Layer.Layer<Broadcast, BroadcastError, SqlClient.SqlClient> =>
  Layer.effect(Broadcast)(make(options))
