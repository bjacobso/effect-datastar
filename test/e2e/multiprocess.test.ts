/**
 * Browser end-to-end across processes: two real servers on different ports
 * sharing one temp SQLite file, a tab on each. A change made through one
 * server must reach the tab connected to the other.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium, type Page } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let servers: Array<ChildProcess> = []
let browser: Browser
let a: string
let b: string
let dir: string

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

const start = async (db: string) => {
  const port = await freePort()
  const server = spawn("npx", ["tsx", "src/main.tsx"], {
    env: { ...process.env, PORT: String(port), DB: db },
    stdio: "pipe"
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 30_000)
    server.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Listening on")) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  return `http://localhost:${port}`
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "effect-datastar-multi-"))
  const db = join(dir, "e2e.db")
  // One after the other, so only the first migrates and seeds.
  a = await start(db)
  b = await start(db)
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  for (const server of servers) server.kill()
  rmSync(dir, { recursive: true, force: true })
})

const open = async (base: string, path: string) => {
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

/** Poll every 5 ms until `check` holds; resolves with the elapsed time. */
const timeUntil = async (since: number, check: () => Promise<boolean>) => {
  while (!(await check())) {
    if (Date.now() - since > 10_000) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 5))
  }
  return Date.now() - since
}

describe("live updates across server processes", () => {
  it("creating a user through one server updates a tab on the other", async () => {
    const onA = await open(a, "/users")
    const onB = await open(b, "/users")
    await expect.poll(() => total(onB).innerText()).toBe("87 total")

    await onA.locator("header button", { hasText: "New user" }).click()
    await onA.fill("dialog input[type=text]", "Cross Process")
    await onA.fill("dialog input[type=email]", "cross@example.com")
    const submitted = Date.now()
    await onA.locator("dialog button[type=submit]").click()

    const latency = await timeUntil(submitted, async () => (await total(onB).innerText()) === "88 total")
    console.log(`cross-process latency (create user, click to other tab updated): ${latency} ms`)
    // Newest first: the new user tops the default sort.
    await expect.poll(() => onB.locator("tbody tr td:first-child").first().innerText()).toBe("Cross Process")
    expect(await total(onA).innerText()).toBe("88 total")

    expect([...onA.errors, ...onB.errors]).toEqual([])
    await onA.close()
    await onB.close()
  })

  it("renaming a team through one server updates the other's users tab and selects", async () => {
    const teams = await open(a, "/teams")
    const users = await open(b, "/users")
    await users.locator("#users-filter-teamId").selectOption({ label: "Design" })
    await expect.poll(() => users.locator("tbody tr td:nth-child(4)").first().innerText()).toBe("Design")

    await teams.locator("tbody tr", { hasText: "Design" }).locator("button", { hasText: "Edit" }).click()
    await teams.fill("dialog input[type=text]", "Design Systems")
    const submitted = Date.now()
    await teams.locator("dialog button[type=submit]").click()

    const latency = await timeUntil(
      submitted,
      async () => (await users.locator("tbody tr td:nth-child(4)").first().innerText()) === "Design Systems"
    )
    console.log(`cross-process latency (rename team, click to other tab updated): ${latency} ms`)
    await expect.poll(() =>
      users.locator("#users-filter-teamId").evaluate((s: HTMLSelectElement) => s.selectedOptions[0]!.text)
    ).toBe("Design Systems")

    expect([...teams.errors, ...users.errors]).toEqual([])
    await teams.close()
    await users.close()
  })

  it("updates flow both ways", async () => {
    const teamsOnA = await open(a, "/teams")
    const teamsOnB = await open(b, "/teams")

    await teamsOnB.locator("header button", { hasText: "New team" }).click()
    await teamsOnB.fill("dialog input[type=text]", "Research")
    await teamsOnB.locator("dialog button[type=submit]").click()
    await expect.poll(() => teamsOnA.locator("tbody tr", { hasText: "Research" }).count()).toBe(1)

    expect([...teamsOnA.errors, ...teamsOnB.errors]).toEqual([])
    await teamsOnA.close()
    await teamsOnB.close()
  })
})
