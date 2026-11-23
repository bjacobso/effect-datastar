/**
 * Browser end-to-end: the real (built) server on a temp SQLite file + headless Chromium,
 * two tabs to check live updates across pages.
 */
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, type BrowserContext, chromium, type Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  closed,
  dialog,
  firstColumn,
  open as openTab,
  pageText,
  pickTeam,
  GLOBEX,
  save,
  signIn,
  sortBy,
  startServer,
  teamOptions,
  teamTrigger,
  total
} from "./helpers.ts"

let server: ChildProcess
let browser: Browser
let base: string
let dir: string
/** Signed in as ada@acme.test (Acme: Platform, Growth, Design, 52 users) and linus@globex.test (Globex). */
let acme: BrowserContext
let globex: BrowserContext

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "effect-datastar-"))
  const started = await startServer(join(dir, "e2e.db"))
  server = started.process
  base = started.url
  browser = await chromium.launch()
  acme = await signIn(browser, base)
  globex = await signIn(browser, base, GLOBEX)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  rmSync(dir, { recursive: true, force: true })
})

const open = (path: string) => openTab(acme, base + path)
const openAsGlobex = (path: string) => openTab(globex, base + path)
const teamColumn = (page: Page) => page.locator("tbody tr td:nth-child(5)").first()
const filterText = (page: Page, id: string) =>
  page.locator(id).evaluate((s: HTMLSelectElement) => s.selectedOptions[0]!.text)

describe("users page", () => {
  it("sorts, pages, filters and changes page size", async () => {
    const page = await open("/users")
    await expect.poll(() => total(page).innerText()).toBe("52 total")

    await sortBy(page, "Name")
    await expect.poll(async () => (await firstColumn(page))[0]).toBe("Ada Lovelace")

    await page.getByRole("button", { name: "Next page" }).click()
    await expect.poll(() => pageText(page).innerText()).toBe("Page 2 of 6")

    await page.locator("nav[aria-label=Pagination] select").selectOption("25")
    await expect.poll(() => pageText(page).innerText()).toBe("Page 1 of 3")

    await page.fill(`input[placeholder^="Search name"]`, "grace")
    await expect.poll(() => total(page).innerText()).toBe("5 total")

    await page.locator("#users-filter-teamId").selectOption({ label: "Growth" })
    await expect.poll(() => total(page).innerText()).toBe("2 total")

    expect(page.errors).toEqual([])
    await page.close()
  })

  it("validates, creates, edits and deletes through the dialog", async () => {
    const page = await open("/users")
    await page.getByRole("button", { name: "New user" }).click()
    await expect.poll(() => dialog(page).getByRole("dialog").isVisible()).toBe(true)
    await dialog(page).locator("input[type=email]").fill("bad")
    await dialog(page).locator("button[type=submit]").click()
    await expect.poll(() => dialog(page).locator("small[aria-live]").allTextContents()).toEqual([
      "Name is required",
      "Enter a valid email",
      "",
      "",
      ""
    ])

    await dialog(page).locator("input[type=text]").fill("E2E Person")
    await dialog(page).locator("input[type=email]").fill("e2e@example.com")
    await pickTeam(page, "Design")
    await save(page)
    await expect.poll(() => page.locator("#toast").innerText()).toBe("Created E2E Person")

    await page.fill(`input[placeholder^="Search name"]`, "e2e")
    await expect.poll(() => firstColumn(page)).toEqual(["E2E Person"])
    // The team picked in the select island was saved.
    expect(await teamColumn(page).innerText()).toBe("Design")

    await page.locator("tbody button", { hasText: "Edit" }).click()
    await expect.poll(() => dialog(page).count()).toBe(1)
    await expect.poll(() => teamTrigger(page).innerText()).toBe("Design")
    await dialog(page).locator("input[type=text]").fill("E2E Edited")
    await save(page)
    await expect.poll(() => firstColumn(page)).toEqual(["E2E Edited"])

    await page.locator("tbody button", { hasText: "Delete" }).click()
    await expect.poll(() => total(page).innerText()).toBe("0 total")
    expect(page.errors).toEqual([])
    await page.close()
  })

  it("closes the dialog with Escape, Cancel and the close button", async () => {
    const page = await open("/users")
    for (const close of [
      () => page.keyboard.press("Escape"),
      () => dialog(page).getByRole("button", { name: "Cancel" }).click(),
      () => dialog(page).getByRole("button", { name: "Close" }).click()
    ]) {
      await page.getByRole("button", { name: "New user" }).click()
      await expect.poll(() => page.getByRole("dialog").isVisible()).toBe(true)
      await close()
      await closed(page)
      // The `dialog` signal followed: the host lost its `open` attribute.
      expect(await dialog(page).count()).toBe(0)
    }
    expect(page.errors).toEqual([])
    await page.close()
  })

  it("takes clicks on the page while the dialog's exit transition runs", async () => {
    const page = await open("/users")
    await page.getByRole("button", { name: "New user" }).click()
    await expect.poll(() => page.getByRole("dialog").isVisible()).toBe(true)
    await page.keyboard.press("Escape")
    // Straight away: the dialog is still fading out.
    await sortBy(page, "Name")
    expect(await page.getByRole("dialog").count()).toBe(1)
    await expect.poll(() => new URL(page.url()).search).toBe("?sort=name&dir=asc")
    expect(page.errors).toEqual([])
    await page.close()
  })
})

