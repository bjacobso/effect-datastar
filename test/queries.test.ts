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
    await measure("rename team", () => app.action("PUT", "/teams/2", { teams: { draft: { id: 2, name: "Growth Eng", description: "" } } }))
    await measure("tag a visible user", await save(86, { tags: ["1", "2", "3"] }))
    await measure("rename tag", () => app.action("PUT", "/tags/1", { tags: { draft: { id: 1, name: "Remote first", color: "#2563eb" } } }))
    await measure("delete tag", () => app.action("DELETE", "/tags/5"))

    await Promise.all(streams.map((s) => s.close()))
    expect(Object.fromEntries(results.map((r) => [r.mutation, r.statements]))).toEqual({
      // Users have tags (a join table), so a user update is a transaction: BEGIN and COMMIT
      // around reading the previous version (its tags say which join rows to change) and the
      // update; the join table is touched only if the tags changed. Rows are read with their
      // tags in the same statement (a subquery), so reads cost what they did.
      //
      // BEGIN + previous version + update + COMMIT + row re-fetch (page 1) + name-sorted view re-query (2)
      "rename visible user": 7,
      // BEGIN + previous version + update + COMMIT; no view can show the row
      "toggle active, off-page user": 4,
      // BEGIN + previous version + update + COMMIT + row re-fetch (page 1)
      "change email, visible user": 5,
      // BEGIN + previous version + update + COMMIT + row re-fetch (page 1) + role-filtered view re-query (2)
      "change role (filtered col)": 7,
      // mutation (no tags: no transaction) + page query and COUNT per view
      "insert": 13,
      "delete": 13,
      // read previous version + update + the team lookup per view. A renamed team can't change
      // which users a page shows, so views re-render from the page they have (and send
      // nothing if it doesn't show the team). Was 20: page query, COUNT and lookup per view.
      // No teams view is open here, but the previous version is read anyway: views in other
      // processes may need the changed columns (they travel with the broadcast).
      "rename team": 8,
      // Tags changed on one row: a row patch, like any column. BEGIN + previous version +
      // update + DELETE and INSERT of join rows + COMMIT + a re-fetch of the row in each of the
      // three views whose page shows user 86. No page query, no COUNT.
      "tag a visible user": 9,
      // As a team rename: read previous version + update + the tag lookup per view.
      "rename tag": 8,
      // Deleting a tag deletes its join rows (ON DELETE CASCADE), which may change any page:
      // delete + page query, COUNT and both lookups per view.
      "delete tag": 25
    })
  })
})
