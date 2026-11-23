/**
 * Tenant scoping at the `Repo` level (`crud/Scope.ts`):
 *
 * - Per-tenant reactivity keys, measured: six live views open in Acme, then
 *   Globex mutates its own rows. With shared keys (`isolateKeys: false`) the
 *   Acme views are woken and re-query (their own rows only); with per-tenant
 *   keys (the default) they never wake. Prints a table:
 *   `npx vitest run test/tenant-repo.test.ts --silent=false`.
 * - References: with a plain foreign key (no composite `(teamId, orgId)` key
 *   like the app's), only the repo's check stops a reference to another
 *   tenant's row. The same goes for bulk updates.
 * - Bulk changes: only the current tenant's rows, the tenant column is never
 *   set, and the one invalidation is on the tenant's key.
 */
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { afterAll } from "vitest"
import * as Db from "../src/app/Db.ts"
import type { OrgId } from "../src/app/Org.ts"
import type { TeamId } from "../src/app/Team.ts"
import { User } from "../src/app/User.ts"
import { Users } from "../src/app/Users.tsx"
import { CurrentOrg } from "../src/auth/Auth.ts"
import * as Repo from "../src/crud/Repo.ts"
import * as Payload from "../src/reactivity/Payload.ts"
import type * as Scope from "../src/crud/Scope.ts"
import { sqlLog } from "./sqlCounter.ts"

const acme = Effect.provideService(CurrentOrg, { id: 1 as OrgId, name: "Acme" })
const globex = Effect.provideService(CurrentOrg, { id: 2 as OrgId, name: "Globex" })

const scope = (isolateKeys: boolean): Scope.Scope<CurrentOrg> => ({
  column: "orgId",
  value: Effect.map(Effect.service(CurrentOrg), (org) => ({ id: org.id, encoded: org.id })),
  isolateKeys
})
const teams: Scope.ReferenceTarget = { table: "teams", idColumn: "id", tenantColumn: "orgId" }

const makeRepo = (isolateKeys: boolean, references = [["teamId", teams] as const]) =>
  Repo.make(User, { table: "users", idColumn: "id", query: Users.query, scope: scope(isolateKeys), references })

const newUser = (name: string, teamId: number | null = null) =>
  User.insert.make({
    name,
    email: `${name.toLowerCase().replace(/\W/g, ".")}@example.com`,
    role: "member",
    teamId: teamId as TeamId | null,
    active: true,
    orgId: 1 as OrgId
  })

/** Six views, as in `queries.test.ts`: three pages, sorted by name, filtered by role, filtered by team. */
const initial = Users.query.initial
const views: ReadonlyArray<typeof initial> = [
  initial,
  { ...initial, page: 2 },
  { ...initial, page: 3 },
  { ...initial, sort: "name", dir: "asc" },
  { ...initial, filters: { ...initial.filters, role: "admin" } },
  { ...initial, filters: { ...initial.filters, teamId: "2" } }
]

const results: Array<{ mutation: string; "shared keys": number; "per-tenant keys": number }> = []
afterAll(() => {
  console.table(results)
})

/** Statements the views run (page queries, COUNTs, row re-fetches), not the mutations' own. */
const viewStatements = () =>
  sqlLog.statements.filter((s) => /SELECT \* FROM "users"[^]*LIMIT|COUNT\(\*\)|"id" IN/.test(s)).length

const measure = (isolateKeys: boolean) =>
  Effect.gen(function*() {
    const repo = yield* makeRepo(isolateKeys)
    const pages: Array<ReadonlyArray<{ readonly orgId: number }>> = []
    for (const q of views) {
      yield* repo.live(q).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => pages.push(event._tag === "Page" ? event.page.rows : event.rows))
        ),
        acme,
        Effect.forkScoped
      )
    }
    yield* Effect.sleep("150 millis")
    const counts: Record<string, number> = {}
    const run = (name: string, mutation: Effect.Effect<unknown, unknown, CurrentOrg>) =>
      Effect.gen(function*() {
        sqlLog.reset()
        yield* globex(mutation)
        yield* Effect.sleep("150 millis")
        counts[name] = viewStatements()
      })
    // Globex inserts into its team 4 and changes its user 3 (on none of Acme's pages).
    yield* run("insert", repo.insert(newUser("Globex New", 4)))
    yield* run("rename (sorted column of one view)", Effect.flatMap(repo.findById(3 as User["id"]), (u) => repo.update(User.update.make({ ...u, name: "Renamed" }))))
    yield* run("change role (filtered column)", Effect.flatMap(repo.findById(3 as User["id"]), (u) => repo.update(User.update.make({ ...u, role: "admin" }))))
    yield* run("toggle active (no query column)", Effect.flatMap(repo.findById(3 as User["id"]), (u) => repo.update(User.update.make({ ...u, active: !u.active }))))
    yield* run("delete", repo.delete(3 as User["id"]))
    // Whatever the views were woken for, they only ever saw Acme's rows.
    expect(pages.length).toBeGreaterThan(0)
    expect(pages.flat().every((row) => row.orgId === 1)).toBe(true)
    return counts
  })

