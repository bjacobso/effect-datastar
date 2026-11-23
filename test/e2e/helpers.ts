/**
 * Shared browser-test helpers: start the built server, open tabs, and the selectors
 * for the server-rendered table and the React islands (dialog, team select).
 */
import { type ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import type { Browser, BrowserContext, Page } from "playwright"

export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

/** Start `node dist/server.js` (built by the global setup) on a free port. */
export const startServer = async (db: string): Promise<{ readonly url: string; readonly process: ChildProcess }> => {
  const port = await freePort()
  const server = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, PORT: String(port), DB: db },
    stdio: "pipe"
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 30_000)
    server.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Listening on")) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  return { url: `http://localhost:${port}`, process: server }
}

/** Demo accounts (seeded): Acme has teams Platform, Growth and Design and 52 users; Globex Infrastructure and Support, 35. */
export const ACME = "ada@acme.test"
export const GLOBEX = "linus@globex.test"
export const PASSWORD = "demo-password"

/** Fills in and submits the sign-in form on `page` (already on /login). */
export const submitSignIn = async (page: Page, email: string, password = PASSWORD) => {
  await page.fill("#login-email", email)
  await page.fill("#login-password", password)
  await page.getByRole("button", { name: "Sign in" }).click()
}

/**
 * A browser context signed in as `email`, through the sign-in form (its
 * tabs share the session cookie). Every server on `localhost` sees the
 * cookie: cookies don't depend on the port.
 */
export const signIn = async (browser: Browser, base: string, email: string = ACME): Promise<BrowserContext> => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${base}/login`)
  await submitSignIn(page, email)
  await page.waitForURL(/\/users$/)
  await page.close()
  return context
}

export type Tab = Page & { readonly errors: Array<string> }

/** A new tab on `url` (in a signed-in context), collecting page errors and console errors, accepting confirms. */
export const open = async (browser: Browser | BrowserContext, url: string): Promise<Tab> => {
  const page = await browser.newPage()
  const errors: Array<string> = []
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  page.on("dialog", (d) => d.accept())
  await page.goto(url)
  await page.locator("tbody tr").first().waitFor()
  return Object.assign(page, { errors })
}

export const total = (page: Page) => page.locator("[data-total]").first()
export const pageText = (page: Page) => page.locator("[data-page]").first()
export const firstColumn = (page: Page) => page.locator("tbody tr td:first-child").allInnerTexts()
export const sortBy = (page: Page, label: string) => page.locator("th button", { hasText: label }).click()

/** The create/edit dialog island while open (its host has `open` while the `dialog` signal is true). */
export const DIALOG = `ds-island[name="dialog"][open]`
export const dialog = (page: Page) => page.locator(DIALOG)

/**
 * Submits the open dialog and waits until it has closed: the server's `dialog: false` patch,
 * then ui-sdk's exit transition. While that runs the dialog is still modal, and a click on
 * the page behind it is swallowed (as for a real user clicking that fast).
 */
export const save = async (page: Page) => {
  await dialog(page).locator("button[type=submit]").click()
  await closed(page)
}

/** Waits until no dialog is shown (closed and finished its exit transition). */
export const closed = async (page: Page) => {
  await page.getByRole("dialog").waitFor({ state: "detached" })
}

/** The team select island in the open dialog: its ui-sdk trigger. */
export const teamTrigger = (page: Page) => dialog(page).locator(`[id$="-field-teamId"] [role=combobox]`)

/** Picks an option in the team select island. */
export const pickTeam = async (page: Page, label: string) => {
  await teamTrigger(page).click()
  await page.getByRole("listbox").getByRole("option", { name: label, exact: true }).click()
}

/** The labels offered by the team select island (opens and closes its popup). */
export const teamOptions = async (page: Page) => {
  await teamTrigger(page).click()
  const options = await page.getByRole("listbox").getByRole("option").allInnerTexts()
  await page.keyboard.press("Escape")
  return options
}
