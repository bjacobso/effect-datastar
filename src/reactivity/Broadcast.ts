/**
 * A transport for reactivity invalidations between server processes.
 *
 * `Reactivity` is process-local. `Broadcast` is the small interface that
 * carries invalidations to the other processes sharing the database:
 * `publish` sends a batch, `subscribe` delivers what was published after the
 * subscription started. Implementations: `SqliteBroadcast` (a polled table);
 * a Postgres one would map `publish` to `NOTIFY` and `subscribe` to `LISTEN`.
 *
 * Messages carry the publishing process's `origin`. Subscribers may see their
 * own messages too (as with `LISTEN/NOTIFY`); `DistributedReactivity` skips them.
 */
import { Context, Schema, type Effect, type Scope, type Stream } from "effect"
import type * as Arr from "effect/Array"

/** Keys that survive the trip through JSON: strings, numbers and booleans. */
export const Key = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])

/** The two shapes `Reactivity` accepts: `["users"]` or `{ users: [1, 2] }`. */
export const Keys = Schema.Union([Schema.Array(Key), Schema.Record(Schema.String, Schema.Array(Key))])
export type Keys = typeof Keys.Type

/** One invalidation, tagged with the process that published it. */
export const Invalidation = Schema.Struct({ origin: Schema.String, keys: Keys })
export type Invalidation = typeof Invalidation.Type

export class BroadcastError extends Schema.TaggedError<BroadcastError>()("BroadcastError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

export class Broadcast extends Context.Service<Broadcast, {
  /** Send invalidations to every subscriber, in every process. */
  readonly publish: (messages: Arr.NonEmptyReadonlyArray<Invalidation>) => Effect.Effect<void, BroadcastError>
  /**
   * Starts listening. Once this succeeds, the stream delivers everything
   * published from then on (never older messages). It may include this
   * process's own messages; consumers filter them by `origin`.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<Invalidation, BroadcastError>, BroadcastError, Scope.Scope>
}>()("effect-datastar/reactivity/Broadcast") {}
