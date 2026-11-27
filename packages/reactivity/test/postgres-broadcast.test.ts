/**
 * Cross-process reactivity over PostgresBroadcast using an in-memory simulated
 * Postgres LISTEN/NOTIFY bus shared between multiple independent nodes.
 */
import { describe, expect, it } from "@effect/vitest"
import { Context, Duration, Effect, Exit, Layer, Option, Queue, Scope, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import { Broadcast, type Invalidation, type Received } from "../src/Broadcast.ts"
import * as DistributedReactivity from "../src/DistributedReactivity.ts"
import { InvalidationPayload } from "../src/Payload.ts"
import * as PostgresBroadcast from "../src/PostgresBroadcast.ts"

const utf8Encoder = new TextEncoder()
const byteLength = (value: string): number => utf8Encoder.encode(value).byteLength

interface BusEvent {
  readonly type: "listen" | "unlisten" | "notify"
  readonly clientId: number
  readonly channel: string
  readonly payload?: string
}

/**
 * In-memory Postgres LISTEN/NOTIFY simulator.
 *
 * Mimics real Postgres behavior:
 * - Each client has its own connection/listeners.
 * - `NOTIFY` echoes to all listeners on the channel, *including* the notifying client.
 * - Enforces Postgres's 8000-byte UTF-8 payload limit (failing if exceeded).
 */
const makePgBus = () => {
  let nextClientId = 1
  const channels = new Map<string, Map<number, (payload: string) => void>>()
  const events: Array<BusEvent> = []

  const makeClient = () => {
    const clientId = nextClientId++
    return PostgresBroadcast.PgNotifyClient.of({
      notify: (channel, payload) =>
        Effect.suspend(() => {
          if (byteLength(payload) > PostgresBroadcast.MAX_PAYLOAD_BYTES) {
            return Effect.fail(new Error(`payload string too long (${byteLength(payload)} bytes)`))
          }
          events.push({ type: "notify", clientId, channel, payload })
          const listeners = channels.get(channel)
          if (listeners) {
            for (const handler of [...listeners.values()]) {
              handler(payload)
            }
          }
          return Effect.void
        }),
      listen: (channel, onNotification) =>
        Effect.sync(() => {
          events.push({ type: "listen", clientId, channel })
          let listeners = channels.get(channel)
          if (!listeners) {
            listeners = new Map()
            channels.set(channel, listeners)
          }
          listeners.set(clientId, onNotification)
        }),
      unlisten: (channel) =>
        Effect.sync(() => {
          events.push({ type: "unlisten", clientId, channel })
          const listeners = channels.get(channel)
          if (listeners) {
            listeners.delete(clientId)
            if (listeners.size === 0) channels.delete(channel)
          }
        })
    })
  }

  const listenerCount = (channel: string) => channels.get(channel)?.size ?? 0

  return { makeClient, events, listenerCount }
}

type PgBus = ReturnType<typeof makePgBus>

/** One DistributedReactivity node backed by PostgresBroadcast on the shared bus. */
const node = (bus: PgBus, scope: Scope.Scope, options: PostgresBroadcast.Options = {}) =>
  DistributedReactivity.layer.pipe(
    Layer.provide(PostgresBroadcast.layer(options)),
    Layer.provide(Layer.succeed(PostgresBroadcast.PgNotifyClient, bus.makeClient())),
    Layer.buildWithScope(scope),
    Effect.map((context) => ({
      reactivity: Context.get(context, Reactivity.Reactivity),
      payloads: Context.get(context, InvalidationPayload)
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
    yield* Queue.take(emitted) // initial run
    return {
      next: (ms = 1000) => Effect.timeoutOption(Queue.take(emitted), Duration.millis(ms)),
      runs: () => runs
    }
  })

/** Records `payloads.current()` each time a handler on `keys` runs. */
const record = (
  n: { reactivity: Reactivity.Reactivity; payloads: InvalidationPayload["Service"] },
  keys: Array<string>
) =>
  Effect.gen(function*() {
    const seen = yield* Queue.unbounded<unknown>()
    yield* Effect.acquireRelease(
      Effect.sync(() => n.reactivity.registerUnsafe(keys, () => Queue.offerUnsafe(seen, n.payloads.current()))),
      (cancel) => Effect.sync(cancel)
    )
    return { next: (ms = 1000) => Effect.timeoutOption(Queue.take(seen), Duration.millis(ms)) }
  })

describe("DistributedReactivity over PostgresBroadcast", () => {
  it.live("propagates invalidations across nodes and suppresses self-echoes", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const bus = makePgBus()
      const a = yield* node(bus, scope)
      const b = yield* node(bus, scope)

      const onA = yield* watch(a.reactivity, ["users"])
      const onB = yield* watch(b.reactivity, ["users"])
      const teamsOnB = yield* watch(b.reactivity, ["teams"])

      for (let i = 0; i < 3; i++) {
        yield* a.reactivity.mutation(["users"], Effect.void)
        expect(Option.isSome(yield* onB.next())).toBe(true)
      }

      yield* b.reactivity.mutation(["users"], Effect.void)
      expect(Option.isSome(yield* onA.next())).toBe(true)

      yield* Effect.sleep(Duration.millis(100))
      // Initial run + 3 mutations from A + 1 mutation from B = 5 runs each; no self-echo double runs.
      expect(onA.runs()).toBe(5)
      expect(onB.runs()).toBe(5)
      expect(teamsOnB.runs()).toBe(1)
    }).pipe(Effect.scoped))

  it.live("delivers payloads across nodes intact, and undefined for keys-only invalidations", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const bus = makePgBus()
      const a = yield* node(bus, scope)
      const b = yield* node(bus, scope)

      const onA = yield* record(a, ["users"])
      const onB = yield* record(b, ["users"])
      const payload = { table: "users", change: { _tag: "Update", id: 42, columns: ["name"] } }

      a.payloads.invalidateUnsafe({ users: [42] }, payload)
      expect(yield* onA.next()).toEqual(Option.some(payload))
      expect(yield* onB.next()).toEqual(Option.some(payload))

      yield* a.reactivity.invalidate(["users"])
      expect(yield* onA.next()).toEqual(Option.some(undefined))
      expect(yield* onB.next()).toEqual(Option.some(undefined))
    }).pipe(Effect.scoped))

  it.live("isolates nodes on different channel names", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const bus = makePgBus()
      const a = yield* node(bus, scope, { channel: "app_one" })
      const b = yield* node(bus, scope, { channel: "app_two" })

      const onB = yield* watch(b.reactivity, ["users"])
      yield* a.reactivity.invalidate(["users"])
      expect(Option.isNone(yield* onB.next(150))).toBe(true)
    }).pipe(Effect.scoped))
})

