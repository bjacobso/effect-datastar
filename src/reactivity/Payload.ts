/**
 * A payload riding along with an invalidation.
 *
 * `Reactivity` handlers take no arguments: they learn *that* a key changed,
 * not *what* changed. `InvalidationPayload` adds a side channel: the invalidator
 * attaches a JSON value, and every handler the invalidation runs can read it
 * with `current()` while it runs (handlers run synchronously). Outside of such
 * an invalidation, `current()` is `undefined`.
 *
 *   payloads.invalidateUnsafe({ users: [42] }, { table: "users", change: ... })
 *   reactivity.registerUnsafe(["users"], () => {
 *     const payload = payloads.current()   // the value above, or undefined
 *   })
 *
 * The payload is opaque here. With `DistributedReactivity` it is published
 * alongside the keys, so handlers in other processes read the same value; a
 * process-local `Reactivity` gets the `local` implementation. Either way the
 * handlers can't tell a local invalidation from a remote one.
 *
 * Handlers must treat a missing payload as "unknown change" (bare
 * `Reactivity.invalidate` calls, older processes, and gaps carry none).
 */
import { Context, type Schema } from "effect"
import type { Reactivity } from "effect/reactivity"

export type Keys = Parameters<Reactivity.Reactivity["invalidateUnsafe"]>[0]

export class InvalidationPayload extends Context.Service<InvalidationPayload, {
  /** Invalidate `keys` (like `Reactivity.invalidateUnsafe`) with `payload` visible to the handlers. */
  readonly invalidateUnsafe: (keys: Keys, payload: Schema.Json) => void
  /** The payload of the invalidation whose handlers are running right now, if any. */
  readonly current: () => Schema.Json | undefined
  /**
   * Whether payloads reach other processes. If so, an invalidator can't know
   * who is listening, and should always send its most precise payload.
   */
  readonly crossProcess: boolean
}>()("effect-datastar/reactivity/InvalidationPayload") {}

/**
 * Runs `f` with `payload` as the current payload, restoring the previous one
 * afterwards. Building block for implementations.
 */
export const makeSlot = () => {
  let current: Schema.Json | undefined
  return {
    current: () => current,
    run: (payload: Schema.Json | undefined, f: () => void): void => {
      const previous = current
      current = payload
      try {
        f()
      } finally {
        current = previous
      }
    }
  }
}

/** Payloads for a process-local `Reactivity`. */
export const local = (reactivity: Reactivity.Reactivity): InvalidationPayload["Service"] => {
  const slot = makeSlot()
  return InvalidationPayload.of({
    invalidateUnsafe: (keys, payload) => slot.run(payload, () => reactivity.invalidateUnsafe(keys)),
    current: slot.current,
    crossProcess: false
  })
}
