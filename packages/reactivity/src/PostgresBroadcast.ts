/**
 * `Broadcast` over Postgres `LISTEN` / `NOTIFY`.
 *
 * - `publish` encodes invalidations into JSON frames capped at Postgres's
 *   8000-byte `NOTIFY` payload limit (UTF-8) and sends each frame via `NOTIFY`.
 *   Large batches are split across multiple frames; if a single invalidation
 *   with a `payload` exceeds the limit, it falls back to a keys-only
 *   invalidation (logging a warning), or fails with `BroadcastError` if even
 *   the keys alone exceed the limit.
 * - `make` / `layer` acquires a `LISTEN` subscription on the configured channel
 *   and cleanly calls `UNLISTEN` when the scope closes.
 * - Each instance tags outgoing frames with its own `origin` id and suppresses
 *   self-origin echoes before delivering to subscribers.
 *
 * Callers provide a minimal `PgNotifyClient` backed by any Postgres driver
 * (`pg`, `postgres`, `@effect/sql-pg`, etc.), keeping this package free of
 * mandatory driver dependencies.
 */
import { type Cause, Context, Effect, Layer, Option, Queue, Schema, type Scope, Stream } from "effect"
import type * as Arr from "effect/Array"
import { Broadcast, BroadcastError, Invalidation, type Received } from "./Broadcast.ts"

export const DEFAULT_CHANNEL = "effect_reactivity"
export const MAX_PAYLOAD_BYTES = 8000

const CHANNEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const MAX_CHANNEL_LENGTH = 63

const utf8Encoder = new TextEncoder()
const byteLength = (value: string): number => utf8Encoder.encode(value).byteLength

/**
 * Minimal Postgres `LISTEN` / `NOTIFY` driver interface.
 *
 * Implement this service using `pg`, `postgres`, `@effect/sql-pg`, or an
 * in-memory bus for testing.
 */
export class PgNotifyClient extends Context.Service<PgNotifyClient, {
  /** Execute `NOTIFY <channel>, <payload>` (e.g. `SELECT pg_notify($1, $2)`). */
  readonly notify: (channel: string, payload: string) => Effect.Effect<void, unknown>
  /**
   * Execute `LISTEN <channel>` and invoke `onNotification` for each incoming
   * payload received on that channel.
   */
  readonly listen: (channel: string, onNotification: (payload: string) => void) => Effect.Effect<void, unknown>
  /** Execute `UNLISTEN <channel>` and detach any listener registered for it. */
  readonly unlisten: (channel: string) => Effect.Effect<void, unknown>
}>()("effect-datastar/reactivity/PgNotifyClient") {}

export interface Options {
  /** Postgres channel name (safe identifier). Defaults to `"effect_reactivity"`. */
  readonly channel?: string | undefined
  /** Instance origin id used to suppress self-origin echoes. Defaults to `crypto.randomUUID()`. */
  readonly origin?: string | undefined
  /** Maximum UTF-8 byte length per `NOTIFY` frame. Defaults to `8000` (Postgres limit). */
  readonly maxPayloadBytes?: number | undefined
}

const WireFrame = Schema.Struct({
  origin: Schema.String,
  messages: Schema.Array(Invalidation)
})
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(WireFrame))
const encodeInvalidation = Schema.encodeEffect(Schema.fromJsonString(Invalidation))

const fail = (message: string) => (cause: unknown) => new BroadcastError({ message, cause })

/** Validate a Postgres unquoted identifier suitable for `LISTEN` / `NOTIFY`. */
export const validateChannel = (channel: string): Effect.Effect<string, BroadcastError> =>
  CHANNEL_RE.test(channel) && channel.length <= MAX_CHANNEL_LENGTH
    ? Effect.succeed(channel)
    : Effect.fail(
      new BroadcastError({
        message:
          `Invalid Postgres channel name "${channel}": must match ${CHANNEL_RE.source} and be at most ${MAX_CHANNEL_LENGTH} characters`,
        cause: new Error(`Invalid Postgres channel name: ${channel}`)
      })
    )

const validateMaxPayloadBytes = (maxPayloadBytes: number): Effect.Effect<number, BroadcastError> =>
  Number.isInteger(maxPayloadBytes) && maxPayloadBytes > 0
    ? Effect.succeed(maxPayloadBytes)
    : Effect.fail(
      new BroadcastError({
        message: `Invalid maxPayloadBytes (${maxPayloadBytes}): must be a positive integer`,
        cause: new Error(`Invalid maxPayloadBytes: ${maxPayloadBytes}`)
      })
    )

