/**
 * Cross-process reactivity, in-process: several nodes (each with its own
 * SQLite connection, Broadcast and Reactivity) sharing one temp database file.
 */
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Context, Duration, Effect, Exit, Layer, Option, Queue, Scope, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as DistributedReactivity from "../src/DistributedReactivity.ts"
import { InvalidationPayload } from "../src/Payload.ts"
import * as SqliteBroadcast from "../src/SqliteBroadcast.ts"

const dir = mkdtempSync(join(tmpdir(), "effect-datastar-reactivity-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let files = 0
const tempDb = () => join(dir, `db-${files++}.sqlite`)

const pollInterval = Duration.millis(20)

/** One node, open until `scope` closes. */
const node = (filename: string, scope: Scope.Scope, options: SqliteBroadcast.Options = {}) =>
  DistributedReactivity.layer.pipe(
    Layer.provide(SqliteBroadcast.layer({ pollInterval, ...options })),
    Layer.provideMerge(SqliteClient.layer({ filename })),
    Layer.buildWithScope(scope),
    Effect.map((context) => ({
      reactivity: Context.get(context, Reactivity.Reactivity),
      payloads: Context.get(context, InvalidationPayload),
      sql: Context.get(context, SqlClient.SqlClient)
    }))
  )

/** A stream on `keys` that counts its runs; `next` waits for the next emission (`None` after `ms`). */
const watch = (reactivity: Reactivity.Reactivity, keys: Parameters<Reactivity.Reactivity["invalidate"]>[0]) =>
  Effect.gen(function*() {
    let runs = 0
    const emitted = yield* Queue.unbounded<number>()
    yield* reactivity.stream(keys, Effect.sync(() => ++runs)).pipe(
      Stream.runForEach((n) => Queue.offer(emitted, n)),
      Effect.forkScoped
    )
    yield* Queue.take(emitted) // the initial run
    return {
      next: (ms = 2000) => Effect.timeoutOption(Queue.take(emitted), Duration.millis(ms)),
      runs: () => runs
    }
  })

const rowCount = (sql: SqlClient.SqlClient) =>
  sql<{ n: number }>`SELECT COUNT(*) AS n FROM reactivity_invalidations`.pipe(Effect.map((r) => r[0]?.n ?? 0))

describe("DistributedReactivity over SqliteBroadcast", () => {
  it.live("a mutation on one node re-runs a stream on another, once", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const file = tempDb()
      const a = yield* node(file, scope)
      const b = yield* node(file, scope)

      const onA = yield* watch(a.reactivity, ["users"])
      const onB = yield* watch(b.reactivity, ["users"])
      const teamsOnB = yield* watch(b.reactivity, ["teams"])

      const latencies: Array<number> = []
      for (let i = 0; i < 5; i++) {
        const started = Date.now()
        yield* a.reactivity.mutation(["users"], Effect.void)
        expect(Option.isSome(yield* onB.next())).toBe(true)
        latencies.push(Date.now() - started)
      }
      console.log(`cross-node latency (poll ${Duration.toMillis(pollInterval)} ms): ${latencies.join(", ")} ms`)

      // B writes too, so A's next poll reads every new row, its own included.
      yield* b.reactivity.mutation(["users"], Effect.void)
      expect(Option.isSome(yield* onA.next())).toBe(true)

      // Let any stray broadcasts arrive, then count: one re-run per mutation on
      // each node, so neither re-applied its own published events.
      yield* Effect.sleep(Duration.millis(200))
      expect(onA.runs()).toBe(7)
      expect(onB.runs()).toBe(7)
      // Other keys are untouched.
      expect(teamsOnB.runs()).toBe(1)
    }).pipe(Effect.scoped))

  it.live("both directions, and record keys keep their ids", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const file = tempDb()
      const a = yield* node(file, scope)
      const b = yield* node(file, scope)

      const user1 = yield* watch(a.reactivity, { users: [1] })
      // `{ users: [2] }` would also register the bare `users` key, which
      // `{ users: [1] }` invalidates; `users:2` is the id-only key.
      const user2 = yield* watch(a.reactivity, ["users:2"])
      yield* b.reactivity.invalidate({ users: [1] })
      expect(Option.isSome(yield* user1.next())).toBe(true)
      expect(Option.isNone(yield* user2.next(200))).toBe(true)
    }).pipe(Effect.scoped))

  it.live("a new node does not replay old invalidations", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const file = tempDb()
      const a = yield* node(file, scope)
      yield* a.reactivity.invalidate(["users"])
      yield* a.reactivity.invalidate(["users"])
      yield* Effect.sleep(Duration.millis(100))
      expect(yield* rowCount(a.sql)).toBe(2)

      const b = yield* node(file, scope)
      const onB = yield* watch(b.reactivity, ["users"])
      expect(Option.isNone(yield* onB.next(300))).toBe(true)

      // ...but sees new ones.
      yield* a.reactivity.invalidate(["users"])
      expect(Option.isSome(yield* onB.next())).toBe(true)
    }).pipe(Effect.scoped))

  it.live("invalidations deferred to a transaction's commit are broadcast", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const file = tempDb()
      const a = yield* node(file, scope)
      const b = yield* node(file, scope)
      const onB = yield* watch(b.reactivity, ["users"])

      // Rolled back: nothing is invalidated anywhere.
      yield* a.sql.withTransaction(Effect.andThen(Reactivity.invalidate(["users"]), Effect.fail("rollback"))).pipe(
        Effect.provideService(Reactivity.Reactivity, a.reactivity),
        Effect.ignore
      )
      expect(Option.isNone(yield* onB.next(300))).toBe(true)

      yield* a.sql.withTransaction(Reactivity.invalidate(["users"])).pipe(
        Effect.provideService(Reactivity.Reactivity, a.reactivity)
      )
      expect(Option.isSome(yield* onB.next())).toBe(true)
    }).pipe(Effect.scoped))

  it.live("withBatch publishes when the batch ends", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const file = tempDb()
      const a = yield* node(file, scope)
      const b = yield* node(file, scope)
      const onB = yield* watch(b.reactivity, ["users"])

      yield* a.reactivity.withBatch(Effect.gen(function*() {
        yield* a.reactivity.invalidate(["users"])
        yield* Effect.sleep(Duration.millis(300))
        expect(onB.runs()).toBe(1)
      }))
      expect(Option.isSome(yield* onB.next())).toBe(true)
    }).pipe(Effect.scoped))

  it.live("prunes old rows, and ids keep increasing after pruning", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const file = tempDb()
      const prunes = { retention: Duration.millis(50), pruneInterval: Duration.millis(25) }
      const a = yield* node(file, scope, prunes)
      const b = yield* node(file, scope, prunes)
      const onB = yield* watch(b.reactivity, ["users"])

      yield* a.reactivity.invalidate(["users"])
      expect(Option.isSome(yield* onB.next())).toBe(true)
      yield* Effect.sleep(Duration.millis(200))
      expect(yield* rowCount(a.sql)).toBe(0)

      // The table is empty, but the next row still gets a fresh id past B's cursor.
      yield* a.reactivity.invalidate(["users"])
      expect(Option.isSome(yield* onB.next())).toBe(true)
    }).pipe(Effect.scoped))

  it.live("flushes queued invalidations on shutdown", () =>
    Effect.gen(function*() {
      const outer = yield* Scope.Scope
      const file = tempDb()
      const b = yield* node(file, outer)
      const onB = yield* watch(b.reactivity, ["users"])

      const inner = yield* Scope.make()
      const a = yield* node(file, inner)
      a.reactivity.invalidateUnsafe(["users"])
      yield* Scope.close(inner, Exit.void)
      expect(Option.isSome(yield* onB.next())).toBe(true)
    }).pipe(Effect.scoped))
})

