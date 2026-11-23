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
 *   tenant's row.
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
})
