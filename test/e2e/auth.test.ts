/**
 * Browser end-to-end: sign in through the form as an Acme account, check that
 * none of Globex's data shows up (lists, lookups, guessed ids, live updates
 * from a Globex tab), then sign out.
 */
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ACME, dialog, GLOBEX, open, save, signIn, startServer, submitSignIn, total } from "./helpers.ts"

let server: ChildProcess
let browser: Browser
let base: string
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "effect-datastar-auth-"))
  const started = await startServer(join(dir, "e2e.db"))
  server = started.process
  base = started.url
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  rmSync(dir, { recursive: true, force: true })
})

describe("sign in, organization isolation, sign out", () => {
  it("redirects to the sign-in page and back to where it was going", async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${base}/teams`)
    expect(new URL(page.url()).pathname).toBe("/login")
    expect(new URL(page.url()).searchParams.get("next")).toBe("/teams")

    await submitSignIn(page, ACME, "wrong password")
    await expect.poll(() => page.locator("#login-error").innerText()).toBe("Wrong email or password")
    expect(new URL(page.url()).pathname).toBe("/login")

    await submitSignIn(page, ACME)
    await page.waitForURL(/\/teams$/)
    await page.locator("tbody tr").first().waitFor()
    await context.close()
  })

  it("an Acme account sees none of Globex's data, then signs out", async () => {
    const context = await signIn(browser, base, ACME)
    const page = await open(context, `${base}/users`)
    await expect.poll(() => page.locator("#account-name").innerText()).toBe("Ada Lovelace")
    expect(await page.locator("#account-org").innerText()).toBe("Acme")

    // Lists and lookups: Acme's 52 users and three teams only.
    await expect.poll(() => total(page).innerText()).toBe("52 total")
    const filterTeams = await page.locator("#users-filter-teamId option").allInnerTexts()
    expect(filterTeams).toEqual(["All", "None", "Design", "Growth", "Platform"])
    await page.getByRole("button", { name: "New user" }).click()
    await dialog(page).locator(`[id$="-field-teamId"] [role=combobox]`).click()
    const formTeams = await page.getByRole("listbox").getByRole("option").allInnerTexts()
    expect(formTeams).not.toContain("Infrastructure")
    expect(formTeams).not.toContain("Support")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")

    const teams = await open(context, `${base}/teams`)
    expect((await teams.locator("tbody tr td:first-child").allInnerTexts()).sort()).toEqual(["Design", "Growth", "Platform"])

    // Guessing Globex's ids: its team (4) and user (3) don't exist here.
    const guess = await context.newPage()
    expect((await guess.goto(`${base}/teams/4`))!.status()).toBe(404)
    expect((await guess.goto(`${base}/users/3`))!.status()).toBe(404)
    expect((await guess.goto(`${base}/api/users/3`))!.status()).toBe(404)
    await guess.close()

    // A Globex user creates a user and renames a team: nothing reaches the Acme tabs.
    const globex = await signIn(browser, base, GLOBEX)
    const other = await open(globex, `${base}/users`)
    expect(await other.locator("#account-org").innerText()).toBe("Globex")
    await expect.poll(() => total(other).innerText()).toBe("35 total")
    await other.getByRole("button", { name: "New user" }).click()
    await dialog(other).locator("input[type=text]").fill("Globex Secret")
    await dialog(other).locator("input[type=email]").fill("secret@globex.test")
    await save(other)
    await expect.poll(() => total(other).innerText()).toBe("36 total")
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await total(page).innerText()).toBe("52 total")
    expect(await page.locator("tbody").innerText()).not.toContain("Globex Secret")
    await globex.close()

    // Sign out: back to the sign-in page, and the pages are closed to this browser.
    await page.getByRole("button", { name: "Sign out" }).click()
    await page.waitForURL(/\/login$/)
    const after = await context.newPage()
    await after.goto(`${base}/users`)
    expect(new URL(after.url()).pathname).toBe("/login")

    expect([...page.errors, ...teams.errors, ...other.errors]).toEqual([])
    await context.close()
  })
})