describe("payloads", () => {
  /** Records `payloads.current()` each time a handler on `keys` runs. */
  const record = (n: { reactivity: Reactivity.Reactivity; payloads: InvalidationPayload["Service"] }, keys: Array<string>) =>
    Effect.gen(function*() {
      const seen = yield* Queue.unbounded<unknown>()
      yield* Effect.acquireRelease(
        Effect.sync(() => n.reactivity.registerUnsafe(keys, () => Queue.offerUnsafe(seen, n.payloads.current()))),
        (cancel) => Effect.sync(cancel)
      )
      return { next: (ms = 2000) => Effect.timeoutOption(Queue.take(seen), Duration.millis(ms)) }
    })

  it.live("a payload reaches handlers on every node, exactly as sent", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const file = tempDb()
      const a = yield* node(file, scope)
      const b = yield* node(file, scope)
      const onA = yield* record(a, ["users"])
      const onB = yield* record(b, ["users"])
      const payload = { table: "users", change: { _tag: "Update", id: 42, columns: ["name"] } }

      a.payloads.invalidateUnsafe({ users: [42] }, payload)
      expect(yield* onA.next()).toEqual(Option.some(payload))
      expect(yield* onB.next()).toEqual(Option.some(payload))
      // Outside handlers, and for invalidations without one, there is no payload.
      expect(a.payloads.current()).toBeUndefined()
      yield* a.reactivity.invalidate(["users"])
      expect(yield* onB.next()).toEqual(Option.some(undefined))
    }).pipe(Effect.scoped))

  it.live("adds the payload column to a table created before payloads, and reads keys-only rows", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const file = tempDb()
      const old = yield* SqliteClient.make({ filename: file }).pipe(Effect.provide(Reactivity.layer))
      yield* old`CREATE TABLE reactivity_invalidations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, keys TEXT NOT NULL, createdAt INTEGER NOT NULL
      )`
      const b = yield* node(file, scope)
      const columns = yield* b.sql<{ name: string }>`SELECT name FROM pragma_table_info('reactivity_invalidations')`
      expect(columns.map((c) => c.name)).toContain("payload")

      const onB = yield* record(b, ["users"])
      yield* old`INSERT INTO reactivity_invalidations (origin, keys, createdAt) VALUES ('old', '["users"]', ${Date.now()})`
      expect(yield* onB.next()).toEqual(Option.some(undefined))
    }).pipe(Effect.scoped))
})

