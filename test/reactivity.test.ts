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
import * as DistributedReactivity from "../src/reactivity/DistributedReactivity.ts"
import * as SqliteBroadcast from "../src/reactivity/SqliteBroadcast.ts"

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
