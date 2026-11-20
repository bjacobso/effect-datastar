/**
 * Effect-native Datastar server primitives.
 *
 * - `DatastarEvent` values (patch elements / patch signals) are plain data.
 * - `respond` turns an Effect or Stream of events into an SSE `HttpServerResponse`.
 *   Handlers must have `E = never`: every failure has to be turned into UI
 *   (patches) before it can be served.
 * - `signals(schema)` decodes the signals Datastar sent with the request
 *   (`?datastar=` on GET, JSON body otherwise).
 */
import { Data, Effect, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type PatchMode = "outer" | "inner" | "replace" | "prepend" | "append" | "before" | "after" | "remove"

/** Anything kita/html can produce. Async components are awaited before sending. */
export type Html = string | Promise<string>

export class PatchElements extends Data.TaggedClass("PatchElements")<{
  readonly elements: Html
  readonly selector?: string | undefined
  readonly mode?: PatchMode | undefined
  readonly useViewTransition?: boolean | undefined
}> {}

export class PatchSignals extends Data.TaggedClass("PatchSignals")<{
  readonly signals: unknown
  readonly onlyIfMissing?: boolean | undefined
}> {}

export type DatastarEvent = PatchElements | PatchSignals

export const patchElements = (
  elements: Html,
  options?: Omit<ConstructorParameters<typeof PatchElements>[0], "elements">
): DatastarEvent => new PatchElements({ elements, ...options })

export const removeElements = (selector: string): DatastarEvent =>
  new PatchElements({ elements: "", selector, mode: "remove" })

export const patchSignals = (signals: unknown, options?: { readonly onlyIfMissing?: boolean }): DatastarEvent =>
  new PatchSignals({ signals, ...options })

// ---------------------------------------------------------------------------
// SSE encoding (https://data-star.dev/reference/sse_events)
// ---------------------------------------------------------------------------

const dataLines = (prefix: string, value: string) => value.split("\n").map((line) => `data: ${prefix} ${line}\n`)

const encodeEvent = (event: DatastarEvent): Effect.Effect<string> =>
  Effect.gen(function*() {
    switch (event._tag) {
      case "PatchElements": {
        const elements = event.elements
        const html = typeof elements === "string" ? elements : yield* Effect.promise(() => elements)
        const lines = ["event: datastar-patch-elements\n"]
        if (event.selector) lines.push(`data: selector ${event.selector}\n`)
        if (event.mode && event.mode !== "outer") lines.push(`data: mode ${event.mode}\n`)
        if (event.useViewTransition) lines.push(`data: useViewTransition true\n`)
        if (html.length > 0) lines.push(...dataLines("elements", html))
        return lines.join("") + "\n"
      }
      case "PatchSignals": {
        const lines = ["event: datastar-patch-signals\n"]
        if (event.onlyIfMissing) lines.push(`data: onlyIfMissing true\n`)
        lines.push(...dataLines("signals", JSON.stringify(event.signals)))
        return lines.join("") + "\n"
      }
    }
  })

const encoder = new TextEncoder()

export type Events = DatastarEvent | ReadonlyArray<DatastarEvent>

/**
 * Serve an Effect (one-shot) or Stream (long-lived) of Datastar events as SSE.
 * The error channel must be `never`: map failures to patches first.
 */
const toArray = (e: Events): ReadonlyArray<DatastarEvent> => (Array.isArray(e) ? e : [e as DatastarEvent])

export const respond = <R>(
  events: Effect.Effect<Events, never, R> | Stream.Stream<Events, never, R>
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  Effect.map(Effect.context<R>(), (context) => {
    const stream: Stream.Stream<DatastarEvent, never, R> = Stream.isStream(events)
      ? Stream.flattenIterable(Stream.map(events, toArray))
      : Stream.fromIterableEffect(Effect.map(events, toArray))
    return HttpServerResponse.stream(
      stream.pipe(
        Stream.mapEffect(encodeEvent),
        Stream.map((s) => encoder.encode(s)),
        Stream.provideContext(context)
      ),
      {
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache", "connection": "keep-alive" }
      }
    )
  })

// ---------------------------------------------------------------------------
// Reading signals
// ---------------------------------------------------------------------------

export class SignalsError extends Data.TaggedError("SignalsError")<{
  readonly cause: unknown
}> {}

/** Raw (undecoded) signals sent with the current request. */
export const rawSignals: Effect.Effect<unknown, SignalsError, HttpServerRequest.HttpServerRequest> = Effect.gen(
  function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method === "GET" || request.method === "DELETE") {
      const url = new URL(request.url, "http://localhost")
      const raw = url.searchParams.get("datastar")
      if (raw === null) return {}
      return yield* Effect.try({ try: () => JSON.parse(raw) as unknown, catch: (cause) => new SignalsError({ cause }) })
    }
    return yield* request.json.pipe(Effect.mapError((cause) => new SignalsError({ cause })))
  }
)

/** Decode the request's signals with a schema. Unknown keys are ignored. */
export const signals = <S extends Schema.Constraint>(schema: S) =>
  Effect.flatMap(rawSignals, (raw) =>
    Schema.decodeUnknownEffect(schema)(raw).pipe(
      Effect.mapError((cause) => new SignalsError({ cause }))
    )) as Effect.Effect<S["Type"], SignalsError, HttpServerRequest.HttpServerRequest | S["DecodingServices"]>