describe("team select island", () => {
  it("changing a user's team in the form saves it", async () => {
    const page = await open("/users?email=ken.torvalds79%40")
    await expect.poll(() => total(page).innerText()).toBe("1 total")
    const before = await teamColumn(page).innerText()
    const next = before === "Design" ? "Growth" : "Design"

    await page.locator("tbody button", { hasText: "Edit" }).click()
    await expect.poll(() => teamTrigger(page).innerText()).toBe(before)
    await pickTeam(page, next)
    await expect.poll(() => teamTrigger(page).innerText()).toBe(next)
    await save(page)
    await expect.poll(() => teamColumn(page).innerText()).toBe(next)

    // And back to no team, through the explicit "No team" option.
    await page.locator("tbody button", { hasText: "Edit" }).click()
    await expect.poll(() => teamTrigger(page).innerText()).toBe(next)
    await pickTeam(page, "No team")
    await save(page)
    await expect.poll(() => teamColumn(page).innerText()).toBe("—")

    // Restore the seeded team (later tests count members).
    await page.locator("tbody button", { hasText: "Edit" }).click()
    await expect.poll(() => teamTrigger(page).innerText()).toBe("No team")
    await pickTeam(page, before)
    await save(page)
    await expect.poll(() => teamColumn(page).innerText()).toBe(before)

    expect(page.errors).toEqual([])
    await page.close()
  })

  it("updates its options live when a team is renamed in another tab, keeping the value", async () => {
    const users = await open("/users")
    const teams = await open("/teams")
    await users.locator("#users-filter-teamId").selectOption({ label: "Platform" })
    await expect.poll(() => teamColumn(users).innerText()).toBe("Platform")

    // An open edit dialog, with Platform chosen.
    await users.locator("tbody button", { hasText: "Edit" }).first().click()
    await expect.poll(() => teamTrigger(users).innerText()).toBe("Platform")

    await teams.locator("tbody tr", { hasText: "Platform" }).locator("button", { hasText: "Edit" }).click()
    await dialog(teams).locator("input[type=text]").fill("Platform Core")
    await save(teams)

    // The server re-sent the select: same value, new label, new options.
    await expect.poll(() => teamTrigger(users).innerText()).toBe("Platform Core")
    const options = await teamOptions(users)
    expect(options).toContain("Platform Core")
    expect(options).not.toContain("Platform")
    // The dialog stayed open through it.
    expect(await dialog(users).count()).toBe(1)

    expect([...users.errors, ...teams.errors]).toEqual([])
    await users.close()
    await teams.close()
  })
})

describe("URL state", () => {
  it("mirrors the query into the URL and restores it on reload", async () => {
    const page = await open("/users")
    await sortBy(page, "Email")
    await page.locator("#users-filter-teamId").selectOption({ label: "Design" })
    await page.fill(`input[placeholder^="Search name"]`, "ada")
    await expect.poll(() => new URL(page.url()).search).toBe("?name=ada&teamId=3&sort=email&dir=asc")
    const before = await firstColumn(page)

    await page.reload()
    // Server-rendered: the table is right before any script runs.
    expect(await firstColumn(page)).toEqual(before)
    expect(await page.inputValue(`input[placeholder^="Search name"]`)).toBe("ada")
    await expect.poll(() => filterText(page, "#users-filter-teamId")).toBe("Design")
    expect(page.errors).toEqual([])
    await page.close()
  })

  it("opens a shared link directly", async () => {
    const page = await acme.newPage()
    await page.goto(base + "/users?teamId=null&pageSize=25")
    expect(await total(page).innerText()).toBe("7 total")
    await page.close()
  })
})

