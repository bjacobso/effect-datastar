/**
 * Shared browser-test helpers for the Kanban board: start the built server on
 * an ephemeral port and open Chromium tabs that record console/page errors.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import type { Browser, Page } from "playwright"

export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

/** Start `node dist/server.js` (built by the global setup) on a free port. */
export const startServer = async (): Promise<{ readonly url: string; readonly process: ChildProcess }> => {
  const port = await freePort()
  const server = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, PORT: String(port) },
    stdio: "pipe"
  })
  await new Promise<void>((resolve, reject) => {
    let stderr = ""
    const timer = setTimeout(() => reject(new Error(`server did not start. stderr:\n${stderr}`)), 30_000)
    server.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    server.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited early with code ${code}. stderr:\n${stderr}`))
    })
    server.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Listening on")) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  return { url: `http://localhost:${port}`, process: server }
}

export type Tab = Page & { readonly errors: Array<string> }

/** Open a new tab on the board URL, collecting page/console errors and accepting confirms. */
export const openBoard = async (browser: Browser, url: string): Promise<Tab> => {
  const page = await browser.newPage()
  const errors: Array<string> = []
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  page.on("dialog", (d) => d.accept())

  // Wait for the live SSE connection initiated by `$init` to respond so multi-tab updates are subscribed.
  const liveConnected = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/board/live" && res.status() === 200
  )
  await page.goto(url)
  await page.locator("#board-columns article").first().waitFor()
  await liveConnected
  return Object.assign(page, { errors })
}
