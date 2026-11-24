/**
 * Layer 4 — `View.make` Composable Schema-driven View.
 *
 * Unifies a namespaced signal tree (`Signals.from`), scoped `Slot`s, typed
 * `View.action` endpoints (auto-deriving both client `filterSignals` and server
 * `Datastar.signals` decoding), and an optional `View.live` SSE stream with
 * jittered reconnect intervals.
 */
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter } from "effect/http"
import type { SignalPath } from "./Attrs.ts"
import * as Datastar from "./Datastar.ts"
import * as Endpoint from "./Endpoint.ts"
import { Action, fromSchema, type SignalTree } from "./Expr.ts"
import type { AnySlot } from "./Slot.ts"

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

type RouteParamsOf<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? { readonly [K in Name]: string } & RouteParamsOf<`/${Rest}`>
  : P extends `${string}:${infer Name}` ? { readonly [K in Name]: string }
  : Readonly<Record<string, never>>

// ---------------------------------------------------------------------------
// Action descriptors & bound actions
// ---------------------------------------------------------------------------

export interface ActionHandlerContext<SignalsData, P extends string> {
  readonly signals: SignalsData
  readonly params: RouteParamsOf<P>
}

export interface ActionDescriptor<
  P extends string = string,
  Keys extends ReadonlyArray<string> | undefined = ReadonlyArray<string> | undefined,
  SignalsData = unknown,
  R = never
> {
  readonly _tag: "ViewAction"
  readonly method: Method
  readonly path: P
  readonly signals?: Keys
  readonly handle: (
    ctx: ActionHandlerContext<SignalsData, P>
  ) => Effect.Effect<Datastar.Events, never, R> | Stream.Stream<Datastar.Events, never, R>
  readonly onSignalsError?: ((error: Datastar.SignalsError) => Datastar.Events) | undefined
}

export interface BoundAction<P extends string, R> {
  readonly method: Method
  readonly path: string
  readonly route: HttpRouter.Route<never, R>
  readonly include: ReadonlyArray<SignalPath> | undefined
  readonly call: {} extends Endpoint.ParamsOf<P>
    ? (params?: Endpoint.ParamsOf<P>, options?: Endpoint.CallOptions) => Action
    : (params: Endpoint.ParamsOf<P>, options?: Endpoint.CallOptions) => Action
}

type SignalKeysOf<S extends Schema.Top> =
  unknown extends S["Type"] ? string : keyof S["Type"] & string

type SignalsPayloadFor<
  S extends Schema.Top,
  Keys extends ReadonlyArray<string> | undefined
> = Keys extends ReadonlyArray<infer K extends string>
  ? unknown extends S["Type"]
    ? Readonly<Record<K, unknown>>
    : Pick<S["Type"], K & keyof S["Type"]>
  : undefined

/** Define a view action (standalone or with an explicit signal schema type parameter). */
export const action = <
  S extends Schema.Top = Schema.Top,
  const P extends HttpRouter.PathInput = HttpRouter.PathInput,
  const Keys extends ReadonlyArray<SignalKeysOf<S>> | undefined = undefined,
  R = never
>(
  method: Method,
  path: P,
  config: {
    readonly signals?: Keys
    readonly handle: (
      ctx: ActionHandlerContext<SignalsPayloadFor<S, Keys>, P>
    ) => Effect.Effect<Datastar.Events, never, R> | Stream.Stream<Datastar.Events, never, R>
    readonly onSignalsError?: ((error: Datastar.SignalsError) => Datastar.Events) | undefined
  }
): ActionDescriptor<P, Keys, SignalsPayloadFor<S, Keys>, R> => ({
  _tag: "ViewAction",
  method,
  path,
  ...(config.signals !== undefined ? { signals: config.signals } : {}),
  handle: config.handle,
  ...(config.onSignalsError !== undefined ? { onSignalsError: config.onSignalsError } : {})
})

// ---------------------------------------------------------------------------
// Live descriptors & bound live streams
// ---------------------------------------------------------------------------