describe("live updates across tabs", () => {
  it("renaming a team in one tab updates the users tab", async () => {
    const users = await open("/users")
    const teams = await open("/teams")
    await users.locator("#users-filter-teamId").selectOption({ label: "Growth" })
    await expect.poll(() => total(users).innerText()).toBe("15 total")

    await teams.locator("tbody tr", { hasText: "Growth" }).locator("button", { hasText: "Edit" }).click()
    await dialog(teams).locator("input[type=text]").fill("Growth Eng")
    await save(teams)

    await expect.poll(() => teamColumn(users).innerText()).toBe("Growth Eng")
    await expect.poll(() => filterText(users, "#users-filter-teamId")).toBe("Growth Eng")
    expect(await total(users).innerText()).toBe("15 total")

    await teams.locator("tbody tr", { hasText: "Growth Eng" }).locator("button", { hasText: "Delete" }).click()
    await expect.poll(() => teams.locator("#toast").innerText()).toBe("This team still has members. Move them first.")

    expect([...users.errors, ...teams.errors]).toEqual([])
    await users.close()
    await teams.close()
  })

  it("renaming a user in one tab patches that row in another", async () => {
    const editor = await open("/users")
    const viewer = await open("/users")
    const warnings: Array<string> = []
    viewer.on("console", (m) => m.type() === "warning" && warnings.push(m.text()))
    const row = (page: Page) => page.locator("tbody tr").first()
    const id = await row(viewer).getAttribute("id")

    await row(editor).locator("button", { hasText: "Edit" }).click()
    await expect.poll(() => dialog(editor).count()).toBe(1)
    await dialog(editor).locator("input[type=text]").fill("Row Patched")
    await save(editor)

    await expect.poll(() => row(viewer).locator("td").nth(1).innerText()).toBe("Row Patched")
    expect(await row(viewer).getAttribute("id")).toBe(id)
    expect(await total(viewer).innerText()).toBe("52 total")
    expect([...editor.errors, ...viewer.errors, ...warnings]).toEqual([])
    await editor.close()
    await viewer.close()
  })
})

