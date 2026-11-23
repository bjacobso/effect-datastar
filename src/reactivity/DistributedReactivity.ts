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
 * Only keys that survive JSON (strings, numbers, booleans) can cross processes;
 * others still invalidate locally, and are logged and skipped for publishing.
 */
import { Context, Effect, Layer, Queue, Schedule, Schema, type Scope, Stream } from "effect"
import * as Arr from "effect/Array"
import { Reactivity } from "effect/reactivity"
import { Broadcast, type BroadcastError, type Invalidation, Keys } from "./Broadcast.ts"

type AnyKeys = Parameters<Reactivity.Reactivity["invalidate"]>[0]

class PendingBroadcast extends Context.Service<PendingBroadcast, Array<AnyKeys>>()(
  "effect-datastar/reactivity/DistributedReactivity/PendingBroadcast"
) {}

const isKeys = Schema.is(Keys)

export const make: Effect.Effect<Reactivity.Reactivity, BroadcastError, Broadcast | Scope.Scope> = Effect.gen(
  function*() {
    const broadcast = yield* Broadcast
    const local = yield* Reactivity.make
    const origin = crypto.randomUUID()
    const outbox = yield* Queue.unbounded<AnyKeys>()
    const enqueue = (keys: AnyKeys) => {
      Queue.offerUnsafe(outbox, keys)
    }

    const publish = (batch: ReadonlyArray<AnyKeys>) =>
      Effect.gen(function*() {
        const messages: Array<Invalidation> = []
        for (const keys of batch) {
          if (isKeys(keys)) messages.push({ origin, keys })
          else yield* Effect.logWarning("Reactivity keys can't be broadcast (not JSON primitives)", keys)
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

    // Subscribe before the layer is ready, so nothing published after startup is missed.
    const incoming = yield* broadcast.subscribe
    yield* incoming.pipe(
      Stream.runForEach((message) =>
        Effect.sync(() => {
          if (message.origin !== origin) local.invalidateUnsafe(message.keys)
        })
      ),
      Effect.tapCause((cause) => Effect.logWarning("Invalidation subscription failed; retrying", cause)),
      Effect.retry(Schedule.spaced("1 second")),
      Effect.forkScoped
    )

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
          Effect.ensuring(Effect.sync(() => pending.forEach(enqueue)))
        )
      })

    return Reactivity.Reactivity.of({
      ...local,
      invalidateUnsafe,
      invalidate,
      mutation: (keys, effect) => Effect.tap(effect, invalidate(keys)),
      withBatch
    })
  }
)

/** `Reactivity` across processes. Requires a `Broadcast` (e.g. `SqliteBroadcast.layer`). */
export const layer: Layer.Layer<Reactivity.Reactivity, BroadcastError, Broadcast> = Layer.effect(
  Reactivity.Reactivity
)(make)
