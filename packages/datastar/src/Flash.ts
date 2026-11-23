/**
 * Flash messages: a toast that survives a redirect.
 *
 * `Datastar.redirect` navigates with `location.assign`, so a toast sent with it
 * would be gone with the old page. `redirect(url, flash)` instead stores the
 * message in a short-lived cookie (10 s, path `/`) right before navigating, and
 * the page it lands on reads it with `take` and clears it with `clear`:
 *
 *   // a handler
 *   Flash.redirect("/teams", { message: "Deleted", kind: "ok" })
 *
 *   // the page
 *   const flash = yield* Flash.take            // Option<Flash>
 *   return Flash.clear(response)               // Set-Cookie: flash=; Max-Age=0
 *
 * A cookie rather than a query param: the URL stays clean (nothing to strip, no
 * toast again on reload or when the link is shared), and a link can't make the
 * page say something.
 */
import { Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Datastar from "./Datastar.ts"

export const COOKIE = "flash"

export const Flash = Schema.Struct({
  message: Schema.String.check(Schema.isMaxLength(200)),
  kind: Schema.Literals(["ok", "error"])
})
export type Flash = typeof Flash.Type

const FlashJson = Schema.fromJsonString(Flash)
const encode = Schema.encodeSync(FlashJson)
const decode = Schema.decodeUnknownOption(FlashJson)

/** Navigate to `url` (same origin) and show `flash` there. */
export const redirect = (url: string, flash: Flash): Datastar.DatastarEvent =>
  Datastar.executeScript(
    `document.cookie = ${JSON.stringify(`${COOKIE}=${encodeURIComponent(encode(flash))}; path=/; max-age=10; samesite=strict`)}; ` +
      `window.location.assign(${JSON.stringify(url)})`
  )

const safeDecodeURIComponent = (raw: string) => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** The request's flash message, if it carries a valid one. */
export const take: Effect.Effect<Option.Option<Flash>, never, HttpServerRequest.HttpServerRequest> = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => {
    const raw = request.cookies[COOKIE]
    if (raw === undefined || raw === "") return Option.none()
    // Depending on the parser the value may still be URI-encoded.
    return Option.orElse(decode(raw), () => decode(safeDecodeURIComponent(raw)))
  }
)

/** Expire the flash cookie, so the message shows once. */
export const clear = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.expireCookieUnsafe(response, COOKIE, { path: "/" })
