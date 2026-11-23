/**
 * Sign-in, sessions and what happens without one: pages redirect to /login,
 * Datastar requests (streams and actions) get a redirect event, the JSON API
 * a 401. Seeded demo accounts: ada@acme.test, grace@acme.test (Acme) and
 * linus@globex.test (Globex), password "demo-password".
 */
import { describe, expect, it } from "vitest"
import { ACME, DEMO_PASSWORD, decode, type Event, GLOBEX, makeApp, signIn, userDraft, usersQuery, withCookie } from "./support.ts"

const app = makeApp()

const toLogin = [{
  type: "patch-elements",
  selector: "body",
  mode: "append",
  elements: `<script data-effect="el.remove()">window.location.assign("/login")</script>`
}]
const signals = (events: Array<Event>) => events.flatMap((e) => (e.type === "patch-signals" ? [e.signals] : []))
const login = (email: string, password: string, next = "/users") =>
  app.anonymous.action("POST", "/login", { login: { email, password, next, error: "" } })
const total = (html: string) => Number(/(\d+) total/.exec(html)?.[1])

describe("without a session", () => {
  it.each([
    ["/users", "/login?next=%2Fusers"],
    ["/teams/2?x=1", "/login?next=%2Fteams%2F2%3Fx%3D1"],
    ["/", "/login"]
  ])("a page request (%s) redirects to the sign-in page", async (path, location) => {
    const response = await app.anonymous.handler(new Request(`http://test${path}`))
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(location)
  })

  it("a live view (SSE) gets a redirect event and ends", async () => {
    const { events, response } = await app.anonymous.action("GET", "/users/view", usersQuery())
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(events).toEqual(toLogin)
  })

  it("an action gets a redirect event and changes nothing", async () => {
    const created = await app.anonymous.action("POST", "/users", userDraft({ name: "Sneaky", email: "sneaky@example.com" }))
    expect(created.events).toEqual(toLogin)
    expect((await app.anonymous.action("DELETE", "/users/87")).events).toEqual(toLogin)
    expect((await app.anonymous.action("GET", "/users/87/edit")).events).toEqual(toLogin)
    expect(total(await app.page("/users?name=Sneaky"))).toBe(0)
    expect(total(await app.page("/users"))).toBe(52)
  })

  it.each([
    ["GET", "/api/users"],
    ["GET", "/api/users/87"],
    ["POST", "/api/users"],
    ["PUT", "/api/teams/1"],
    ["DELETE", "/api/users/87"]
  ])("the JSON API answers 401 (%s %s)", async (method, path) => {
    const response = await app.anonymous.handler(
      new Request(`http://test${path}`, {
        method,
        ...(method === "POST" || method === "PUT"
          ? { body: JSON.stringify({ name: "x" }), headers: { "content-type": "application/json" } }
          : {})
      })
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ _tag: "Unauthorized", message: "Sign in first" })
  })

  it("a made-up or stale session cookie is no session", async () => {
    const forged = withCookie(new Request("http://test/users"), "not-a-real-token")
    expect((await app.anonymous.handler(forged)).status).toBe(302)
    const api = withCookie(new Request("http://test/api/users"), "not-a-real-token")
    expect((await app.anonymous.handler(api)).status).toBe(401)
  })

  it("the OpenAPI document declares the cookie and the 401", async () => {
    const response = await app.anonymous.handler(new Request("http://test/api/openapi.json"))
    const spec = await response.json()
    expect(spec.components.securitySchemes.session).toMatchObject({ type: "apiKey", in: "cookie", name: "session" })
    expect(Object.keys(spec.paths["/api/users"].get.responses)).toContain("401")
  })
})

