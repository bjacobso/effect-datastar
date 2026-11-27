/**
 * Browser end-to-end tests for the Kanban board (`apps/board`):
 * runs the real built server (`node dist/server.js`) on an ephemeral port
 * and exercises all 4 layers of the Datastar DSL in headless Chromium.
 */
import type { ChildProcess } from "node:child_process"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { openBoard, startServer } from "./helpers.ts"

let server: ChildProcess
let browser: Browser
let base: string

beforeAll(async () => {
  const started = await startServer()
  server = started.process
  base = started.url
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
})

describe("Kanban board E2E", () => {
  it("renders initial seeded cards and column counts", async () => {
    const page = await openBoard(browser, base)
    try {
      await expect.poll(() => page.locator("h1").innerText()).toBe("Task Board")

      await expect.poll(() => page.locator("#board-todo-count").innerText()).toBe("2")
      await expect.poll(() => page.locator("#board-doing-count").innerText()).toBe("1")
      await expect.poll(() => page.locator("#board-done-count").innerText()).toBe("1")

      await expect.poll(() => page.locator("#board-todo article").allInnerTexts()).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Add Kanban live SSE board"),
          expect.stringContaining("Document multi-app workspaces")
        ])
      )
      await expect.poll(() => page.locator("#board-doing article").allInnerTexts()).toEqual(
        expect.arrayContaining([expect.stringContaining("Build custom Datastar JSX runtime")])
      )
      await expect.poll(() => page.locator("#board-done article").allInnerTexts()).toEqual(
        expect.arrayContaining([expect.stringContaining("Design typed signal AST")])
      )

      expect(page.errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it("disables submit on empty title and displays server validation error on blank submit", async () => {
    const page = await openBoard(browser, base)
    try {
      const titleInput = page.getByLabel("Task title")
      const addButton = page.getByRole("button", { name: "Add Card" })
      const alert = page.locator("p[role='alert']")

      // Initially empty -> disabled button, hidden alert
      await expect.poll(() => addButton.isDisabled()).toBe(true)
      await expect.poll(() => alert.isVisible()).toBe(false)

      // Whitespace-only title -> still disabled
      await titleInput.fill("   ")
      await expect.poll(() => addButton.isDisabled()).toBe(true)

      // Dispatch submit on the composer form to verify server-side validation error patch
      await page.locator("form").dispatchEvent("submit")
      await expect.poll(() => alert.isVisible()).toBe(true)
      await expect.poll(() => alert.innerText()).toBe("Card title is required.")
      await expect.poll(() => titleInput.getAttribute("aria-invalid")).not.toBeNull()

      expect(page.errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it("creates, moves, filters, and deletes cards", async () => {
    const page = await openBoard(browser, base)
    try {
      const titleInput = page.getByLabel("Task title")
      const columnSelect = page.getByLabel("Column")
      const prioritySelect = page.getByLabel("Priority")
      const addButton = page.getByRole("button", { name: "Add Card" })

      // 1. Create a new card in "In Progress" with high priority
      await titleInput.fill("Ship Playwright E2E suite")
      await columnSelect.selectOption("doing")
      await prioritySelect.selectOption("high")
      await expect.poll(() => addButton.isDisabled()).toBe(false)
      await addButton.click()

      const createdCard = page.locator("#board-doing article", { hasText: "Ship Playwright E2E suite" })
      await createdCard.waitFor()
      await expect.poll(() => createdCard.innerText()).toContain("HIGH")
      await expect.poll(() => page.locator("#board-doing-count").innerText()).toBe("2")
      await expect.poll(() => titleInput.inputValue()).toBe("")

      // 2. Move the card from "In Progress" to "Done"
      await createdCard.getByRole("button", { name: "-> Done" }).click()
      const movedCard = page.locator("#board-done article", { hasText: "Ship Playwright E2E suite" })
      await movedCard.waitFor()
      await expect.poll(() => page.locator("#board-doing article", { hasText: "Ship Playwright E2E suite" }).count()).toBe(0)
      await expect.poll(() => page.locator("#board-doing-count").innerText()).toBe("1")
      await expect.poll(() => page.locator("#board-done-count").innerText()).toBe("2")

      // 3. Client-side filtering via reactive Datastar signals
      const filterInput = page.getByLabel("Filter cards")
      const filterBadge = page.locator("header span")
      await filterInput.fill("playwright")
      await expect.poll(() => filterInput.evaluate((el) => el.classList.contains("active"))).toBe(true)
      await expect.poll(() => filterBadge.isVisible()).toBe(true)
      await expect.poll(() => filterBadge.innerText()).toBe("Filter: playwright")
      await expect.poll(() => movedCard.isVisible()).toBe(true)
      await expect.poll(() =>
        page.locator("article", { hasText: "Design typed signal AST" }).isVisible()
      ).toBe(false)

      // Clear filter -> badge hides and all cards reappear
      await filterInput.fill("")
      await expect.poll(() => filterBadge.isVisible()).toBe(false)
      await expect.poll(() =>
        page.locator("article", { hasText: "Design typed signal AST" }).isVisible()
      ).toBe(true)

      // 4. Delete the card (confirm dialog is auto-accepted by openBoard)
      await movedCard.getByRole("button", { name: "Delete" }).click()
      await expect.poll(() => page.locator("article", { hasText: "Ship Playwright E2E suite" }).count()).toBe(0)
      await expect.poll(() => page.locator("#board-done-count").innerText()).toBe("1")

      expect(page.errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it("syncs mutations across two open browser tabs via live SSE without reload", async () => {
    const tab1 = await openBoard(browser, base)
    const tab2 = await openBoard(browser, base)
    try {
      // Create a card in tab 1 -> tab 2 receives the SSE broadcast automatically
      await tab1.getByLabel("Task title").fill("Multi-tab live sync card")
      await tab1.getByLabel("Column").selectOption("todo")
      await tab1.getByLabel("Priority").selectOption("med")
      await tab1.getByRole("button", { name: "Add Card" }).click()

      await expect.poll(() =>
        tab2.locator("#board-todo article", { hasText: "Multi-tab live sync card" }).count()
      ).toBe(1)
      await expect.poll(() => tab2.locator("#board-todo-count").innerText()).toBe("3")

      // Move the card in tab 1 -> tab 2 updates columns and counts automatically
      await tab1
        .locator("#board-todo article", { hasText: "Multi-tab live sync card" })
        .getByRole("button", { name: "-> In Progress" })
        .click()

      await expect.poll(() =>
        tab2.locator("#board-doing article", { hasText: "Multi-tab live sync card" }).count()
      ).toBe(1)
      await expect.poll(() => tab2.locator("#board-todo-count").innerText()).toBe("2")
      await expect.poll(() => tab2.locator("#board-doing-count").innerText()).toBe("2")

      // Delete the card in tab 1 -> tab 2 removes it automatically
      await tab1
        .locator("#board-doing article", { hasText: "Multi-tab live sync card" })
        .getByRole("button", { name: "Delete" })
        .click()

      await expect.poll(() =>
        tab2.locator("article", { hasText: "Multi-tab live sync card" }).count()
      ).toBe(0)
      await expect.poll(() => tab2.locator("#board-doing-count").innerText()).toBe("1")

      expect(tab1.errors).toEqual([])
      expect(tab2.errors).toEqual([])
    } finally {
      await tab1.close()
      await tab2.close()
    }
  })
})
