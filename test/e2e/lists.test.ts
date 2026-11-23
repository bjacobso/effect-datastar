/**
 * Browser end-to-end for list pages: bulk actions on selected rows, and Back /
 * Forward through list states (filters, sort and page in the history).
 */
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium, type Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { dialog, firstColumn, open as openTab, pageText, save, sortBy, startServer, total } from "./helpers.ts"

let server: ChildProcess
let browser: Browser
let base: string
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "effect-datastar-lists-"))
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

const open = (path: string) => openTab(browser, base + path)
const bar = (page: Page) => page.locator("[role=toolbar][aria-label='Bulk actions']").first()
/** A row by `#id`, or by text. */
const row = (page: Page, key: string) => key.startsWith("#") ? page.locator(key) : page.locator("tbody tr", { hasText: key })
const rowCheck = (page: Page, key: string) => row(page, key).locator("input[type=checkbox]")
const teamOf = (page: Page, key: string) => row(page, key).locator("td:nth-child(5)")
const toast = (page: Page) => page.locator("#toast")
const search = (page: Page) => new URL(page.url()).search

describe("bulk actions", () => {
  it("selects rows, sets their team, and clears the selection", async () => {
    const page = await open("/users?name=grace&sort=name&dir=asc")
    await expect.poll(() => total(page).innerText()).toBe("8 total")
    expect(await bar(page).isVisible()).toBe(false)

    // By id: names repeat in the seed.
    const [a, b] = (await page.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => `#${tr.id}`))) as [string, string]
    await rowCheck(page, a).check()
    await rowCheck(page, b).check()
    await expect.poll(() => bar(page).isVisible()).toBe(true)
    expect(await bar(page).innerText()).toContain("2 selected")

    await bar(page).getByLabel("Set team").selectOption({ label: "Design" })
    await expect.poll(() => toast(page).innerText()).toBe("2 updated")
    await expect.poll(() => teamOf(page, a).innerText()).toBe("Design")
    expect(await teamOf(page, b).innerText()).toBe("Design")
    // Cleared: the bar hides and the boxes are unchecked.
    await expect.poll(() => bar(page).isVisible()).toBe(false)
    expect(await rowCheck(page, a).isChecked()).toBe(false)

    // And to no team.
    await rowCheck(page, a).check()
    await bar(page).getByLabel("Set team").selectOption({ label: "No team" })
    await expect.poll(() => teamOf(page, a).innerText()).toBe("—")

    expect(page.errors).toEqual([])
    await page.close()
  })

  it("selects all on the page, and drops ids that leave the page", async () => {
    const page = await open("/users?name=grace&sort=name&dir=asc")
    await expect.poll(() => total(page).innerText()).toBe("8 total")
    const all = page.getByLabel("Select all on this page")
    await all.check()
    await expect.poll(() => bar(page).innerText()).toContain("8 selected")
    expect(await page.locator("tbody input[type=checkbox]:checked").count()).toBe(8)

    // Narrow the filter: rows that are gone from the page leave the selection.
    await page.fill(`input[placeholder^="Search name"]`, "grace h")
    await expect.poll(async () => Number((await total(page).innerText()).split(" ")[0])).toBeLessThan(8)
    const left = await page.locator("tbody tr").count()
    await expect.poll(() => bar(page).innerText()).toContain(`${left} selected`)
    expect(await all.isChecked()).toBe(true)

    await all.uncheck()
    await expect.poll(() => bar(page).isVisible()).toBe(false)
    expect(page.errors).toEqual([])
    await page.close()
  })

  it("deletes the selected users", async () => {
    const page = await open("/users?sort=name&dir=asc")
    for (const name of ["Bulk One", "Bulk Two", "Bulk Three"]) {
      await page.getByRole("button", { name: "New user" }).click()
      await dialog(page).locator("input[type=text]").fill(name)
      await dialog(page).locator("input[type=email]").fill(`${name.replace(" ", ".").toLowerCase()}@example.com`)
      await save(page)
    }
    await page.fill(`input[placeholder^="Search name"]`, "bulk")
    await expect.poll(() => total(page).innerText()).toBe("3 total")

    await rowCheck(page, "Bulk One").check()
    await rowCheck(page, "Bulk Three").check()
    await bar(page).getByRole("button", { name: "Delete" }).click()
    await expect.poll(() => toast(page).innerText()).toBe("2 deleted")
    await expect.poll(() => firstColumn(page)).toEqual(["Bulk Two"])
    await expect.poll(() => bar(page).isVisible()).toBe(false)
    expect(page.errors).toEqual([])
    await page.close()
  })

  it("reports teams the database keeps, and keeps them selected", async () => {
    const page = await open("/teams")
    for (const name of ["Spare A", "Spare B"]) {
      await page.getByRole("button", { name: "New team" }).click()
      await dialog(page).locator("input[type=text]").fill(name)
      await save(page)
      await expect.poll(() => page.locator("tbody tr", { hasText: name }).count()).toBe(1)
    }
    await rowCheck(page, "Spare A").check()
    await rowCheck(page, "Spare B").check()
    await rowCheck(page, "Platform").check()
    await bar(page).getByRole("button", { name: "Delete" }).click()
    await expect.poll(() => toast(page).innerText()).toBe("2 deleted, 1 has members")
    await expect.poll(() => page.locator("tbody tr", { hasText: "Spare" }).count()).toBe(0)
    expect(await bar(page).innerText()).toContain("1 selected")
    expect(await rowCheck(page, "Platform").isChecked()).toBe(true)
    expect(page.errors).toEqual([])
    await page.close()
  })
})

