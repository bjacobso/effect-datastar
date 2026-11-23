/**
 * SQL statements per mutation (the mutation itself plus everything the open
 * views run because of it), with six users live views open. Prints a table:
 * `npx vitest run test/queries.test.ts --silent=false`.
 *
 * Before row-level changes, every mutation cost 1 + 3 × views = 19 here: each
 * view re-ran its page query, its COUNT and the team lookup.
 */
import { afterAll, describe, expect, it } from "vitest"
import { sqlLog } from "./sqlCounter.ts"
import { makeApp, userDraft, usersQuery } from "./support.ts"

const app = makeApp()

/** Six views: three pages of the default list, sorted by name, filtered by role, filtered by team. */
const queries = [
  usersQuery(),
  usersQuery({ page: 2 }),
  usersQuery({ page: 3 }),
  usersQuery({ sort: "name", dir: "asc" }),
  usersQuery({}, { role: "admin" }),
  usersQuery({}, { teamId: "2" })
]
const results: Array<{ mutation: string; statements: number; sql: string }> = []

afterAll(() => {
  console.table(results)
})

describe("SQL statements per mutation", () => {
  it("measures", async () => {
    const streams = await Promise.all(queries.map((q) => app.stream("/users/view", q)))
    await Promise.all(streams.map((s) => s.until((events) => events.length > 0, { settle: 100 })))

    const measure = async (mutation: string, run: () => Promise<unknown>) => {
      sqlLog.reset()
      await run()
      await Promise.all(streams.map((s) => s.collect(250)))
      // Leave out the cross-process broadcast (one INSERT per mutation, plus timing-dependent polls).
      const statements = sqlLog.statements.filter((s) => !/reactivity_invalidations|PRAGMA data_version/.test(s))
      const kinds = statements.map((s) => s.trim().split(/\s+/).slice(0, 3).join(" "))
      const counts = new Map<string, number>()
      for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1)
      results.push({ mutation, statements: statements.length, sql: [...counts].map(([k, n]) => `${n}× ${k}`).join(", ") })
      return statements.length
    }

    /** Save user `id` with `changes` applied to its current draft, like the edit dialog does (not measured). */
    const save = async (id: number, changes: Record<string, unknown>) => {
      const { events } = await app.action("GET", `/users/${id}/edit`)
      const draft = (events[0] as { signals: { users: { draft: Record<string, unknown> } } }).signals.users.draft
      return () => app.action("PUT", `/users/${id}`, userDraft({ ...draft, ...changes }))
    }

    // User 87 is the newest: first row of the default list. User 5 is on none of the pages.
    await measure("rename visible user", await save(87, { name: "Renamed" }))
    await measure("toggle active, off-page user", await save(5, { active: false }))
    await measure("change email, visible user", await save(87, { email: "renamed@example.com" }))
    await measure("change role (filtered col)", await save(87, { role: "admin" }))
    await measure("insert", () => app.action("POST", "/users", userDraft({ name: "New", email: "new@example.com" })))
    await measure("delete", () => app.action("DELETE", "/users/88"))
    await measure("rename team", () => app.action("PUT", "/teams/2", { teams: { draft: { id: 2, name: "Growth Eng" } } }))
    const bulk = (path: string, users: Record<string, unknown>) => () => app.action("POST", path, { users })
    // Users 84-82 are on page 1 of the default list, none is in team 4.
    await measure("bulk set team, 3 users", bulk("/users/bulk/update", { selection: [84, 83, 82], bulk: { field: "teamId", value: "4" } }))
    await measure("bulk set role, 3 users", bulk("/users/bulk/update", { selection: [84, 83, 82], bulk: { field: "role", value: "guest" } }))
    await measure("bulk delete, 3 users", bulk("/users/bulk/delete", { selection: [84, 83, 82] }))

    await Promise.all(streams.map((s) => s.close()))
    expect(Object.fromEntries(results.map((r) => [r.mutation, r.statements]))).toEqual({
      // read previous version + update + row re-fetch (page 1) + name-sorted view re-query (2)
      "rename visible user": 5,
      // read previous version + update; no view can show the row
      "toggle active, off-page user": 2,
      // read previous version + update + row re-fetch (page 1)
      "change email, visible user": 3,
      // read previous version + update + row re-fetch (page 1) + role-filtered view re-query (2)
      "change role (filtered col)": 5,
      // mutation + page query and COUNT per view
      "insert": 13,
      "delete": 13,
      // read previous version + update + page query, COUNT and team lookup per view. No teams
      // view is open here, but the previous version is read anyway: views in other
      // processes may need the changed columns (they travel with the broadcast).
      "rename team": 20,
      // One transaction (BEGIN, read the rows, one UPDATE, COMMIT) and one invalidation for the
      // three: page 1 re-fetches its visible rows once (1), the team-filtered view re-queries (2).
      // Three single updates would be 3 × 5.
      "bulk set team, 3 users": 7,
      // The same, with the role-filtered view re-querying instead.
      "bulk set role, 3 users": 7,
      // BEGIN, read the rows, a savepoint + DELETE + release per row, COMMIT (12); then one
      // page query and COUNT per view (12). Three single deletes would be 3 × 13.
      "bulk delete, 3 users": 24
    })
  })
})