describe("gaps", () => {
  it.live("a node that stalls past the retention re-runs everything registered", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const file = tempDb()
      const prunes = { retention: Duration.millis(150), pruneInterval: Duration.millis(25) }
      const a = yield* node(file, scope, prunes)
      // B polls so rarely that A's row is pruned before B reads it: a stall.
      const b = yield* node(file, scope, { ...prunes, pollInterval: Duration.millis(800) })
      // C keeps up.
      const c = yield* node(file, scope, prunes)

      const usersOnB = yield* watch(b.reactivity, ["users"])
      const teamsOnB = yield* watch(b.reactivity, ["teams"])
      let recordRuns = 0
      const cancel = b.reactivity.registerUnsafe({ posts: [3] }, () => recordRuns++)
      const teamsOnC = yield* watch(c.reactivity, ["teams"])
      const usersOnC = yield* watch(c.reactivity, ["users"])

      yield* a.reactivity.invalidate(["users"])
      expect(Option.isSome(yield* usersOnC.next())).toBe(true)
      yield* Effect.sleep(Duration.millis(300))
      expect(yield* rowCount(a.sql)).toBe(0)

      // B's next poll finds the row gone: everything registered on B re-runs,
      // not only what was invalidated.
      expect(Option.isSome(yield* usersOnB.next())).toBe(true)
      expect(Option.isSome(yield* teamsOnB.next())).toBe(true)
      expect(recordRuns).toBe(1)
      cancel()
      // C read the row in time: no gap there.
      expect(Option.isNone(yield* teamsOnC.next(200))).toBe(true)

      // B carries on from the new end: the same missed rows don't count as a gap twice.
      expect(Option.isNone(yield* teamsOnB.next(1000))).toBe(true)
    }).pipe(Effect.scoped))
})
