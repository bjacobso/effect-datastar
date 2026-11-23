/**
 * Browser tests for the schema-derived widgets: the date picker, tags multi-select,
 * switch and textarea in the dialog, the date-range and has-tag filters, and tag chips
 * following a tag rename in another tab. Screenshots of the dialog go to
 * `test/e2e/screenshots/` (git-ignored).
 */
import type { ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium, type Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closed, dialog, firstColumn, open as openTab, save, startServer, total } from "./helpers.ts"

let server: ChildProcess
let browser: Browser
let base: string
let dir: string
const shots = join(import.meta.dirname, "screenshots")

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "effect-datastar-fields-"))
  mkdirSync(shots, { recursive: true })
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

const open = async (path: string) => {
  const page = await openTab(browser, base + path)
  await page.setViewportSize({ width: 1280, height: 900 })
  return page
}

/** This month's 15th, as the date picker's calendar opens on the current month. */
const fifteenth = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-15`
}

/** Opens a date picker island's calendar and clicks the 15th of the month shown. */
const pick15th = async (page: Page, host: string) => {
  await page.locator(`${host} button[aria-label="Open calendar"]`).click()
  await page.getByRole("gridcell", { name: /\b15, \d{4}$/ }).click()
  await page.getByRole("grid").waitFor({ state: "detached" })
}

/** Types into the tags combobox and picks the option. The popup stays open (multiple). */
const pickTag = async (page: Page, label: string) => {
  const input = dialog(page).locator(`[id$="-field-tags"] input[role=combobox]`)
  await input.fill(label.slice(0, 3))
  await page.getByRole("listbox").getByRole("option", { name: label }).click()
}

/** A screenshot once the dialog's enter transition has finished. */
const shot = async (page: Page, name: string) => {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"))
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(shots, name) })
}

const chipsOf = (page: Page, row: number) => page.locator("tbody tr").nth(row).locator("[data-chip]").allInnerTexts()

describe("dialog widgets", () => {
  it("picks a date and tags, toggles the switch, and the table shows them", async () => {
    const page = await open("/users")
    await page.getByRole("button", { name: "New user" }).click()
    await expect.poll(() => dialog(page).getByRole("dialog").isVisible()).toBe(true)
    // The role is a ui-sdk Select island now, like the team select.
    expect(await dialog(page).locator(`ds-island[name="select"][id="users-field-role"]`).count()).toBe(1)
    // A boolean is a switch: a native checkbox with role=switch (off in a blank draft).
    const active = dialog(page).getByRole("switch", { name: "Active" })
    expect(await active.isChecked()).toBe(false)
    await active.check()

    await dialog(page).locator(`input[id$="-field-name"]`).fill("Widget Person")
    await dialog(page).locator("input[type=email]").fill("widget@example.com")
    await pick15th(page, "#users-field-startDate")
    await expect.poll(() => dialog(page).locator("#users-field-startDate input").inputValue()).not.toBe("")
    await pickTag(page, "Mentor")
    await pickTag(page, "Remote")
    await dialog(page).locator("#users-dialog-title").click() // close the tags popup
    await shot(page, "dialog-new-user.png")
    await save(page)
    await expect.poll(() => page.locator("#toast").innerText()).toBe("Created Widget Person")

    await page.fill(`input[placeholder^="Search name"]`, "widget")
    await expect.poll(() => firstColumn(page)).toEqual(["Widget Person"])
    expect((await chipsOf(page, 0)).sort()).toEqual(["Mentor", "Remote"])
    expect(await page.locator("tbody tr").first().innerText()).toContain(fifteenth())

    // Edit: the dialog shows what was saved; remove a tag with its chip's button.
    await page.locator("tbody button", { hasText: "Edit" }).click()
    await expect.poll(() => dialog(page).count()).toBe(1)
    await expect.poll(() => dialog(page).locator(`[id$="-field-tags"] [aria-label^="Remove"]`).count()).toBe(2)
    expect(await dialog(page).getByRole("switch", { name: "Active" }).isChecked()).toBe(true)
    await shot(page, "dialog-edit-user.png")
    await dialog(page).getByRole("button", { name: "Remove Remote" }).click()
    await save(page)
    await expect.poll(() => chipsOf(page, 0)).toEqual(["Mentor"])
    expect(page.errors).toEqual([])
    await page.close()
  })

  it("edits a team's description in a textarea", async () => {
    const page = await open("/teams")
    await page.locator("tbody tr", { hasText: "Design" }).locator("button", { hasText: "Edit" }).click()
    await expect.poll(() => dialog(page).count()).toBe(1)
    const description = dialog(page).locator("textarea#teams-field-description")
    await description.fill("Makes things look good.\nAnd work well.")
    await shot(page, "dialog-edit-team.png")
    await save(page)
    await expect.poll(() => page.locator("tbody tr", { hasText: "Design" }).innerText()).toContain("Makes things look good.")
    expect(page.errors).toEqual([])
    await page.close()
  })

  it("creates a tag with a color input", async () => {
    const page = await open("/tags")
    expect(await total(page).innerText()).toBe("5 total")
    await page.getByRole("button", { name: "New tag" }).click()
    await dialog(page).locator(`input[id$="-field-name"]`).fill("Lead")
    await dialog(page).locator("input[type=color]").fill("#0d9488")
    await save(page)
    await expect.poll(() => total(page).innerText()).toBe("6 total")
    expect(await page.locator("tbody tr", { hasText: "Lead" }).innerText()).toContain("#0d9488")
    await page.close()
  })
})

describe("filters", () => {
  it("filters by a created-at range picked in the filter bar, kept in the URL", async () => {
    const page = await open("/users")
    expect(await total(page).innerText()).toBe("88 total")
    // Seeded users were created every 31 hours from 2026-01-01: this month's 15th onward is
    // only the ones created by the tests (today).
    await pick15th(page, "#users-filter-createdAtFrom")
    await expect.poll(() => new URL(page.url()).searchParams.get("createdAtFrom")).toBe(fifteenth())
    const filtered = Number((await total(page).innerText()).split(" ")[0])
    expect(filtered).toBeLessThan(88)

    // Reload: the range comes back from the URL, in the picker and the query.
    await page.reload()
    await expect.poll(() => total(page).innerText()).toBe(`${filtered} total`)
    await expect.poll(() => page.locator("#users-filter-createdAtFrom input").inputValue()).not.toBe("")

    const ranged = await open(`/users?createdAtFrom=2026-01-01&createdAtTo=2026-01-31&sort=createdAt&dir=asc`)
    // 2026-01-01T00:00 plus every 31 hours, through January 31: 24 users.
    await expect.poll(() => total(ranged).innerText()).toBe("24 total")
    expect(page.errors).toEqual([])
    await Promise.all([page.close(), ranged.close()])
  })

  it("filters by tag, and follows a tag rename in another tab", async () => {
    const users = await open("/users")
    await users.locator("#users-filter-tags").selectOption({ label: "Mentor" })
    await expect.poll(() => new URL(users.url()).searchParams.get("tags")).not.toBeNull()
    await expect.poll(async () => (await chipsOf(users, 0)).includes("Mentor")).toBe(true)

    const tags = await open("/tags")
    await tags.locator("tbody tr", { hasText: "Mentor" }).locator("button", { hasText: "Edit" }).click()
    await expect.poll(() => dialog(tags).count()).toBe(1)
    await dialog(tags).locator(`input[id$="-field-name"]`).fill("Coach")
    await dialog(tags).locator("input[type=color]").fill("#be123c")
    await save(tags)

    // The users tab re-renders its chips and keeps the filter, now labelled Coach.
    await expect.poll(async () => (await chipsOf(users, 0)).includes("Coach")).toBe(true)
    expect(await users.locator("#users-filter-tags").evaluate((s: HTMLSelectElement) => s.selectedOptions[0]!.text)).toBe("Coach")
    expect(await users.locator("tbody [data-chip]", { hasText: "Coach" }).first().getAttribute("style")).toContain("#be123c")

    // Deleting the tag removes it from every user: the filtered table empties.
    await tags.locator("tbody tr", { hasText: "Coach" }).locator("button", { hasText: "Delete" }).click()
    await expect.poll(() => total(users).innerText()).toBe("0 total")
    expect([...users.errors, ...tags.errors]).toEqual([])
    await closed(tags)
    await Promise.all([users.close(), tags.close()])
  })
})
