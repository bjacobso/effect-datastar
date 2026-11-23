/**
 * Dates and many-to-many, at the repo level: what is stored in SQLite, how
 * tags are saved with the user (one transaction) and read back, and what a
 * tag deletion does to them. Tags and users are tenant-scoped: everything here
 * runs as organization 1 (see `tenant.test.ts` for across organizations).
 */
import { describe, expect, layer } from "@effect/vitest"
import { Effect, Exit, Layer, Schema } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import * as Db from "../src/app/Db.ts"
import type { OrgId } from "../src/app/Org.ts"
import { Resources } from "../src/app/Resources.ts"
import { Tag } from "../src/app/Tag.ts"
import { User } from "../src/app/User.ts"
import { CurrentOrg } from "../src/auth/Auth.ts"
import * as Repo from "@effect-datastar/crud/Repo.ts"

const { users, tags } = Resources.resources

/** An unseeded database with one organization, which every test runs as. */
const org = Layer.effectDiscard(Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  sql`INSERT INTO orgs (name, createdAt) VALUES ('Acme', '2025-06-01T00:00:00.000Z')`))
const env = Resources.layer.pipe(
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(Layer.merge(Layer.succeed(CurrentOrg, { id: 1 as OrgId, name: "Acme" }), org)),
  Layer.provideMerge(Db.layer({ filename: ":memory:", seed: false }))
)

const newTag = (name: string, color: string) =>
  Effect.flatMap(tags.Repo, (repo) => repo.insert(Tag.insert.make(Schema.decodeUnknownSync(Tag.jsonCreate)({ name, color, orgId: 1 }))))

const userInput = (overrides: Record<string, unknown>) =>
  User.insert.make(Schema.decodeUnknownSync(User.jsonCreate)({
    name: "Ada",
    email: "ada@example.com",
    role: "member",
    teamId: null,
    active: true,
    orgId: 1,
    startDate: null,
    tags: [],
    ...overrides
  }))

const joinRows = (userId: number) =>
  Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
    sql<{ tagId: number }>`SELECT tagId FROM user_tags WHERE userId = ${userId} ORDER BY tagId`.pipe(
      Effect.map((rows) => rows.map((r) => r.tagId))
    ))