describe("team detail page", () => {
  it("links from the teams table, shows live members, creates into the team and follows a rename", async () => {
    // As Globex, whose Support team (5) has 14 members.
    const open = openAsGlobex
    const detail = await open("/teams")
    await detail.locator("tbody a", { hasText: "Support" }).click()
    await detail.waitForURL(/\/teams\/5$/)
    await expect.poll(() => detail.locator("#teams-record h1").innerText()).toBe("Support")
    await expect.poll(() => total(detail).innerText()).toBe("14 total")
    // The locked column and filter are hidden.
    expect(await detail.locator("#members-filter-teamId").count()).toBe(0)
    expect(await detail.locator("thead").innerText()).not.toContain("Team")

    // Sorting and filtering inside the embed leave the page URL alone.
    await sortBy(detail, "Name")
    await detail.fill(`input[placeholder^="Search name"]`, "ada")
    await expect.poll(async () => Number((await total(detail).innerText()).split(" ")[0])).toBeLessThan(14)
    expect(new URL(detail.url()).pathname + new URL(detail.url()).search).toBe("/teams/5")
    await detail.fill(`input[placeholder^="Search name"]`, "")
    await expect.poll(() => total(detail).innerText()).toBe("14 total")

    // Create from the embedded table: the new member lands in this team.
    await detail.locator("#members-section").getByRole("button", { name: "New user" }).click()
    expect(await detail.locator("#members-dialog select").count()).toBe(1) // role only, no team
    expect(await detail.locator("#members-dialog ds-island").count()).toBe(0) // no team select island
    await dialog(detail).locator("input[type=text]").fill("Embedded Person")
    await dialog(detail).locator("input[type=email]").fill("embedded@example.com")
    await save(detail)
    await expect.poll(() => detail.locator("#toast").innerText()).toBe("Created Embedded Person")
    await expect.poll(() => total(detail).innerText()).toBe("15 total")

    // A users tab sees the new member in Support, and its team cell links back.
    const users = await open("/users?name=Embedded")
    await expect.poll(() => teamColumn(users).innerText()).toBe("Support")
    expect(await users.locator("tbody tr td:nth-child(5) a").getAttribute("href")).toBe("/teams/5")

    // Rename the team from the teams page: the detail page and the users tab follow.
    const teams = await open("/teams")
    await teams.locator("tbody tr", { hasText: "Support" }).locator("button", { hasText: "Edit" }).click()
    await dialog(teams).locator("input[type=text]").fill("Support Ops")
    await save(teams)
    await expect.poll(() => detail.locator("#teams-record h1").innerText()).toBe("Support Ops")
    await expect.poll(() => teamColumn(users).innerText()).toBe("Support Ops")

    expect([...detail.errors, ...users.errors, ...teams.errors]).toEqual([])
    await Promise.all([detail.close(), users.close(), teams.close()])
  })

  it("edits the record in place, follows a rename from another tab, and deletes back to the list", async () => {
    const teams = await open("/teams")
    await teams.getByRole("button", { name: "New team" }).click()
    await dialog(teams).locator("input[type=text]").fill("Detail Team")
    await save(teams)
    const taken = await teams.locator("tbody a").filter({ hasNotText: "Detail" }).first().innerText()
    await teams.locator("tbody a", { hasText: "Detail Team" }).click()
    await teams.waitForURL(/\/teams\/\d+$/)
    const detail = teams
    const heading = detail.locator("#teams-record h1")
    await expect.poll(() => heading.innerText()).toBe("Detail Team")

    // Edit: the same dialog and validation as the list.
    await detail.locator("#teams-record").getByRole("button", { name: "Edit" }).click()
    await expect.poll(() => dialog(detail).locator("input[type=text]").inputValue()).toBe("Detail Team")
    await dialog(detail).locator("input[type=text]").fill(taken)
    await dialog(detail).locator("button[type=submit]").click()
    await expect.poll(() => dialog(detail).innerText()).toContain("A team with that name already exists")
    await dialog(detail).locator("input[type=text]").fill("Detail Edited")
    await save(detail)
    await expect.poll(() => heading.innerText()).toBe("Detail Edited")
    await expect.poll(() => detail.locator("#toast").innerText()).toBe("Saved Detail Edited")

    // A rename in another tab shows up here.
    const other = await open("/teams?name=Detail")
    await other.locator("tbody button", { hasText: "Edit" }).click()
    await dialog(other).locator("input[type=text]").fill("Detail Remote")
    await save(other)
    await expect.poll(() => heading.innerText()).toBe("Detail Remote")

    // Delete: back to the list, where the team is gone.
    await detail.locator("#teams-record").getByRole("button", { name: "Delete" }).click()
    await detail.waitForURL(/\/teams$/)
    await detail.locator("tbody tr").first().waitFor()
    expect(await detail.locator("tbody").innerText()).not.toContain("Detail Remote")
    // The toast came along (a flash cookie), once: a reload doesn't show it again.
    await expect.poll(() => detail.locator("#toast").innerText()).toBe("Deleted")
    expect((await detail.context().cookies()).map((c) => c.name)).not.toContain("flash")
    await detail.reload()
    expect(await detail.locator("#toast").innerText()).toBe("")

    expect([...detail.errors, ...other.errors]).toEqual([])
    await Promise.all([detail.close(), other.close()])
  })

  it("a user's page changes the team through the select island", async () => {
    const users = await open("/users?sort=name&dir=asc")
    await users.locator("tbody a").first().click()
    await users.waitForURL(/\/users\/\d+$/)
    const page = users
    await page.locator("#users-record").getByRole("button", { name: "Edit" }).click()
    await expect.poll(() => dialog(page).count()).toBe(1)
    await pickTeam(page, "Design")
    await save(page)
    await expect.poll(() => page.locator("#users-record-teamId").innerText()).toBe("Design")
    expect(await page.locator("#users-record-teamId a").getAttribute("href")).toBe("/teams/3")
    expect(page.errors).toEqual([])
    await page.close()
  })

  it("404s for unknown and malformed ids", async () => {
    const page = await acme.newPage()
    expect((await page.goto(base + "/teams/999"))!.status()).toBe(404)
    expect((await page.goto(base + "/teams/abc"))!.status()).toBe(404)
    await page.close()
  })
})
