/**
 * Row-level live updates across server processes: two full apps ("servers" A
 * and B), each with its own SQLite connection, Broadcast and Reactivity, on
 * one temp database file. A has no open views; B has one. SQL statements are
 * counted on the shared `node:sqlite` driver, and told apart by their text:
 * A's mutation path uses `SqlModel`'s lowercase SQL, B's live view the
 * uppercase page/COUNT/row queries.
 */
import { Duration } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, describe, expect, it } from "vitest"
import { sqlLog } from "./sqlCounter.ts"
import { type Event, makeApp, userDraft, usersQuery } from "./support.ts"

const dir = mkdtempSync(join(tmpdir(), "effect-datastar-crossprocess-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = join(dir, "app.sqlite")
const pollInterval = Duration.millis(20)

const a = makeApp({ filename: file, pollInterval })
// A migrates and seeds before B starts.
await a.page("/users")
const b = makeApp({ filename: file, pollInterval })

type Patch = Extract<Event, { type: "patch-elements" }>
const patches = (events: Array<Event>) => events.filter((e): e is Patch => e.type === "patch-elements")
const tablePatch = (events: Array<Event>) => patches(events).find((e) => e.elements.includes(`id="users-table"`))
const rowPatches = (events: Array<Event>) => patches(events).filter((e) => e.elements.startsWith(`<tr id="users-`))
const isTable = (events: Array<Event>) => tablePatch(events) !== undefined
const hasAny = (events: Array<Event>) => events.length > 0

/** Statements B's live view ran: page queries, COUNTs and row re-fetches (never the broadcast's own). */
const viewStatements = () => {
  const all = sqlLog.statements.filter((s) => !/reactivity_invalidations|PRAGMA|sqlite_sequence/.test(s))
  return {
    pages: all.filter((s) => /^\s*SELECT \* FROM "users"\s+(WHERE (?!"id" IN)|ORDER BY)/.test(s)).length,
    counts: all.filter((s) => /COUNT\(\*\)/.test(s)).length,
    rows: all.filter((s) => /^\s*SELECT \* FROM "users" WHERE "id" IN/.test(s)).length
  }
}

/** A user's current draft on A, as its edit dialog loads it. */
const draftOn = async (id: number): Promise<Record<string, unknown>> => {
  const { events } = await a.action("GET", `/users/${id}/edit`)
  return (events[0] as { signals: { users: { draft: Record<string, unknown> } } }).signals.users.draft
}

const openOnB = async (q: ReturnType<typeof usersQuery>) => {
  const s = await b.stream("/users/view", q)
  const first = await s.until(isTable)
  return { ...s, first: tablePatch(first)!.elements }
}

describe("row changes across processes", () => {
  it("a visible-row rename on A is a single-row patch on B", async () => {
    const s = await openOnB(usersQuery())
    expect(s.first).toContain(`<tr id="users-87">`)
    const draft = await draftOn(87)
    sqlLog.reset()
    await a.action("PUT", "/users/87", userDraft({ ...draft, name: "Renamed On A" }))
    const events = await s.until(hasAny, { settle: 150 })
    const counted = viewStatements()
    await s.close()
    console.log("B, rename on A:", counted)

    expect(tablePatch(events)).toBeUndefined()
    const [row, ...others] = rowPatches(events)
    expect(others).toEqual([])
    expect(row!.elements).toMatch(/^<tr id="users-87"><td>(<span>|<a [^>]*>)?Renamed On A</)
    expect(counted).toEqual({ pages: 0, counts: 0, rows: 1 })
  })

  it("a filtered-column change on A re-queries B's page", async () => {
    const s = await openOnB(usersQuery({}, { role: "member" }))
    const target = Number(/<tr id="users-(\d+)">/.exec(s.first)![1])
    const draft = await draftOn(target)
    sqlLog.reset()
    await a.action("PUT", `/users/${target}`, userDraft({ ...draft, role: "guest" }))
    const events = await s.until(isTable, { settle: 150 })
    const counted = viewStatements()
    await s.close()
    console.log("B, role change on A:", counted)

    expect(tablePatch(events)!.elements).not.toContain(`<tr id="users-${target}">`)
    expect(rowPatches(events)).toEqual([])
    expect(counted).toEqual({ pages: 1, counts: 1, rows: 0 })
  })

  it("an invalidation without a payload (an older sender) re-queries B's page", async () => {
    const s = await openOnB(usersQuery())
    sqlLog.reset()
    // Exactly what a sender from before payloads wrote: keys only.
    const db = new DatabaseSync(file)
    try {
      db.prepare(`INSERT INTO reactivity_invalidations (origin, keys, createdAt) VALUES (?, ?, ?)`)
        .run("older-process", JSON.stringify({ users: [87] }), Date.now())
    } finally {
      db.close()
    }
    const events = await s.until(isTable, { settle: 150 })
    const counted = viewStatements()
    await s.close()
    console.log("B, bare keys from an older sender:", counted)

    expect(rowPatches(events)).toEqual([])
    expect(counted).toEqual({ pages: 1, counts: 1, rows: 0 })
  })
})
