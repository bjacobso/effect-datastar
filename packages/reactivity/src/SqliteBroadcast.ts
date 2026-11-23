/**
 * `Broadcast` over a shared SQLite file: an append-only table, polled.
 *
 * - `publish` inserts one row per invalidation (keys and optional payload as JSON).
 * - `subscribe` starts at the current end of the table (old rows are never
 *   replayed) and polls with a cursor on `id`. Each poll first reads
 *   `PRAGMA data_version`, which only changes when another connection commits,
 *   so an idle poll costs one pragma rather than a table read.
 * - Rows older than `retention` are pruned by every process.
 *
 * Ids come from `AUTOINCREMENT`, so they are never reused after pruning, and
 * SQLite's single writer means rows commit in id order: a cursor can't skip a
 * row that commits later with a smaller id.
 *
 * Gaps: a subscriber that stalls for longer than `retention` (a long GC pause,
 * a suspended VM) finds rows pruned before it read them. Each poll reads the
 * newest id ever assigned (`sqlite_sequence`) and the rows after the cursor in
 * one statement (one snapshot). Every id in `(cursor, seq]` was assigned to a
 * row, so if fewer rows come back, the rest were pruned: the stream delivers a
 * `Gap` before the rows that are left, and the subscriber has to assume
 * anything changed.
 *
 * The `payload` column was added later: a table created by an older version
 * gets it on startup, and rows from older writers have none (`NULL`).
 */
import { Clock, Config, Duration, Effect, Layer, Option, Schedule, Schema, type Scope, Stream } from "effect"
import * as Arr from "effect/Array"
import { SqlClient, type SqlError } from "effect/sql"
import { Broadcast, BroadcastError, type Invalidation, Keys, type Received } from "./Broadcast.ts"

export interface Options {
  /** How often to look for new rows. Defaults to `INVALIDATION_POLL_INTERVAL`, else 100 millis. */
  readonly pollInterval?: Duration.Input | undefined
  /** How long rows are kept. A process that stalls for longer gets a `Gap` instead of the pruned rows. Defaults to 1 minute. */
  readonly retention?: Duration.Input | undefined
  /** How often to prune. Defaults to 30 seconds. */
  readonly pruneInterval?: Duration.Input | undefined
  /** Defaults to `reactivity_invalidations`. */
  readonly table?: string | undefined
}

/** One poll: the sequence, LEFT JOINed with the rows after the cursor (all `NULL` if there are none). */
const PollRow = Schema.Struct({
  seq: Schema.Finite,
  id: Schema.NullOr(Schema.Finite),
  origin: Schema.NullOr(Schema.String),
  keys: Schema.NullOr(Schema.fromJsonString(Keys)),
  payload: Schema.NullOr(Schema.String)
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(PollRow))
const encodeKeys = Schema.encodeEffect(Schema.fromJsonString(Keys))
const PayloadJson = Schema.fromJsonString(Schema.Json)
const encodePayload = Schema.encodeEffect(PayloadJson)
/** A malformed payload is dropped, not fatal: the receiver then treats the change as unknown. */
const decodePayload = Schema.decodeUnknownOption(PayloadJson)

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

    yield* Effect.gen(function*() {
      yield* sql`CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        origin TEXT NOT NULL,
        keys TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        payload TEXT
      )`
      // Tables created before payloads existed. Another process may add it at
      // the same time, so a failed ALTER only counts if the column is still missing.
      const hasPayload = Effect.map(
        sql<{ name: string }>`SELECT name FROM pragma_table_info(${name})`,
        (columns) => columns.some((c) => c.name === "payload")
      )
      if (!(yield* hasPayload)) {
        yield* sql`ALTER TABLE ${table} ADD COLUMN payload TEXT`.pipe(
          Effect.catch((error) => Effect.flatMap(hasPayload, (added) => (added ? Effect.void : Effect.fail(error))))
        )
      }
    }).pipe(Effect.mapError(fail("Could not create the invalidations table")))

    const publish = (messages: ReadonlyArray<Invalidation>) =>
      Effect.gen(function*() {
        const createdAt = yield* Clock.currentTimeMillis
        const rows = yield* Effect.forEach(messages, (m) =>
          Effect.gen(function*() {
            const keys = yield* encodeKeys(m.keys)
            const payload = m.payload === undefined ? null : yield* encodePayload(m.payload)
            return { origin: m.origin, keys, payload, createdAt }
          }))
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
        // One statement, so the sequence and the rows come from the same snapshot.
        // No sequence row means nothing was ever published: no rows either.
        const rows = yield* decodeRows(
          yield* sql`SELECT s.seq AS seq, t.id AS id, t.origin AS origin, t.keys AS keys, t.payload AS payload
            FROM (SELECT seq FROM sqlite_sequence WHERE name = ${name}) AS s
            LEFT JOIN ${table} AS t ON t.id > ${cursor}
            ORDER BY t.id`
        )
        const seq = rows[0]?.seq ?? cursor
        const received: Array<Received> = []
        for (const row of rows) {
          if (row.id === null || row.origin === null || row.keys === null) continue
          const payload = row.payload === null ? Option.none() : decodePayload(row.payload)
          received.push({
            _tag: "Invalidation",
            invalidation: Option.isSome(payload)
              ? { origin: row.origin, keys: row.keys, payload: payload.value }
              : { origin: row.origin, keys: row.keys }
          })
        }
        // Every id in (cursor, seq] was assigned to a row; the ones not returned were pruned.
        const missed = seq - cursor - received.length
        if (seq > cursor) cursor = seq
        const gap: ReadonlyArray<Received> = missed > 0 ? [{ _tag: "Gap", missed }] : []
        return [...gap, ...received]
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