describe("sign in", () => {
  it("renders the form with the demo accounts", async () => {
    const html = decode(await app.anonymous.page("/login?next=/teams"))
    expect(html).toContain(`data-on:submit__prevent="@post('/login')"`)
    expect(html).toContain(`"next":"/teams"`)
    expect(html).toContain(ACME)
    // No account in the header, no navigation.
    expect(html).not.toContain(`id="account"`)
  })

  it("sets an HttpOnly, SameSite=Lax session cookie and redirects to `next`", async () => {
    const { events, response } = await login(ACME, DEMO_PASSWORD, "/teams/2")
    const cookie = response.headers.get("set-cookie") ?? ""
    expect(cookie).toMatch(/^session=[A-Za-z0-9_-]{43};/)
    expect(cookie).toMatch(/;\s*HttpOnly/i)
    expect(cookie).toMatch(/;\s*SameSite=Lax/i)
    expect(cookie).toMatch(/;\s*Path=\//i)
    expect(cookie).toMatch(/;\s*Max-Age=604800/i)
    expect(events).toEqual([{ ...toLogin[0], elements: toLogin[0]!.elements.replace("/login", "/teams/2") }])
  })

  it("rejects a wrong password and an unknown email alike, without a cookie", async () => {
    for (const [email, password] of [[ACME, "wrong"], ["nobody@acme.test", DEMO_PASSWORD], [ACME, ""]] as const) {
      const { events, response } = await login(email, password)
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(signals(events)).toEqual([{ login: { error: "Wrong email or password", password: "" } }])
    }
  })

  it("only redirects to a path on this site", async () => {
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const { events } = await login(ACME, DEMO_PASSWORD, next)
      expect(events).toEqual([{ ...toLogin[0], elements: toLogin[0]!.elements.replace("/login", "/users") }])
    }
  })

  it("matches the email case-insensitively", async () => {
    const { response } = await login("ADA@Acme.Test", DEMO_PASSWORD)
    expect(response.headers.get("set-cookie")).toMatch(/^session=/)
  })

  it("sends a signed-in visitor of /login on", async () => {
    const response = await app.handler(new Request("http://test/login?next=/teams"))
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/teams")
  })

  it("shows the account and its organization in the header, with sign out", async () => {
    const acme = decode(await app.page("/users"))
    expect(acme).toMatch(/id="account-name"[^>]*>Ada Lovelace</)
    expect(acme).toMatch(/id="account-org"[^>]*>Acme</)
    expect(acme).toContain(`data-on:click="@post('/logout')"`)
    const globex = decode(await app.as(GLOBEX).page("/users"))
    expect(globex).toMatch(/id="account-org"[^>]*>Globex</)
  })
})

describe("sign out", () => {
  it("ends the session (the old cookie no longer works) and expires the cookie", async () => {
    const token = await signIn(app.anonymous.handler, ACME, DEMO_PASSWORD)
    const before = await app.anonymous.handler(withCookie(new Request("http://test/users"), token))
    expect(before.status).toBe(200)

    const out = await app.anonymous.handler(
      withCookie(new Request("http://test/logout", { method: "POST", headers: { "datastar-request": "true" } }), token)
    )
    expect(out.headers.get("set-cookie")).toMatch(/^session=;.*Max-Age=0/i)
    expect(await out.text()).toContain(`window.location.assign("/login")`)

    const after = await app.anonymous.handler(withCookie(new Request("http://test/users"), token))
    expect(after.status).toBe(302)
    const api = await app.anonymous.handler(withCookie(new Request("http://test/api/users"), token))
    expect(api.status).toBe(401)
  })

  it("leaves other sessions of the same account alone", async () => {
    const a = await signIn(app.anonymous.handler, ACME, DEMO_PASSWORD)
    const b = await signIn(app.anonymous.handler, ACME, DEMO_PASSWORD)
    expect(a).not.toBe(b)
    await app.anonymous.handler(withCookie(new Request("http://test/logout", { method: "POST" }), a))
    expect((await app.anonymous.handler(withCookie(new Request("http://test/users"), b))).status).toBe(200)
  })
})