describe("PostgresBroadcast", () => {
  it.live("suppresses self-origin echoes at the Broadcast layer", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const bus = makePgBus()
      const makeBroadcast = (origin: string) =>
        PostgresBroadcast.layer({ origin }).pipe(
          Layer.provide(Layer.succeed(PostgresBroadcast.PgNotifyClient, bus.makeClient())),
          Layer.buildWithScope(scope),
          Effect.map((ctx) => Context.get(ctx, Broadcast))
        )

      const broadcastA = yield* makeBroadcast("node-a")
      const broadcastB = yield* makeBroadcast("node-b")

      const streamA = yield* broadcastA.subscribe
      const streamB = yield* broadcastB.subscribe

      const seenA = yield* Queue.unbounded<Received>()
      const seenB = yield* Queue.unbounded<Received>()

      yield* streamA.pipe(Stream.runForEach((r) => Queue.offer(seenA, r)), Effect.forkScoped)
      yield* streamB.pipe(Stream.runForEach((r) => Queue.offer(seenB, r)), Effect.forkScoped)

      yield* broadcastA.publish([{ origin: "custom-origin", keys: ["users"] }])

      // B receives it, A suppresses its own echo even though invalidation.origin differs from instance origin.
      const fromB = yield* Effect.timeoutOption(Queue.take(seenB), Duration.millis(500))
      expect(fromB).toEqual(
        Option.some({
          _tag: "Invalidation",
          invalidation: { origin: "custom-origin", keys: ["users"] }
        })
      )
      const fromA = yield* Effect.timeoutOption(Queue.take(seenA), Duration.millis(150))
      expect(Option.isNone(fromA)).toBe(true)
    }).pipe(Effect.scoped))

  it.live("chunks large batches across multiple NOTIFY frames under the 8000-byte limit", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const bus = makePgBus()
      const makeBroadcast = (origin: string) =>
        PostgresBroadcast.layer({ origin }).pipe(
          Layer.provide(Layer.succeed(PostgresBroadcast.PgNotifyClient, bus.makeClient())),
          Layer.buildWithScope(scope),
          Effect.map((ctx) => Context.get(ctx, Broadcast))
        )

      const sender = yield* makeBroadcast("sender")
      const receiver = yield* makeBroadcast("receiver")

      const stream = yield* receiver.subscribe
      const received = yield* Queue.unbounded<Received>()
      yield* stream.pipe(Stream.runForEach((r) => Queue.offer(received, r)), Effect.forkScoped)

      // 40 messages x ~350 bytes each ~= 14,000 bytes total (> 8000 bytes).
      const batch = Array.from({ length: 40 }, (_, i): Invalidation => ({
        origin: "sender",
        keys: { items: [i] },
        payload: { index: i, note: "x".repeat(300) }
      })) as [Invalidation, ...Array<Invalidation>]

      yield* sender.publish(batch)

      const notifyEvents = bus.events.filter((e) => e.type === "notify")
      expect(notifyEvents.length).toBeGreaterThan(1)
      for (const event of notifyEvents) {
        expect(byteLength(event.payload!)).toBeLessThanOrEqual(PostgresBroadcast.MAX_PAYLOAD_BYTES)
      }

      const items: Array<Received> = []
      for (let i = 0; i < batch.length; i++) {
        items.push(yield* Queue.take(received))
      }
      expect(items.length).toBe(40)
      expect(items[0]).toEqual({ _tag: "Invalidation", invalidation: batch[0] })
      expect(items[39]).toEqual({ _tag: "Invalidation", invalidation: batch[39] })
    }).pipe(Effect.scoped))

  it.live("falls back to keys-only when a single message payload exceeds 8000 bytes, and fails when keys alone exceed 8000 bytes", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.Scope
      const bus = makePgBus()
      const makeBroadcast = (origin: string) =>
        PostgresBroadcast.layer({ origin }).pipe(
          Layer.provide(Layer.succeed(PostgresBroadcast.PgNotifyClient, bus.makeClient())),
          Layer.buildWithScope(scope),
          Effect.map((ctx) => Context.get(ctx, Broadcast))
        )

      const sender = yield* makeBroadcast("sender")
      const receiver = yield* makeBroadcast("receiver")

      const stream = yield* receiver.subscribe
      const received = yield* Queue.unbounded<Received>()
      yield* stream.pipe(Stream.runForEach((r) => Queue.offer(received, r)), Effect.forkScoped)

      // 1. Oversized payload (9000 bytes) with small keys -> falls back to keys-only invalidation.
      yield* sender.publish([
        { origin: "sender", keys: ["users"], payload: { blob: "a".repeat(9000) } }
      ])
      const fallback = yield* Effect.timeoutOption(Queue.take(received), Duration.millis(500))
      expect(fallback).toEqual(
        Option.some({
          _tag: "Invalidation",
          invalidation: { origin: "sender", keys: ["users"] }
        })
      )

      // 2. Oversized keys alone (> 8000 bytes) -> fails with BroadcastError.
      const exit = yield* Effect.exit(
        sender.publish([{ origin: "sender", keys: ["k".repeat(8500)] }])
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("BroadcastError")
        expect(String(exit.cause)).toContain("8000")
      }
    }).pipe(Effect.scoped))

  it.live("validates Postgres channel names", () =>
    Effect.gen(function*() {
      const invalidNames = [
        "",
        "123_starts_with_digit",
        "bad-hyphen",
        "semi;colon",
        "has space",
        "a".repeat(64)
      ]

      for (const channel of invalidNames) {
        const bus = makePgBus()
        const exit = yield* Effect.exit(
          PostgresBroadcast.make({ channel }).pipe(
            Effect.provideService(PostgresBroadcast.PgNotifyClient, bus.makeClient()),
            Effect.scoped
          )
        )
        expect(Exit.isFailure(exit)).toBe(true)
        // Must reject before calling LISTEN.
        expect(bus.events.length).toBe(0)
      }

      const validBus = makePgBus()
      const validExit = yield* Effect.exit(
        PostgresBroadcast.make({ channel: "_valid_Channel_123" }).pipe(
          Effect.provideService(PostgresBroadcast.PgNotifyClient, validBus.makeClient()),
          Effect.scoped
        )
      )
      expect(Exit.isSuccess(validExit)).toBe(true)
    }))

  it.live("calls LISTEN on acquisition and UNLISTEN on scope close", () =>
    Effect.gen(function*() {
      const bus = makePgBus()
      const inner = yield* Scope.make()

      yield* PostgresBroadcast.layer({ channel: "custom_chan" }).pipe(
        Layer.provide(Layer.succeed(PostgresBroadcast.PgNotifyClient, bus.makeClient())),
        Layer.buildWithScope(inner)
      )

      expect(bus.listenerCount("custom_chan")).toBe(1)
      expect(bus.events).toEqual([
        { type: "listen", clientId: 1, channel: "custom_chan" }
      ])

      yield* Scope.close(inner, Exit.void)

      expect(bus.listenerCount("custom_chan")).toBe(0)
      expect(bus.events).toEqual([
        { type: "listen", clientId: 1, channel: "custom_chan" },
        { type: "unlisten", clientId: 1, channel: "custom_chan" }
      ])
    }))
})
