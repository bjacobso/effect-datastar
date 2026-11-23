/**
 * Session middleware: resolve the session cookie and provide `CurrentUser`
 * and `CurrentOrg` to the handlers behind it.
 *
 * - `RequireSession` is an `HttpRouter` middleware for the HTML routes. Without
 *   a valid session a page request is redirected to `/login?next=<path>`, and a
 *   Datastar request (SSE stream or action, `datastar-request: true`) gets an
 *   SSE response with a redirect event, which Datastar runs.
 *
 *     Resources.routes.pipe(Layer.provide(RequireSession.layer))   // removes CurrentUser | CurrentOrg from the requirements
 *
 * - `Authentication` is an `HttpApiMiddleware` for the JSON API: the same
 *   cookie, declared as an API key security scheme (so it is in the OpenAPI
 *   document), and a 401 `Unauthorized` without a valid session.
 *
 *     HttpApi.make("app").add(...).middleware(Authentication)
 */
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import { COOKIE, CurrentOrg, CurrentUser, type Session, Sessions } from "./Auth.ts"

/** Where to go after signing in: a same-origin path, else `fallback`. */
export const safeNext = (next: string | null | undefined, fallback = "/users") =>
  next !== null && next !== undefined && /^\/(?![/\\])/.test(next) && !/[\r\n]/.test(next) ? next : fallback

/** The sign-in page for a request: `/login?next=<the request's path and query>`. */
const loginUrl = (request: HttpServerRequest.HttpServerRequest) => {
  const url = new URL(request.url, "http://localhost")
  const next = url.pathname + url.search
  return next === "/" ? "/login" : `/login?${new URLSearchParams({ next }).toString()}`
}

const provideSession = <A, E, R>(effect: Effect.Effect<A, E, R>, session: Session) =>
  effect.pipe(
    Effect.provideService(CurrentUser, session.user),
    Effect.provideService(CurrentOrg, session.org)
  )

/** Unauthenticated: a redirect event for Datastar requests, a 302 to the sign-in page otherwise. */
const unauthenticated = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["datastar-request"] === "true"
    ? Datastar.respond(Effect.succeed(Datastar.redirect("/login")))
    : Effect.succeed(HttpServerResponse.redirect(loginUrl(request)))

/** Route middleware for the HTML routes. Provides `CurrentUser` and `CurrentOrg`. */
export const RequireSession = HttpRouter.middleware<{ provides: CurrentUser | CurrentOrg }>()(
  Effect.gen(function*() {
    const sessions = yield* Sessions
    return (httpEffect) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const session = yield* sessions.resolve(request.cookies[COOKIE])
        return yield* Option.match(session, {
          onNone: () => unauthenticated(request),
          onSome: (s) => provideSession(httpEffect, s)
        })
      })
  })
)

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------

/** 401: no valid session. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.String
}, { httpApiStatus: 401 }) {}

export class Authentication extends HttpApiMiddleware.Service<Authentication, {
  provides: CurrentUser | CurrentOrg
  requires: never
}>()("effect-datastar/auth/Authentication", {
  security: { session: HttpApiSecurity.apiKey({ key: COOKIE, in: "cookie" }) },
  error: Unauthorized
}) {}

/** Provides `Authentication`: resolves the session cookie, or fails with `Unauthorized`. */
export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function*() {
    const sessions = yield* Sessions
    return Authentication.of({
      session: (httpEffect, { credential }) =>
        Effect.gen(function*() {
          const session = yield* sessions.resolve(Redacted.value(credential))
          if (Option.isNone(session)) return yield* new Unauthorized({ message: "Sign in first" })
          return yield* provideSession(httpEffect, session.value)
        })
    })
  })
)