describe("back and forward", () => {
  it("steps through filters, sort and page, and the table follows", async () => {
    const page = await open("/users")
    const name = page.locator(`input[placeholder^="Search name"]`)
    const team = page.locator("#users-filter-teamId")
    const teamText = () => team.evaluate((s: HTMLSelectElement) => s.selectedOptions[0]!.text)

    await team.selectOption({ label: "Design" })
    await expect.poll(() => search(page)).toBe("?teamId=3")
    const designTotal = await total(page).innerText()
    await sortBy(page, "Email")
    await expect.poll(() => search(page)).toBe("?teamId=3&sort=email&dir=asc")
    const sortedFirst = (await firstColumn(page))[0]
    await page.getByRole("button", { name: "Next page" }).click()
    await expect.poll(() => search(page)).toBe("?teamId=3&sort=email&dir=asc&page=2")

    // Typing is one entry, not one per keystroke (each pause re-queries and replaces it).
    const before = await page.evaluate(() => history.length)
    await name.pressSequentially("ada", { delay: 300 })
    await expect.poll(() => search(page)).toBe("?name=ada&teamId=3&sort=email&dir=asc")
    await name.blur()
    expect(await page.evaluate(() => history.length)).toBe(before + 1)

    await page.goBack()
    await expect.poll(() => search(page)).toBe("?teamId=3&sort=email&dir=asc&page=2")
    await expect.poll(() => name.inputValue()).toBe("")
    await expect.poll(() => pageText(page).innerText()).toMatch(/^Page 2 of/)

    await page.goBack()
    await expect.poll(() => pageText(page).innerText()).toMatch(/^Page 1 of/)
    expect((await firstColumn(page))[0]).toBe(sortedFirst)
    expect(await page.locator("th[aria-sort=ascending]").innerText()).toBe("Email")

    await page.goBack()
    await expect.poll(() => search(page)).toBe("?teamId=3")
    await expect.poll(() => page.locator("th[aria-sort=ascending]").count()).toBe(0)
    expect(await teamText()).toBe("Design")
    expect(await total(page).innerText()).toBe(designTotal)

    await page.goBack()
    await expect.poll(() => search(page)).toBe("")
    await expect.poll(() => teamText()).toBe("All")
    await expect.poll(() => total(page).innerText()).not.toBe(designTotal)

    await page.goForward()
    await expect.poll(() => teamText()).toBe("Design")
    await expect.poll(() => total(page).innerText()).toBe(designTotal)
    await page.goForward()
    await expect.poll(() => page.locator("th[aria-sort=ascending]").innerText()).toBe("Email")
    // Restoring a state doesn't push one: the forward entries are still there.
    await page.goForward()
    await page.goForward()
    await expect.poll(() => name.inputValue()).toBe("ada")
    await expect.poll(() => search(page)).toBe("?name=ada&teamId=3&sort=email&dir=asc")

    expect(page.errors).toEqual([])
    await page.close()
  })

  it("replaces a non-canonical URL instead of pushing", async () => {
    const page = await open("/users?page=99&role=root")
    await expect.poll(() => search(page)).toBe("?page=9")
    // Back leaves the page (to the tab's blank start): no entry for the URL it was opened with.
    await page.goBack()
    expect(page.url()).toBe("about:blank")
    await page.close()
  })
})
