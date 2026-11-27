/**
 * Browser end-to-end: verify RBAC UI controls and server enforcement for
 * viewer (`alan@acme.test`), member (`grace@acme.test`), and admin (`ada@acme.test`).
 */
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ACME, dialog, open, save, signIn, startServer, total } from "./helpers.ts"

const MEMBER = "grace@acme.test"
const VIEWER = "alan@acme.test"

let server: ChildProcess
let browser: Browser
let base: string
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "effect-datastar-rbac-"))
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

describe("RBAC browser E2E", () => {
  it("viewer sees read-only UI across lists, detail, and embedded views, and API rejects writes with 403", async () => {
    const context = await signIn(browser, base, VIEWER)
    const page = await open(context, `${base}/users`)

    await expect.poll(() => page.locator("#account-role").innerText()).toBe("viewer")
    expect(await page.getByRole("button", { name: "New user" }).count()).toBe(0)
    expect(await page.getByRole("button", { name: "Edit" }).count()).toBe(0)
    expect(await page.getByRole("button", { name: "Delete" }).count()).toBe(0)
    expect(await page.locator(`input[type="checkbox"]`).count()).toBe(0)

    // Detail page and embedded Members table on a team page are also read-only
    await page.goto(`${base}/teams/1`)
    await page.locator("tbody tr").first().waitFor()
    expect(await page.getByRole("button", { name: "Edit" }).count()).toBe(0)
    expect(await page.getByRole("button", { name: "Delete" }).count()).toBe(0)
    expect(await page.getByRole("button", { name: "New user" }).count()).toBe(0)
    expect(await page.locator(`input[type="checkbox"]`).count()).toBe(0)

    // Direct API call from the viewer's authenticated session is rejected with 403
    const apiRes = await context.request.post(`${base}/api/users`, {
      data: {
        name: "Nope",
        email: "nope@example.com",
        role: "member",
        teamId: 1,
        active: true,
        startDate: null,
        tags: []
      }
    })
    expect(apiRes.status()).toBe(403)

    expect(page.errors).toEqual([])
    await context.close()
  })

  it("member can create and edit users, cannot delete/bulk users, and sees read-only teams and tags", async () => {
    const context = await signIn(browser, base, MEMBER)
    const page = await open(context, `${base}/users`)

    await expect.poll(() => page.locator("#account-role").innerText()).toBe("member")
    await expect.poll(() => total(page).innerText()).toBe("52 total")

    // Users list: New user & Edit present, Delete & bulk checkboxes hidden
    expect(await page.getByRole("button", { name: "New user" }).count()).toBe(1)
    expect(await page.getByRole("button", { name: "Edit" }).count()).toBeGreaterThan(0)
    expect(await page.getByRole("button", { name: "Delete" }).count()).toBe(0)
    expect(await page.locator(`table input[type="checkbox"]`).count()).toBe(0)

    // Create a user via dialog
    await page.getByRole("button", { name: "New user" }).click()
    await dialog(page).locator(`input[id$="-field-name"]`).fill("Member E2E User")
    await dialog(page).locator("input[type=email]").fill("member.e2e@example.com")
    await save(page)
    await expect.poll(() => total(page).innerText()).toBe("53 total")
    await expect.poll(() => page.locator("tbody").innerText()).toContain("Member E2E User")

    // Edit the created user
    await page.locator("tbody tr", { hasText: "Member E2E User" }).getByRole("button", { name: "Edit" }).click()
    await dialog(page).locator(`input[id$="-field-name"]`).fill("Member E2E Renamed")
    await save(page)
    await expect.poll(() => page.locator("tbody").innerText()).toContain("Member E2E Renamed")

    // Teams is read-only for member
    await page.goto(`${base}/teams`)
    await page.locator("tbody tr").first().waitFor()
    expect(await page.getByRole("button", { name: "New team" }).count()).toBe(0)
    expect(await page.getByRole("button", { name: "Edit" }).count()).toBe(0)
    expect(await page.getByRole("button", { name: "Delete" }).count()).toBe(0)
    expect(await page.locator(`input[type="checkbox"]`).count()).toBe(0)

    // Tags is read-only for member
    await page.goto(`${base}/tags`)
    await page.locator("tbody tr").first().waitFor()
    expect(await page.getByRole("button", { name: "New tag" }).count()).toBe(0)
    expect(await page.getByRole("button", { name: "Edit" }).count()).toBe(0)
    expect(await page.getByRole("button", { name: "Delete" }).count()).toBe(0)

    // Team detail: no team Edit/Delete, but embedded Members allows New user & Edit (no Delete/bulk)
    await page.goto(`${base}/teams/1`)
    await page.locator("tbody tr").first().waitFor()
    expect(await page.locator("#teams-record").getByRole("button", { name: "Edit" }).count()).toBe(0)
    expect(await page.locator("#teams-record").getByRole("button", { name: "Delete" }).count()).toBe(0)
    expect(await page.locator("#members-section").getByRole("button", { name: "New user" }).count()).toBe(1)
    expect(await page.locator("#members-section").getByRole("button", { name: "Edit" }).count()).toBeGreaterThan(0)
    expect(await page.locator("#members-section").getByRole("button", { name: "Delete" }).count()).toBe(0)
    expect(await page.locator(`#members-section table input[type="checkbox"]`).count()).toBe(0)

    expect(page.errors).toEqual([])
    await context.close()
  })

  it("admin sees full controls on users, teams, and tags", async () => {
    const context = await signIn(browser, base, ACME)
    const page = await open(context, `${base}/users`)

    await expect.poll(() => page.locator("#account-role").innerText()).toBe("admin")
    expect(await page.getByRole("button", { name: "New user" }).count()).toBe(1)
    expect(await page.getByRole("button", { name: "Edit" }).count()).toBeGreaterThan(0)
    expect(await page.getByRole("button", { name: "Delete" }).count()).toBeGreaterThan(0)
    expect(await page.locator(`input[type="checkbox"]`).count()).toBeGreaterThan(0)

    await page.goto(`${base}/teams`)
    await page.locator("tbody tr").first().waitFor()
    expect(await page.getByRole("button", { name: "New team" }).count()).toBe(1)
    expect(await page.getByRole("button", { name: "Edit" }).count()).toBeGreaterThan(0)
    expect(await page.getByRole("button", { name: "Delete" }).count()).toBeGreaterThan(0)

    expect(page.errors).toEqual([])
    await context.close()
  })
})