const database = Db.layer({ filename: ":memory:" })

describe("per-tenant reactivity keys", () => {
  it.live("another tenant's changes don't wake the views at all", () =>
    Effect.gen(function*() {
      const shared = yield* measure(false).pipe(Effect.provide(Layer.mergeAll(database, Reactivity.layer)))
      const isolated = yield* measure(true).pipe(Effect.provide(Layer.mergeAll(database, Reactivity.layer)))
      for (const mutation of Object.keys(shared)) {
        results.push({ mutation, "shared keys": shared[mutation]!, "per-tenant keys": isolated[mutation]! })
      }
      expect(Object.values(isolated).every((n) => n === 0)).toBe(true)
      expect(shared).toEqual({
        // page query + COUNT in every view
        "insert": 12,
        // the name-sorted view re-queries; the others skip (the row isn't on their page)
        "rename (sorted column of one view)": 2,
        // the role-filtered view re-queries
        "change role (filtered column)": 2,
        // nobody shows the row: skipped without a query
        "toggle active (no query column)": 0,
        "delete": 12
      })
    }), { timeout: 20_000 })
})

describe("references", () => {
  /** Two tenants, a team each, and a plain foreign key from users to teams. */
  const plainDatabase = Layer.effectDiscard(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`CREATE TABLE teams (id INTEGER PRIMARY KEY, orgId INTEGER NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL)`
    yield* sql`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, orgId INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
      role TEXT NOT NULL, active INTEGER NOT NULL, createdAt TEXT NOT NULL, teamId INTEGER REFERENCES teams(id))`
    yield* sql`INSERT INTO teams VALUES (1, 1, 'Acme Team', '2025-01-01'), (2, 2, 'Globex Team', '2025-01-01')`
  })).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })), Layer.merge(Reactivity.layer))

  it.live("a plain foreign key accepts another tenant's team; the repo's check doesn't", () =>
    Effect.gen(function*() {
      const unchecked = yield* makeRepo(true, [])
      const checked = yield* makeRepo(true)
      const leaked = yield* acme(unchecked.insert(newUser("Leaked", 2)))
      expect(leaked.teamId).toBe(2)

      const rejected = yield* acme(Effect.exit(checked.insert(newUser("Rejected", 2))))
      expect(rejected).toEqual(Exit.fail(new Repo.InvalidReference({ column: "teamId" })))
      const own = yield* acme(checked.insert(newUser("Own Team", 1)))
      expect(own).toMatchObject({ teamId: 1, orgId: 1 })

      const moved = yield* acme(Effect.exit(checked.update(User.update.make({ ...own, teamId: 2 as TeamId }))))
      expect(moved).toEqual(Exit.fail(new Repo.InvalidReference({ column: "teamId" })))
      // A row of another tenant doesn't exist for writes either.
      const theirs = yield* globex(Effect.exit(checked.update(User.update.make({ ...own, name: "Theirs" }))))
      expect(Exit.isFailure(theirs) && JSON.stringify(theirs.cause)).toContain("NoSuchElementError")
    }).pipe(Effect.provide(plainDatabase)))

  it.live("a bulk update with another tenant's team is rejected by the repo's check, and changes nothing", () =>
    Effect.gen(function*() {
      const unchecked = yield* makeRepo(true, [])
      const checked = yield* makeRepo(true)
      const a = yield* acme(checked.insert(newUser("Bulk One", 1)))
      const b = yield* acme(checked.insert(newUser("Bulk Two", null)))
      const patch = { teamId: 2 as TeamId }
      // Without the check, the plain foreign key lets the rows point into the other tenant.
      const leaked = yield* acme(unchecked.updateMany([b.id], patch))
      expect(leaked.done).toEqual([b.id])
      yield* acme(checked.updateMany([b.id], { teamId: null }))

      const rejected = yield* acme(Effect.flip(checked.updateMany([a.id, b.id], patch)))
      expect(rejected).toEqual(new Repo.InvalidReference({ column: "teamId" }))
      expect(yield* acme(checked.findById(a.id))).toMatchObject({ teamId: 1 })
      expect(yield* acme(checked.findById(b.id))).toMatchObject({ teamId: null })
      // Its own team is fine.
      const moved = yield* acme(checked.updateMany([a.id, b.id], { teamId: 1 as TeamId }))
      expect(moved).toEqual({ done: [a.id, b.id], missing: [], restricted: [] })
    }).pipe(Effect.provide(plainDatabase)))
})