const packFrames = (
  origin: string,
  messages: Arr.NonEmptyReadonlyArray<Invalidation>,
  maxPayloadBytes: number
): Effect.Effect<ReadonlyArray<string>, BroadcastError> =>
  Effect.gen(function*() {
    const prefix = `{"origin":${JSON.stringify(origin)},"messages":[`
    const suffix = "]}"
    const overhead = byteLength(prefix) + byteLength(suffix)

    const frames: Array<string> = []
    let currentItems: Array<string> = []
    let currentBytes = overhead

    for (const message of messages) {
      let encoded = yield* encodeInvalidation(message).pipe(
        Effect.mapError(fail("Could not encode invalidation"))
      )
      let itemBytes = byteLength(encoded)

      if (overhead + itemBytes > maxPayloadBytes) {
        if (message.payload !== undefined) {
          const stripped = yield* encodeInvalidation({
            origin: message.origin,
            keys: message.keys
          }).pipe(Effect.mapError(fail("Could not encode invalidation")))
          const strippedBytes = byteLength(stripped)
          if (overhead + strippedBytes <= maxPayloadBytes) {
            yield* Effect.logWarning(
              `Invalidation payload exceeded Postgres NOTIFY limit (${overhead + itemBytes} > ${maxPayloadBytes} bytes); sending keys-only invalidation`
            )
            encoded = stripped
            itemBytes = strippedBytes
          } else {
            return yield* Effect.fail(
              new BroadcastError({
                message:
                  `Single invalidation exceeds Postgres NOTIFY payload limit of ${maxPayloadBytes} bytes (${overhead + strippedBytes} bytes even without payload)`,
                cause: new Error("Invalidation exceeds Postgres NOTIFY payload limit")
              })
            )
          }
        } else {
          return yield* Effect.fail(
            new BroadcastError({
              message:
                `Single invalidation exceeds Postgres NOTIFY payload limit of ${maxPayloadBytes} bytes (${overhead + itemBytes} bytes)`,
              cause: new Error("Invalidation exceeds Postgres NOTIFY payload limit")
            })
          )
        }
      }

      const addedBytes = currentItems.length === 0 ? itemBytes : 1 + itemBytes
      if (currentItems.length > 0 && currentBytes + addedBytes > maxPayloadBytes) {
        frames.push(`${prefix}${currentItems.join(",")}${suffix}`)
        currentItems = [encoded]
        currentBytes = overhead + itemBytes
      } else {
        currentItems.push(encoded)
        currentBytes += addedBytes
      }
    }

    if (currentItems.length > 0) {
      frames.push(`${prefix}${currentItems.join(",")}${suffix}`)
    }

    return frames
  })

export const make = (
  options: Options = {}
): Effect.Effect<Broadcast["Service"], BroadcastError, PgNotifyClient | Scope.Scope> =>
  Effect.gen(function*() {
    const channel = yield* validateChannel(options.channel ?? DEFAULT_CHANNEL)
    const maxPayloadBytes = yield* validateMaxPayloadBytes(options.maxPayloadBytes ?? MAX_PAYLOAD_BYTES)
    const instanceOrigin = options.origin ?? crypto.randomUUID()
    const client = yield* PgNotifyClient
    const subscribers = new Set<Queue.Queue<Received, Cause.Done>>()

    const onNotification = (raw: string): void => {
      const parsed = decodeFrame(raw)
      if (Option.isNone(parsed)) return
      const frame = parsed.value
      if (frame.origin === instanceOrigin) return
      for (const invalidation of frame.messages) {
        const received: Received = { _tag: "Invalidation", invalidation }
        for (const queue of subscribers) {
          Queue.offerUnsafe(queue, received)
        }
      }
    }

    yield* Effect.acquireRelease(
      client.listen(channel, onNotification).pipe(
        Effect.mapError(fail(`Could not LISTEN on Postgres channel "${channel}"`))
      ),
      () =>
        Effect.gen(function*() {
          for (const queue of subscribers) {
            yield* Queue.end(queue)
          }
          subscribers.clear()
          yield* client.unlisten(channel).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`Could not UNLISTEN on Postgres channel "${channel}"`, cause)
            )
          )
        })
    )

    const publish: Broadcast["Service"]["publish"] = (messages) =>
      Effect.gen(function*() {
        const frames = yield* packFrames(instanceOrigin, messages, maxPayloadBytes)
        for (const frame of frames) {
          yield* client.notify(channel, frame).pipe(
            Effect.mapError(fail(`Could not NOTIFY on Postgres channel "${channel}"`))
          )
        }
      })

    const subscribe: Broadcast["Service"]["subscribe"] = Effect.gen(function*() {
      const queue = yield* Queue.unbounded<Received, Cause.Done>()
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          subscribers.add(queue)
        }),
        () =>
          Effect.sync(() => {
            subscribers.delete(queue)
          }).pipe(Effect.andThen(Queue.end(queue)))
      )
      return Stream.fromQueue(queue)
    })

    return Broadcast.of({ publish, subscribe })
  })

/** Requires a `PgNotifyClient` connected to the shared Postgres database. */
export const layer = (options: Options = {}): Layer.Layer<Broadcast, BroadcastError, PgNotifyClient> =>
  Layer.effect(Broadcast)(make(options))