export type JitterOption =
  | boolean
  | {
    readonly min?: number | undefined
    readonly max?: number | undefined
  }

export interface LiveDescriptor<
  P extends string = string,
  Keys extends ReadonlyArray<string> | undefined = ReadonlyArray<string> | undefined,
  SignalsData = unknown,
  R = never
> {
  readonly _tag: "ViewLive"
  readonly path: P
  readonly signals?: Keys
  readonly jitter?: JitterOption | undefined
  readonly handle: (
    ctx: ActionHandlerContext<SignalsData, P>
  ) => Stream.Stream<Datastar.Events, never, R> | Effect.Effect<Datastar.Events, never, R>
  readonly onSignalsError?: ((error: Datastar.SignalsError) => Datastar.Events) | undefined
}

export interface BoundLive<P extends string, R> {
  readonly path: string
  readonly route: HttpRouter.Route<never, R>
  readonly include: ReadonlyArray<SignalPath> | undefined
  readonly call: {} extends Endpoint.ParamsOf<P>
    ? (params?: Endpoint.ParamsOf<P>, options?: Endpoint.CallOptions) => Action
    : (params: Endpoint.ParamsOf<P>, options?: Endpoint.CallOptions) => Action
}

export const live = <
  S extends Schema.Top = Schema.Top,
  const P extends HttpRouter.PathInput = HttpRouter.PathInput,
  const Keys extends ReadonlyArray<SignalKeysOf<S>> | undefined = undefined,
  R = never
>(
  path: P,
  handle: (
    ctx: ActionHandlerContext<SignalsPayloadFor<S, Keys>, P>
  ) => Stream.Stream<Datastar.Events, never, R> | Effect.Effect<Datastar.Events, never, R>,
  options?: {
    readonly signals?: Keys
    readonly jitter?: JitterOption | undefined
    readonly onSignalsError?: ((error: Datastar.SignalsError) => Datastar.Events) | undefined
  }
): LiveDescriptor<P, Keys, SignalsPayloadFor<S, Keys>, R> => ({
  _tag: "ViewLive",
  path,
  handle,
  ...(options?.signals !== undefined ? { signals: options.signals } : {}),
  ...(options?.jitter !== undefined ? { jitter: options.jitter } : {}),
  ...(options?.onSignalsError !== undefined ? { onSignalsError: options.onSignalsError } : {})
})

// ---------------------------------------------------------------------------
// View builder context (for typed callback form of `actions` / `live`)
// ---------------------------------------------------------------------------

export interface ViewBuilder<S extends Schema.Top, Slots extends Record<string, AnySlot>> {
  readonly $: SignalTree<S>
  readonly slots: Slots
  readonly patchSignals: (partial: Partial<S["Type"]>) => Datastar.DatastarEvent
  readonly action: <
    const P extends HttpRouter.PathInput,
    const Keys extends ReadonlyArray<keyof S["Type"] & string> | undefined = undefined,
    R = never
  >(
    method: Method,
    path: P,
    config: {
      readonly signals?: Keys
      readonly handle: (
        ctx: ActionHandlerContext<SignalsPayloadFor<S, Keys>, P>
      ) => Effect.Effect<Datastar.Events, never, R> | Stream.Stream<Datastar.Events, never, R>
      readonly onSignalsError?: ((error: Datastar.SignalsError) => Datastar.Events) | undefined
    }
  ) => ActionDescriptor<P, Keys, SignalsPayloadFor<S, Keys>, R>
  readonly live: <
    const P extends HttpRouter.PathInput,
    const Keys extends ReadonlyArray<keyof S["Type"] & string> | undefined = undefined,
    R = never
  >(
    path: P,
    handle: (
      ctx: ActionHandlerContext<SignalsPayloadFor<S, Keys>, P>
    ) => Stream.Stream<Datastar.Events, never, R> | Effect.Effect<Datastar.Events, never, R>,
    options?: {
      readonly signals?: Keys
      readonly jitter?: JitterOption | undefined
      readonly onSignalsError?: ((error: Datastar.SignalsError) => Datastar.Events) | undefined
    }
  ) => LiveDescriptor<P, Keys, SignalsPayloadFor<S, Keys>, R>
}

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