describe("bulk changes", () => {
  /** Every invalidation the repo makes, with its payload. */
  const invalidations: Array<{ readonly keys: Payload.Keys; readonly payload: unknown }> = []
  const recording = Layer.succeed(Payload.InvalidationPayload, {
    invalidateUnsafe: (keys, payload) => invalidations.push({ keys, payload }),
    current: () => undefined,
    crossProcess: false
  })

  it.live("touch only the current tenant's rows, never set the tenant, and invalidate the tenant's key once", () =>
    Effect.gen(function*() {
      const repo = yield* makeRepo(true)
      // Seeded: users 1 and 2 are Acme's, 3 and 4 Globex's.
      const ids = [1, 2, 3, 4] as Array<User["id"]>
      const before = yield* globex(Effect.forEach([3, 4] as Array<User["id"]>, repo.findById))
      invalidations.length = 0

      // The tenant column in the patch is ignored, like the id.
      const patch = { name: "Bulk Renamed", orgId: 2 as OrgId } as Partial<typeof User.update.Type>
      const updated = yield* acme(repo.updateMany(ids, patch))
      expect(updated).toEqual({ done: [1, 2], missing: [3, 4], restricted: [] })
      for (const id of [1, 2] as Array<User["id"]>) {
        expect(yield* acme(repo.findById(id))).toMatchObject({ name: "Bulk Renamed", orgId: 1 })
      }
      expect(yield* globex(Effect.forEach([3, 4] as Array<User["id"]>, repo.findById))).toEqual(before)
      // Only the tenant column: nothing to do, nothing changes.
      expect(yield* acme(repo.updateMany([1] as Array<User["id"]>, { orgId: 2 as OrgId }))).toMatchObject({ done: [1] })
      expect(yield* acme(repo.findById(1 as User["id"]))).toMatchObject({ orgId: 1 })

      const deleted = yield* acme(repo.deleteMany([2, 3, 4] as Array<User["id"]>))
      expect(deleted).toEqual({ done: [2], missing: [3, 4], restricted: [] })
      expect(yield* globex(Effect.forEach([3, 4] as Array<User["id"]>, repo.findById))).toEqual(before)
      // Nothing of the other tenant's: no invalidation at all.
      expect(yield* globex(repo.deleteMany([1] as Array<User["id"]>))).toEqual({ done: [], missing: [1], restricted: [] })

      // One invalidation per bulk change, on Acme's key, with a change per row.
      expect(invalidations).toEqual([
        {
          keys: { "users[orgId=1]": [1, 2] },
          payload: {
            table: "users",
            changes: [{ _tag: "Update", id: 1, columns: ["name"] }, { _tag: "Update", id: 2, columns: ["name"] }]
          }
        },
        // The tenant-only patch: the row goes along with no columns (streams skip it).
        { keys: { "users[orgId=1]": [1] }, payload: { table: "users", changes: [{ _tag: "Update", id: 1, columns: [] }] } },
        { keys: { "users[orgId=1]": [2] }, payload: { table: "users", changes: [{ _tag: "Delete", id: 2 }] } }
      ])
    }).pipe(Effect.provide(Layer.mergeAll(Db.layer({ filename: ":memory:" }), Reactivity.layer, recording))))
})
