/**
 * A `Reactivity` whose invalidations reach every process sharing a `Broadcast`.
 *
 * It is the stock in-memory `Reactivity` with the invalidation paths wrapped:
 *
 * - local invalidations run immediately, as before, and are queued for
 *   publishing; a background fiber publishes the queue in batches, so a
 *   mutation never waits on the broadcast;
 * - messages from other processes are applied with the local
 *   `invalidateUnsafe`, so they are never re-published; messages carrying this
 *   process's own `origin` are skipped, since they were invalidated locally.
 *
 * `invalidateUnsafe` is wrapped too: `SqlClient.withTransaction` calls it after
 * commit for invalidations deferred inside a transaction. Inside
 * `withBatch`, keys are published when the batch ends, like the local handlers.
 *
 * Payloads: the layer also provides `InvalidationPayload`. A payload given to
 * its `invalidateUnsafe` is published with the keys, and while a received
 * message's handlers run, `current()` returns that message's payload, exactly
 * as it does for a local invalidation. What the payload means is up to the
 * invalidator (e.g. `Repo` sends the row change); this module only carries it.
 *
 * Gaps: when the broadcast reports lost messages, every key that has a
 * handler registered in this process is invalidated (without a payload), so
 * every live query re-runs. Registrations are tracked for that purpose:
 * `registerUnsafe`, `query` and `stream` are wrapped.
 *
 * Only keys that survive JSON (strings, numbers, booleans) can cross processes;
 * others still invalidate locally, and are logged and skipped for publishing.
 */
import { Context, Effect, Layer, Queue, Schedule, Schema, type Scope, Stream } from "effect"
import * as Arr from "effect/Array"
import { Reactivity } from "effect/reactivity"
import { Broadcast, type BroadcastError, type Invalidation, Keys } from "./Broadcast.ts"
import { InvalidationPayload, type Keys as AnyKeys, makeSlot } from "./Payload.ts"

interface Outgoing {
  readonly keys: AnyKeys
  readonly payload?: Schema.Json | undefined
}

class PendingBroadcast extends Context.Service<PendingBroadcast, Array<AnyKeys>>()(
  "effect-datastar/reactivity/DistributedReactivity/PendingBroadcast"
) {}

const isKeys = Schema.is(Keys)

/**
 * Every key with a live registration, merged into (at most) two invalidations:
 * one for list keys and one for record keys.
 */
const mergeKeys = (all: Iterable<AnyKeys>): ReadonlyArray<AnyKeys> => {
  const list = new Set<unknown>()
  const record = new Map<string, Set<unknown>>()
  for (const keys of all) {
    if (Array.isArray(keys)) {
      for (const key of keys) list.add(key)
    } else {
      for (const [table, ids] of Object.entries(keys as Readonly<Record<string, ReadonlyArray<unknown>>>)) {
        const set = record.get(table) ?? new Set()
        for (const id of ids) set.add(id)
        record.set(table, set)
      }
    }
  }
  const out: Array<AnyKeys> = []
  if (list.size > 0) out.push([...list])
  if (record.size > 0) out.push(Object.fromEntries([...record].map(([table, ids]) => [table, [...ids]])))
  return out
}

export interface Distributed {
  readonly reactivity: Reactivity.Reactivity
  readonly payloads: InvalidationPayload["Service"]
}

