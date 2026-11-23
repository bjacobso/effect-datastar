/**
 * Browser end-to-end: the real server (temp SQLite file) + headless Chromium,
 * two tabs to check live updates across pages.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium, type Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let server: ChildProcess
let browser: Browser
let base: string
let dir: string

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "effect-datastar-"))
  const port = await freePort()
  base = `http://localhost:${port}`
  server = spawn("npx", ["tsx", "src/main.tsx"], {
    env: { ...process.env, PORT: String(port), DB: join(dir, "e2e.db") },
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
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  rmSync(dir, { recursive: true, force: true })
})

const open = async (path: string) => {
  const page = await browser.newPage()
  const errors: Array<string> = []
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  page.on("dialog", (d) => d.accept())
  await page.goto(base + path)
  await page.locator("tbody tr").first().waitFor()
  return Object.assign(page, { errors })
}

const total = (page: Page) => page.locator(".pagination > span").first()
const firstColumn = (page: Page) => page.locator("tbody tr td:first-child").allInnerTexts()

describe("users page", () => {
  it("sorts, pages, filters and changes page size", async () => {
    const page = await open("/users")
    await expect.poll(() => total(page).innerText()).toBe("87 total")

    await page.locator("button.sort", { hasText: "Name" }).click()
    await expect.poll(async () => (await firstColumn(page))[0]).toBe("Ada Hamilton")

    await page.locator(".pagination button", { hasText: "›" }).click()
    await expect.poll(() => page.locator(".pagination .pages span").innerText()).toBe("Page 2 of 9")

    await page.locator(".pagination select").selectOption("25")
    await expect.poll(() => page.locator(".pagination .pages span").innerText()).toBe("Page 1 of 4")

    await page.fill(`input[placeholder^="Search name"]`, "grace")
    await expect.poll(() => total(page).innerText()).toBe("8 total")

    await page.locator("#users-filter-teamId").selectOption({ label: "Growth" })
    await expect.poll(() => total(page).innerText()).toBe("2 total")

    expect(page.errors).toEqual([])
    await page.close()
  })

  it("validates, creates, edits and deletes through the dialog", async () => {
    const page = await open("/users")
    await page.locator("header button", { hasText: "New user" }).click()
    await page.fill("dialog input[type=email]", "bad")
    await page.locator("dialog button[type=submit]").click()
    await expect.poll(() => page.locator("dialog .error").allInnerTexts()).toEqual([
      "Name is required",
      "Enter a valid email",
      "",
      "",
      ""
    ])

    await page.fill("dialog input[type=text]", "E2E Person")
    await page.fill("dialog input[type=email]", "e2e@example.com")
    await page.locator("#users-field-teamId").selectOption({ label: "Design" })
    await page.locator("dialog button[type=submit]").click()
    await expect.poll(() => page.locator("#toast").innerText()).toBe("Created E2E Person")
    await expect.poll(() => page.locator("dialog[open]").count()).toBe(0)

    await page.fill(`input[placeholder^="Search name"]`, "e2e")
    await expect.poll(() => firstColumn(page)).toEqual(["E2E Person"])

    await page.locator("tbody button", { hasText: "Edit" }).click()
    await expect.poll(() => page.locator("dialog[open]").count()).toBe(1)
    expect(await page.locator("#users-field-teamId").evaluate((s: HTMLSelectElement) => s.selectedOptions[0]!.text))
      .toBe("Design")
    await page.fill("dialog input[type=text]", "E2E Edited")
    await page.locator("dialog button[type=submit]").click()
    await expect.poll(() => firstColumn(page)).toEqual(["E2E Edited"])

    await page.locator("tbody button", { hasText: "Delete" }).click()
    await expect.poll(() => total(page).innerText()).toBe("0 total")
    expect(page.errors).toEqual([])
    await page.close()
  })
})

describe("URL state", () => {
  it("mirrors the query into the URL and restores it on reload", async () => {
    const page = await open("/users")
    await page.locator("button.sort", { hasText: "Email" }).click()
    await page.locator("#users-filter-teamId").selectOption({ label: "Design" })
    await page.fill(`input[placeholder^="Search name"]`, "ada")
    await expect.poll(() => new URL(page.url()).search).toBe("?name=ada&teamId=3&sort=email&dir=asc")
    const before = await firstColumn(page)

    await page.reload()
    // Server-rendered: the table is right before any script runs.
    expect(await firstColumn(page)).toEqual(before)
    expect(await page.inputValue(`input[placeholder^="Search name"]`)).toBe("ada")
    await expect.poll(() =>
      page.locator("#users-filter-teamId").evaluate((s: HTMLSelectElement) => s.selectedOptions[0]!.text)
    ).toBe("Design")
    expect(page.errors).toEqual([])
    await page.close()
  })

  it("opens a shared link directly", async () => {
    const page = await browser.newPage()
    await page.goto(base + "/users?teamId=null&pageSize=25")
    expect(await total(page).innerText()).toBe("14 total")
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
    await teams.fill("dialog input[type=text]", "Growth Eng")
    await teams.locator("dialog button[type=submit]").click()

    await expect.poll(() => users.locator("tbody tr td:nth-child(4)").first().innerText()).toBe("Growth Eng")
    await expect.poll(() =>
      users.locator("#users-filter-teamId").evaluate((s: HTMLSelectElement) => s.selectedOptions[0]!.text)
    ).toBe("Growth Eng")
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
    await expect.poll(() => editor.locator("dialog[open]").count()).toBe(1)
    await editor.fill("dialog input[type=text]", "Row Patched")
    await editor.locator("dialog button[type=submit]").click()

    await expect.poll(() => row(viewer).locator("td").first().innerText()).toBe("Row Patched")
    expect(await row(viewer).getAttribute("id")).toBe(id)
    expect(await total(viewer).innerText()).toBe("87 total")
    expect([...editor.errors, ...viewer.errors, ...warnings]).toEqual([])
    await editor.close()
    await viewer.close()
  })
})
