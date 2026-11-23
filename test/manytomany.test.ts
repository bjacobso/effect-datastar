/**
 * Dates and many-to-many, at the repo level: what is stored in SQLite, how
 * tags are saved with the user (one transaction) and read back, and what a
 * tag deletion does to them.
 */
import { describe, expect, layer } from "@effect/vitest"
import { Effect, Exit, Layer, Schema } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import * as Db from "../src/app/Db.ts"
import { Resources } from "../src/app/Resources.ts"
import { Tag } from "../src/app/Tag.ts"
import { User } from "../src/app/User.ts"

const { users, tags } = Resources.resources

const env = Resources.layer.pipe(
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(Db.layer({ filename: ":memory:", seed: false }))
)

const newTag = (name: string, color: string) =>
  Effect.flatMap(tags.Repo, (repo) => repo.insert(Tag.insert.make(Schema.decodeUnknownSync(Tag.jsonCreate)({ name, color }))))

const userInput = (overrides: Record<string, unknown>) =>
  User.insert.make(Schema.decodeUnknownSync(User.jsonCreate)({
    name: "Ada",
    email: "ada@example.com",
    role: "member",
    teamId: null,
    active: true,
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
      const error = yield* Effect.flip(repo.insert(userInput({ email: "ghost@example.com", tags: [999] })))
      // The join table's foreign key failure names the field, so its message can be picked.
      expect(error._tag === "SqlError" ? error.reason.message : undefined).toContain("tags")
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
})

describe("seed", () => {
  layer(Layer.provideMerge(Resources.layer, Layer.provideMerge(Reactivity.layer, Db.layer({ filename: ":memory:" }))))(
    "seeded",
    (it) => {
      it.effect("has tags, tagged users and start dates", () =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const [counts] = yield* sql<{ tags: number; links: number; dated: number }>`
            SELECT (SELECT COUNT(*) FROM tags) AS tags, (SELECT COUNT(*) FROM user_tags) AS links,
                   (SELECT COUNT(*) FROM users WHERE startDate IS NOT NULL) AS dated`
          expect(counts!.tags).toBe(5)
          expect(counts!.links).toBeGreaterThan(50)
          expect(counts!.dated).toBeGreaterThan(50)
        }))
    }
  )
})