export const make: Effect.Effect<Distributed, BroadcastError, Broadcast | Scope.Scope> = Effect.gen(
  function*() {
    const broadcast = yield* Broadcast
    const local = yield* Reactivity.make
    const origin = crypto.randomUUID()
    const slot = makeSlot()
    const outbox = yield* Queue.unbounded<Outgoing>()
    const enqueue = (keys: AnyKeys, payload?: Schema.Json) => {
      Queue.offerUnsafe(outbox, payload === undefined ? { keys } : { keys, payload })
    }

    // --- registrations, for gaps ---------------------------------------------

    const registered = new Set<{ readonly keys: AnyKeys }>()
    const track = (keys: AnyKeys) => {
      const entry = { keys }
      registered.add(entry)
      return () => {
        registered.delete(entry)
      }
    }
    const tracked = Effect.fnUntraced(function*(keys: AnyKeys) {
      yield* Effect.acquireRelease(Effect.sync(() => track(keys)), (untrack) => Effect.sync(untrack))
    })
    /** Re-run everything registered in this process; nothing is published. */
    const invalidateRegisteredUnsafe = () => {
      for (const keys of mergeKeys([...registered].map((r) => r.keys))) slot.run(undefined, () => local.invalidateUnsafe(keys))
    }

    // --- publishing ------------------------------------------------------------

    const publish = (batch: ReadonlyArray<Outgoing>) =>
      Effect.gen(function*() {
        const messages: Array<Invalidation> = []
        for (const { keys, payload } of batch) {
          if (!isKeys(keys)) yield* Effect.logWarning("Reactivity keys can't be broadcast (not JSON primitives)", keys)
          else messages.push(payload === undefined ? { origin, keys } : { origin, keys, payload })
        }
        if (Arr.isReadonlyArrayNonEmpty(messages)) yield* broadcast.publish(messages)
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Publishing invalidations failed", cause)),
        // Once a batch is taken from the outbox, finish publishing it even when shutting down.
        Effect.uninterruptible
      )

    // Finalizers run in reverse order: this runs after the publisher below is
    // interrupted, flushing whatever it had not taken yet.
    yield* Effect.addFinalizer(() => Effect.flatMap(Queue.clear(outbox), publish))
    yield* Queue.takeAll(outbox).pipe(Effect.flatMap(publish), Effect.forever, Effect.forkScoped)

    // --- receiving -------------------------------------------------------------

    // Subscribe before the layer is ready, so nothing published after startup is missed.
    const incoming = yield* broadcast.subscribe
    yield* incoming.pipe(
      Stream.runForEach((received) => {
        if (received._tag === "Gap") {
          return Effect.andThen(
            Effect.logWarning(`Missed ${received.missed} invalidation(s); re-running every live query`),
            Effect.sync(invalidateRegisteredUnsafe)
          )
        }
        const message = received.invalidation
        return Effect.sync(() => {
          if (message.origin !== origin) slot.run(message.payload, () => local.invalidateUnsafe(message.keys))
        })
      }),
      Effect.tapCause((cause) => Effect.logWarning("Invalidation subscription failed; retrying", cause)),
      Effect.retry(Schedule.spaced("1 second")),
      Effect.forkScoped
    )

    // --- the wrapped Reactivity ------------------------------------------------

    const invalidateUnsafe = (keys: AnyKeys): void => {
      local.invalidateUnsafe(keys)
      enqueue(keys)
    }

    const invalidate = (keys: AnyKeys): Effect.Effect<void> =>
      Effect.contextWith((services) => {
        const pending = Context.getOrUndefined(services, PendingBroadcast)
        if (pending) pending.push(keys)
        else enqueue(keys)
        return local.invalidate(keys)
      })

    const withBatch = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const pending: Array<AnyKeys> = []
        return local.withBatch(Effect.provideService(effect, PendingBroadcast, pending)).pipe(
          Effect.ensuring(Effect.sync(() => pending.forEach((keys) => enqueue(keys))))
        )
      })

    const registerUnsafe = (keys: AnyKeys, handler: () => void): () => void => {
      const untrack = track(keys)
      const cancel = local.registerUnsafe(keys, handler)
      return () => {
        untrack()
        cancel()
      }
    }

    const reactivity = Reactivity.Reactivity.of({
      ...local,
      invalidateUnsafe,
      invalidate,
      mutation: (keys, effect) => Effect.tap(effect, invalidate(keys)),
      withBatch,
      registerUnsafe,
      query: (keys, effect) => Effect.andThen(tracked(keys), local.query(keys, effect)),
      stream: (keys, effect) => Stream.unwrap(Effect.as(tracked(keys), local.stream(keys, effect)))
    })

    const payloads = InvalidationPayload.of({
      invalidateUnsafe: (keys, payload) => {
        slot.run(payload, () => local.invalidateUnsafe(keys))
        enqueue(keys, payload)
      },
      current: slot.current,
      crossProcess: true
    })

    return { reactivity, payloads }
  }
)

/**
 * `Reactivity` across processes, plus `InvalidationPayload` for invalidations
 * that say what changed. Requires a `Broadcast` (e.g. `SqliteBroadcast.layer`).
 */
export const layer: Layer.Layer<Reactivity.Reactivity | InvalidationPayload, BroadcastError, Broadcast> = Layer
  .effectContext(
    Effect.map(make, ({ payloads, reactivity }) =>
      Context.make(Reactivity.Reactivity, reactivity).pipe(Context.add(InvalidationPayload, payloads)))
  )
