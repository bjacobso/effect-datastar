/**
 * A Datastar endpoint = route + typed client action.
 *
 *   const remove = Endpoint.make("DELETE", "/users/:id", handler)
 *   remove.route                  // HttpRouter.Route, register with HttpRouter.addAll
 *   remove.call({ id: 3 })        // "@delete('/users/3')"  (for data-on:click etc.)
 *
 * Path params are typed from the path literal, and `include` restricts which
 * signals the browser sends (checked against the signals schema).
 */
import type { Effect, Stream } from "effect"
import { HttpRouter } from "effect/http"
import { includeRegex, type Expr, type SignalPath } from "./Attrs.ts"
import * as Datastar from "./Datastar.ts"

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/** A client-side expression used as a path param, e.g. `Endpoint.js("$users.draft.id")`. */
export class Js {
  constructor(readonly expr: Expr) {}
}
export const js = (expr: Expr) => new Js(expr)

type Param = string | number | Js

export type ParamsOf<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? { readonly [K in Name]: Param } & ParamsOf<`/${Rest}`>
  : P extends `${string}:${infer Name}` ? { readonly [K in Name]: Param }
  : {}

export interface CallOptions {
  /** Only send signals under these paths. Defaults to the endpoint's `include`. */
  readonly include?: ReadonlyArray<SignalPath> | undefined
  /** Keep the request open while the tab is hidden (long-lived views). */
  readonly openWhenHidden?: boolean | undefined
}

export interface Endpoint<P extends string, R> {
  readonly method: Method
  readonly path: P
  readonly route: HttpRouter.Route<never, R>
  readonly call: {} extends ParamsOf<P> ? (params?: ParamsOf<P>, options?: CallOptions) => Expr
    : (params: ParamsOf<P>, options?: CallOptions) => Expr
}

export const make = <const P extends HttpRouter.PathInput, R>(
  method: Method,
  path: P,
  handler: Effect.Effect<Datastar.Events, never, R> | Stream.Stream<Datastar.Events, never, R>,
  options?: { readonly include?: ReadonlyArray<SignalPath> }
): Endpoint<P, Exclude<R, HttpRouter.Provided>> => {
  const call = (params?: Record<string, Param>, callOptions?: CallOptions): Expr => {
    const url = path.replace(/:(\w+)/g, (_, name: string) => {
      const value = params?.[name]
      return value instanceof Js ? `' + encodeURIComponent(${value.expr}) + '` : encodeURIComponent(String(value ?? ""))
    })
    const include = callOptions?.include ?? options?.include
    const opts: Array<string> = []
    if (include) opts.push(`filterSignals: {include: ${includeRegex(include)}}`)
    if (callOptions?.openWhenHidden) opts.push(`openWhenHidden: true`)
    const args = opts.length > 0 ? `, {${opts.join(", ")}}` : ""
    return `@${method.toLowerCase()}('${url}'${args})`
  }
  return {
    method,
    path,
    route: HttpRouter.route(method, path, Datastar.respond(handler)),
    call: call as any
  }
}
