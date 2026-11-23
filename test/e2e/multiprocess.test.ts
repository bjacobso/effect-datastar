/**
 * Browser end-to-end across processes: two real servers on different ports
 * sharing one temp SQLite file, a tab on each. A change made through one
 * server must reach the tab connected to the other.
 */
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, type BrowserContext, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { dialog, open as openTab, signIn, startServer, total } from "./helpers.ts"

const servers: Array<ChildProcess> = []
let browser: Browser
/** Signed in as ada@acme.test. The cookie reaches both servers (cookies ignore the port), which share the sessions table. */
let acme: BrowserContext
let a: string
let b: string
let dir: string

const start = async (db: string) => {
  const started = await startServer(db)
  servers.push(started.process)
  return started.url
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "effect-datastar-multi-"))
  const db = join(dir, "e2e.db")
  // One after the other, so only the first migrates and seeds.
  a = await start(db)
  b = await start(db)
  browser = await chromium.launch()
  acme = await signIn(browser, a)
})

afterAll(async () => {
  await browser?.close()
  for (const server of servers) server.kill()
  rmSync(dir, { recursive: true, force: true })
})

const open = (base: string, path: string) => openTab(acme, base + path)

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
    await expect.poll(() => total(onB).innerText()).toBe("52 total")

    await onA.getByRole("button", { name: "New user" }).click()
    await dialog(onA).locator("input[type=text]").fill("Cross Process")
    await dialog(onA).locator("input[type=email]").fill("cross@example.com")
    const submitted = Date.now()
    await dialog(onA).locator("button[type=submit]").click()

    const latency = await timeUntil(submitted, async () => (await total(onB).innerText()) === "53 total")
    console.log(`cross-process latency (create user, click to other tab updated): ${latency} ms`)
    // Newest first: the new user tops the default sort.
    await expect.poll(() => onB.locator("tbody tr td:nth-child(2)").first().innerText()).toBe("Cross Process")
    expect(await total(onA).innerText()).toBe("53 total")

    expect([...onA.errors, ...onB.errors]).toEqual([])
    await onA.close()
    await onB.close()
  })

  it("renaming a team through one server updates the other's users tab and selects", async () => {
    const teams = await open(a, "/teams")
    const users = await open(b, "/users")
    await users.locator("#users-filter-teamId").selectOption({ label: "Design" })
    await expect.poll(() => users.locator("tbody tr td:nth-child(5)").first().innerText()).toBe("Design")

    await teams.locator("tbody tr", { hasText: "Design" }).locator("button", { hasText: "Edit" }).click()
    await dialog(teams).locator("input[type=text]").fill("Design Systems")
    const submitted = Date.now()
    await dialog(teams).locator("button[type=submit]").click()

    const latency = await timeUntil(
      submitted,
      async () => (await users.locator("tbody tr td:nth-child(5)").first().innerText()) === "Design Systems"
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

    await teamsOnB.getByRole("button", { name: "New team" }).click()
    await dialog(teamsOnB).locator("input[type=text]").fill("Research")
    await dialog(teamsOnB).locator("button[type=submit]").click()
    await expect.poll(() => teamsOnA.locator("tbody tr", { hasText: "Research" }).count()).toBe(1)

    expect([...teamsOnA.errors, ...teamsOnB.errors]).toEqual([])
    await teamsOnA.close()
    await teamsOnB.close()
  })
})