type ActionRequirements<Actions extends Record<string, ActionDescriptor<any, any, any, any>>> =
  {
    [K in keyof Actions]: Actions[K] extends ActionDescriptor<any, any, any, infer R> ? R : never
  }[keyof Actions]

type LiveRequirements<L> = L extends LiveDescriptor<any, any, any, infer R> ? R : never

type BoundActions<Actions extends Record<string, ActionDescriptor<any, any, any, any>>> = {
  readonly [K in keyof Actions]: Actions[K] extends ActionDescriptor<infer P, any, any, infer R>
    ? BoundAction<P, Exclude<R, HttpRouter.Provided>>
    : never
}

type BoundLiveOf<L> = L extends LiveDescriptor<infer P, any, any, infer R>
  ? BoundLive<P, Exclude<R, HttpRouter.Provided>>
  : undefined

export interface View<
  S extends Schema.Top,
  Slots extends Record<string, AnySlot>,
  Actions extends Record<string, ActionDescriptor<any, any, any, any>>,
  L extends LiveDescriptor<any, any, any, any> | undefined = undefined
> {
  readonly name: string
  readonly $: SignalTree<S>
  readonly slots: Slots
  readonly actions: BoundActions<Actions>
  readonly live: BoundLiveOf<L>
  readonly routes: ReadonlyArray<
    HttpRouter.Route<never, Exclude<ActionRequirements<Actions> | LiveRequirements<L>, HttpRouter.Provided>>
  >
  readonly layer: Layer.Layer<
    never,
    never,
    Exclude<ActionRequirements<Actions> | LiveRequirements<L>, HttpRouter.Provided>
  >
  /** Server-side decoder for this view's full namespaced signal struct. */
  readonly decodeSignals: Effect.Effect<
    S["Type"],
    Datastar.SignalsError,
    HttpRouter.Provided | S["DecodingServices"]
  >
  /** Produce a `PatchSignals` event scoped to this view's signal namespace. */
  readonly patchSignals: (partial: Partial<S["Type"]>) => Datastar.DatastarEvent
  /** Mount an independent copy of this view under namespace `ns` without signal, slot, or route collisions. */
  readonly scope: (ns: string) => View<S, Slots, Actions, L>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const sanitizeSignalSegment = (segment: string): string =>
  segment.replace(/[^a-zA-Z0-9_$]/g, "_")

const wrapNamespaceSchema = (
  signalPrefix: string,
  inner: Schema.Top
): Schema.Top => {
  const segments = signalPrefix.split(".").filter((s) => s.length > 0)
  let current: Schema.Top = inner
  for (let i = segments.length - 1; i >= 0; i--) {
    current = Schema.Struct({ [segments[i]!]: current })
  }
  return current
}

const unwrapNamespace = (signalPrefix: string, decoded: unknown): unknown => {
  const segments = signalPrefix.split(".").filter((s) => s.length > 0)
  let current: any = decoded
  for (const seg of segments) {
    current = current?.[seg]
  }
  return current
}

const wrapNamespaceValue = (signalPrefix: string, value: unknown): unknown => {
  const segments = signalPrefix.split(".").filter((s) => s.length > 0)
  let out: unknown = value
  for (let i = segments.length - 1; i >= 0; i--) {
    out = { [segments[i]!]: out }
  }
  return out
}

const pickStructSchema = (
  schema: Schema.Top,
  keys: ReadonlyArray<string>
): Schema.Top => {
  const fields = (schema as { readonly fields?: Record<string, Schema.Top> }).fields
  if (!fields) return schema
  const picked: Record<string, Schema.Top> = {}
  for (const k of keys) {
    if (k in fields) picked[k] = fields[k]!
  }
  return Schema.Struct(picked)
}

const computeJitter = (jitter: JitterOption | undefined): number | undefined => {
  if (!jitter) return undefined
  const min = typeof jitter === "object" && jitter.min !== undefined ? jitter.min : 1000
  const max = typeof jitter === "object" && jitter.max !== undefined ? jitter.max : 2000
  const span = Math.max(0, max - min)
  return min + Math.floor(Math.random() * (span + 1))
}

// ---------------------------------------------------------------------------
// `View.make`
// ---------------------------------------------------------------------------

export interface ViewConfig<
  S extends Schema.Codec<any, any, never, never>,
  Slots extends Record<string, AnySlot>,
  Actions extends Record<string, ActionDescriptor<any, any, any, any>>,
  L extends LiveDescriptor<any, any, any, any> | undefined
> {
  readonly signals: S
  readonly slots?: Slots | undefined
  readonly actions?: Actions | ((ctx: ViewBuilder<S, Slots>) => Actions) | undefined
  readonly live?: L | ((ctx: ViewBuilder<S, Slots>) => L) | undefined
  readonly onSignalsError?: ((error: Datastar.SignalsError) => Datastar.Events) | undefined
}

const buildView = <
  S extends Schema.Codec<any, any, never, never>,
  Slots extends Record<string, AnySlot>,
  Actions extends Record<string, ActionDescriptor<any, any, any, any>>,
  L extends LiveDescriptor<any, any, any, any> | undefined
>(
  name: string,
  config: ViewConfig<S, Slots, Actions, L>,
  namespaces: ReadonlyArray<string>
): View<S, Slots, Actions, L> => {
  const signalSegments = [...namespaces.map(sanitizeSignalSegment), sanitizeSignalSegment(name)]
  const signalPrefix = signalSegments.join(".")
  const slotPrefix = [...namespaces, name].join("-")
  const routePrefix = namespaces.length > 0 ? `/${namespaces.join("/")}` : ""

  const $ = fromSchema(config.signals, signalPrefix)

  // Scope all slots under `slotPrefix`
  const scopedSlots: Record<string, AnySlot> = {}
  if (config.slots) {
    for (const [k, slot] of Object.entries(config.slots)) {
      scopedSlots[k] = slot.scope(slotPrefix)
    }
  }
  const slots = scopedSlots as Slots

  const patchSignals = (partial: Partial<S["Type"]>): Datastar.DatastarEvent =>
    Datastar.patchSignals(wrapNamespaceValue(signalPrefix, partial))

  const fullWrappedSchema = wrapNamespaceSchema(signalPrefix, config.signals)
  const decodeSignals = Datastar.signals(fullWrappedSchema as any).pipe(
    Effect.map((decoded) => unwrapNamespace(signalPrefix, decoded) as S["Type"])
  )

  const builder: ViewBuilder<S, Slots> = {
    $,
    slots,
    patchSignals,
    action: (method, path, cfg) => action(method, path, cfg as any) as any,
    live: (path, handle, opts) => live(path, handle as any, opts as any) as any
  }

  const actionDefs = (
    typeof config.actions === "function" ? config.actions(builder) : config.actions ?? {}
  ) as Actions

  const liveDef = (
    typeof config.live === "function" ? config.live(builder) : config.live
  ) as L

  const routes: Array<HttpRouter.Route<never, any>> = []
  const boundActions: Record<string, BoundAction<any, any>> = {}

  const makeHandler = (
    keys: ReadonlyArray<string> | undefined,
    handle: (ctx: ActionHandlerContext<any, any>) => Effect.Effect<Datastar.Events, never, any> | Stream.Stream<Datastar.Events, never, any>,
    onSignalsError?: (error: Datastar.SignalsError) => Datastar.Events
  ) => {
    const errorFallback = onSignalsError ?? config.onSignalsError ?? (() => [] as ReadonlyArray<Datastar.DatastarEvent>)
    const subSchema = keys && keys.length > 0
      ? wrapNamespaceSchema(signalPrefix, pickStructSchema(config.signals, keys))
      : undefined

    return Effect.gen(function*() {
      const params = yield* HttpRouter.params
      let signalsData: unknown = undefined
      if (subSchema !== undefined) {
        const decodedResult = yield* Datastar.signals(subSchema as any).pipe(Effect.result)
        if (decodedResult._tag === "Failure") {
          return yield* Datastar.respond(Effect.succeed(errorFallback(decodedResult.failure)))
        }
        signalsData = unwrapNamespace(signalPrefix, decodedResult.success)
      }
      const result = handle({ signals: signalsData, params: params as any })
      return yield* Datastar.respond(Stream.isStream(result) ? result : (result as Effect.Effect<Datastar.Events, never, any>))
    })
  }

  for (const [key, def] of Object.entries(actionDefs)) {
    const include: ReadonlyArray<SignalPath> | undefined =
      def.signals && def.signals.length > 0
        ? def.signals.map((k: string) => `${signalPrefix}.${k}` as SignalPath)
        : undefined

    const ep = Endpoint.make(
      def.method,
      def.path as HttpRouter.PathInput,
      Effect.succeed([]),
      {
        ...(include ? { include } : {}),
        ...(routePrefix ? { prefix: routePrefix } : {})
      }
    )

    const route = HttpRouter.route(
      def.method,
      ep.path as HttpRouter.PathInput,
      makeHandler(def.signals, def.handle, def.onSignalsError)
    )

    routes.push(route)
    boundActions[key] = {
      method: def.method,
      path: ep.path,
      route,
      include,
      call: ((params?: any, options?: Endpoint.CallOptions) =>
        Action.raw((ep.call as any)(params, options))) as any
    }
  }

  let boundLive: BoundLive<any, any> | undefined = undefined
  if (liveDef !== undefined) {
    const include: ReadonlyArray<SignalPath> | undefined =
      liveDef.signals && liveDef.signals.length > 0
        ? liveDef.signals.map((k: string) => `${signalPrefix}.${k}` as SignalPath)
        : undefined

    const ep = Endpoint.make(
      "GET",
      liveDef.path as HttpRouter.PathInput,
      Effect.succeed([]),
      {
        ...(include ? { include } : {}),
        ...(routePrefix ? { prefix: routePrefix } : {})
      }
    )

    const route = HttpRouter.route(
      "GET",
      ep.path as HttpRouter.PathInput,
      makeHandler(liveDef.signals, liveDef.handle, liveDef.onSignalsError)
    )

    routes.push(route)
    boundLive = {
      path: ep.path,
      route,
      include,
      call: ((params?: any, options?: Endpoint.CallOptions) => {
        const retryInterval = options?.retryInterval ?? computeJitter(liveDef.jitter)
        const mergedOptions: Endpoint.CallOptions = {
          openWhenHidden: true,
          ...options,
          ...(retryInterval !== undefined ? { retryInterval } : {})
        }
        return Action.raw((ep.call as any)(params, mergedOptions))
      }) as any
    }
  }

  const layer = HttpRouter.addAll(routes)

  return {
    name,
    $,
    slots,
    actions: boundActions as BoundActions<Actions>,
    live: boundLive as BoundLiveOf<L>,
    routes: routes as any,
    layer: layer as any,
    decodeSignals: decodeSignals as any,
    patchSignals,
    scope: (ns: string) => buildView(name, config, [...namespaces, ns])
  }
}

export const make = <
  S extends Schema.Codec<any, any, never, never>,
  Slots extends Record<string, AnySlot> = {},
  Actions extends Record<string, ActionDescriptor<any, any, any, any>> = {},
  L extends LiveDescriptor<any, any, any, any> | undefined = undefined
>(
  name: string,
  config: ViewConfig<S, Slots, Actions, L>
): View<S, Slots, Actions, L> => buildView(name, config, [])

export const View = {
  make,
  action,
  live
} as const