layer(env)("dates and many-to-many in SQLite", (it) => {
  it.effect("a date-only field is stored as ISO text and read back as the same string", () =>
    Effect.gen(function*() {
      const repo = yield* users.Repo
      const sql = yield* SqlClient.SqlClient
      const user = yield* repo.insert(userInput({ email: "date@example.com", startDate: "2026-03-01" }))
      expect(user.startDate).toBe("2026-03-01")
      const [stored] = yield* sql<{ startDate: unknown; type: string }>`
        SELECT startDate, typeof(startDate) AS type FROM users WHERE id = ${user.id}`
      expect(stored).toEqual({ startDate: "2026-03-01", type: "text" })
      // `createdAt` (DateTime.Utc) is ISO text too, so ranges compare as text.
      const [created] = yield* sql<{ createdAt: string }>`SELECT createdAt FROM users WHERE id = ${user.id}`
      expect(created!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      const cleared = yield* repo.update(User.update.make({ ...user, startDate: null }))
      expect(cleared.startDate).toBeNull()
    }))

  it.effect("tags are saved with the user and read back sorted, on every read path", () =>
    Effect.gen(function*() {
      const repo = yield* users.Repo
      const a = yield* newTag("A", "#111111")
      const b = yield* newTag("B", "#222222")
      const c = yield* newTag("C", "#333333")
      const user = yield* repo.insert(userInput({ email: "tags@example.com", tags: [c.id, a.id] }))
      expect(user.tags).toEqual([a.id, c.id])
      expect(yield* joinRows(user.id)).toEqual([a.id, c.id])
      expect((yield* repo.findById(user.id)).tags).toEqual([a.id, c.id])

      // Update: only the difference is written.
      const updated = yield* repo.update(User.update.make({ ...user, tags: [b.id, c.id, b.id] }))
      expect(updated.tags).toEqual([b.id, c.id])
      expect(yield* joinRows(user.id)).toEqual([b.id, c.id])

      const page = yield* repo.list({ ...users.query.initial, filters: { ...users.query.initial.filters, tags: String(b.id) } })
      expect(page.rows.map((r) => [r.email, r.tags])).toEqual([["tags@example.com", [b.id, c.id]]])
    }))

  it.effect("a missing tag fails the whole save: no user row, no join rows", () =>
    Effect.gen(function*() {
      const repo = yield* users.Repo
      const sql = yield* SqlClient.SqlClient
      const exit = yield* Effect.exit(repo.insert(userInput({ email: "ghost@example.com", tags: [999] })))
      expect(Exit.isFailure(exit)).toBe(true)
      // Checked against the organization's tags before anything is written, like a team.
      const error = yield* Effect.flip(repo.insert(userInput({ email: "ghost@example.com", tags: [999] })))
      expect(error).toEqual(new Repo.InvalidReference({ column: "tags" }))
      const rows = yield* sql`SELECT id FROM users WHERE email = ${"ghost@example.com"}`
      expect(rows).toEqual([])
    }))

  it.effect("deleting a tag deletes its join rows (ON DELETE CASCADE); deleting a user too", () =>
    Effect.gen(function*() {
      const repo = yield* users.Repo
      const sql = yield* SqlClient.SqlClient
      const x = yield* newTag("X", "#444444")
      const y = yield* newTag("Y", "#555555")
      const user = yield* repo.insert(userInput({ email: "cascade@example.com", tags: [x.id, y.id] }))
      yield* (yield* tags.Repo).delete(x.id)
      expect((yield* repo.findById(user.id)).tags).toEqual([y.id])
      yield* repo.delete(user.id)
      expect(yield* sql`SELECT * FROM user_tags WHERE userId = ${user.id}`).toEqual([])
    }))

  it.effect("a bulk delete of users deletes their join rows too, and leaves others' alone", () =>
    Effect.gen(function*() {
      const repo = yield* users.Repo
      const sql = yield* SqlClient.SqlClient
      const t = yield* newTag("Bulk", "#666666")
      const [a, b, kept] = yield* Effect.forEach(["bulk.a", "bulk.b", "bulk.kept"], (name) =>
        repo.insert(userInput({ email: `${name}@example.com`, tags: [t.id] })))
      const result = yield* repo.deleteMany([a!.id, b!.id])
      expect(result).toEqual({ done: [a!.id, b!.id], missing: [], restricted: [] })
      expect(yield* sql`SELECT userId FROM user_tags WHERE tagId = ${t.id}`).toEqual([{ userId: kept!.id }])
    }))
})

describe("seed", () => {
  layer(Layer.provideMerge(Resources.layer, Layer.provideMerge(Reactivity.layer, Db.layer({ filename: ":memory:" }))))(
    "seeded",
    (it) => {
      it.effect("has tags, tagged users and start dates; every link stays in its organization", () =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const [counts] = yield* sql<{ tags: number; links: number; dated: number }>`
            SELECT (SELECT COUNT(*) FROM tags) AS tags, (SELECT COUNT(*) FROM user_tags) AS links,
                   (SELECT COUNT(*) FROM users WHERE startDate IS NOT NULL) AS dated`
          // Acme five, Globex three.
          expect(counts!.tags).toBe(8)
          expect(counts!.links).toBeGreaterThan(50)
          expect(counts!.dated).toBeGreaterThan(50)
          const crossed = yield* sql`SELECT 1 FROM user_tags ut JOIN users u ON u.id = ut.userId JOIN tags t ON t.id = ut.tagId
            WHERE u.orgId != t.orgId OR ut.orgId != u.orgId`
          expect(crossed).toEqual([])
        }))
    }
  )
})
