/** @jsxImportSource @effect-datastar/ui */
/**
 * Sign-in and sign-out (public routes, not behind `RequireSession`):
 *
 *   GET  /login    the sign-in form (or straight on, with a valid session)
 *   POST /login    Datastar action: on success sets the session cookie and
 *                  redirects (`Datastar.redirect`) to `next`; otherwise shows an error
 *   POST /logout   deletes the session, expires the cookie, redirects to /login
 */
import * as stylex from "@stylexjs/stylex"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { COOKIE, Sessions } from "../auth/Auth.ts"
import { safeNext } from "../auth/Middleware.ts"
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import { Action, Signals } from "@effect-datastar/datastar/Expr.ts"
import { document } from "@effect-datastar/ui/Html.ts"
import { Button } from "@effect-datastar/ui/Button.tsx"
import { Card } from "@effect-datastar/ui/display.tsx"
import { styles as form } from "@effect-datastar/ui/form.tsx"
import { shared } from "@effect-datastar/ui/shared.ts"
import { color, font, space } from "@effect-datastar/ui/theme/tokens.stylex.ts"
import { demoAccounts } from "./Db.ts"
import { Shell } from "./Layout.tsx"

const LoginSignals = Schema.Struct({
  login: Schema.Struct({ email: Schema.String, password: Schema.String, next: Schema.String, error: Schema.String })
})
const $ = Signals.from(LoginSignals)
const submitLogin = Action.raw("@post('/login')")

const LoginPage = (props: { readonly next: string }) => (
  <main {...stylex.props(styles.main)}>
    <Card title="Sign in" description="Use your organization account.">
      <form
        id="login-form"
        $signals={$.init({ login: { email: "", password: "", next: props.next, error: "" } })}
        $on={{ submit: { run: submitLogin, prevent: true } }}
        {...stylex.props(styles.form)}
      >
        <label {...stylex.props(form.field)}>
          <span {...stylex.props(form.label)}>Email</span>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            $bind={$.login.email}
            {...stylex.props(shared.control)}
          />
        </label>
        <label {...stylex.props(form.field)}>
          <span {...stylex.props(form.label)}>Password</span>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            $bind={$.login.password}
            {...stylex.props(shared.control)}
          />
        </label>
        <p
          id="login-error"
          role="alert"
          $show={$.login.error.nonEmpty()}
          $text={$.login.error}
          {...stylex.props(form.error)}
        />
        <Button variant="primary" type="submit" block>Sign in</Button>
      </form>
    </Card>
    <p {...stylex.props(styles.hint)}>
      {`Demo accounts (password "${demoAccounts[0].password}"): `}
      {demoAccounts.map((a) => `${a.email} (${a.org}, ${a.role})`).join(", ")}
    </p>
  </main>
)

const page = HttpRouter.route(
  "GET",
  "/login",
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const sessions = yield* Sessions
    const next = safeNext(new URL(request.url, "http://localhost").searchParams.get("next"))
    if (Option.isSome(yield* sessions.resolve(request.cookies[COOKIE]))) return HttpServerResponse.redirect(next)
    return HttpServerResponse.html(document(
      <Shell title="Sign in" active="/login">
        <LoginPage next={next} />
      </Shell>
    ))
  })
)

const failed = (error: string) => Datastar.patchSignals({ login: { error, password: "" } })

const signIn = HttpRouter.route(
  "POST",
  "/login",
  Effect.gen(function*() {
    const sessions = yield* Sessions
    const form = yield* Datastar.signals(LoginSignals).pipe(Effect.option)
    if (Option.isNone(form)) return yield* Datastar.respond(Effect.succeed(failed("Enter your email and password")))
    const { email, next, password } = form.value.login
    const signedIn = yield* sessions.signIn(email, password)
    if (Option.isNone(signedIn)) return yield* Datastar.respond(Effect.succeed(failed("Wrong email or password")))
    const response = yield* Datastar.respond(Effect.succeed(Datastar.redirect(safeNext(next))))
    return HttpServerResponse.setCookieUnsafe(response, COOKIE, signedIn.value.token, sessions.cookie)
  })
)

const signOut = HttpRouter.route(
  "POST",
  "/logout",
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const sessions = yield* Sessions
    yield* sessions.signOut(request.cookies[COOKIE])
    const response = yield* Datastar.respond(Effect.succeed(Datastar.redirect("/login")))
    return HttpServerResponse.expireCookieUnsafe(response, COOKIE, { path: "/" })
  })
)

/** The public sign-in routes. Requires `Sessions`. */
export const LoginRoutes = HttpRouter.addAll([page, signIn, signOut]) as Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", Sessions>>

const styles = stylex.create({
  main: {
    display: "flex",
    flexDirection: "column",
    gap: space["--dw-space-4"],
    maxWidth: "400px",
    marginInline: "auto",
    marginTop: space["--dw-space-10"]
  },
  form: { display: "flex", flexDirection: "column", gap: space["--dw-space-4"] },
  hint: { fontSize: font["--dw-text-sm"], color: color["--dw-text-muted"] }
})
