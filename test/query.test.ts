import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { UserQuery } from "../src/app/Users.tsx"

const decode = Schema.decodeUnknownExit(UserQuery.schema)
const query = (overrides: Record<string, unknown> = {}, filters: Record<string, string> = {}) => ({
  ...UserQuery.initial,
  ...overrides,
  filters: { ...UserQuery.initial.filters, ...filters }
})

describe("Query schema", () => {
  it("accepts the initial query", () => {
    expect(decode(UserQuery.initial)._tag).toBe("Success")
  })

  it.each([
    ["unknown sort field", query({ sort: "password" })],
    ["unknown direction", query({ dir: "sideways" })],
    ["page below 1", query({ page: 0 })],
    ["page size not offered", query({ pageSize: 7 })],
    ["enum filter outside the enum", query({}, { role: "root" })],
    ["boolean filter that is not true/false", query({}, { active: "maybe" })],
    ["non-numeric id filter", query({}, { teamId: "abc" })]
  ])("rejects %s", (_, input) => {
    expect(decode(input)._tag).toBe("Failure")
  })

  it("accepts the null sentinel and ids for a nullable relation filter", () => {
    expect(decode(query({}, { teamId: "null" }))._tag).toBe("Success")
    expect(decode(query({}, { teamId: "3" }))._tag).toBe("Success")
  })

  it("derives filter metadata from the model", () => {
    const byKey = Object.fromEntries(UserQuery.filters.map((f) => [f.key, f]))
    expect(byKey["name"]).toMatchObject({ operator: "contains", label: "Name" })
    expect(byKey["role"]).toMatchObject({ operator: "eq", kind: "enum", options: ["admin", "member", "guest"] })
    expect(byKey["teamId"]).toMatchObject({ operator: "eq", kind: "number", nullable: true, label: "Team" })
    expect(byKey["active"]).toMatchObject({ operator: "eq", kind: "boolean" })
  })
})

layer(SqliteClient.layer({ filename: ":memory:" }))("Query SQL", (it) => {
  const compile = (q: ReturnType<typeof query>) =>
    Effect.map(Effect.service(SqlClient.SqlClient), (sql) => {
      const [text, params] = sql`SELECT * FROM users ${UserQuery.where(sql, q)} ${UserQuery.orderBy(sql, q, "id")}`
        .compile()
      return { text: text.replace(/\s+/g, " ").trim(), params }
    })

  it.effect("no filters: no WHERE, stable order with id tie-breaker", () =>
    Effect.gen(function*() {
      const { text, params } = yield* compile(query())
      expect(text).toBe(`SELECT * FROM users ORDER BY "createdAt" DESC, "id" DESC`)
      expect(params).toEqual([])
    }))

  it.effect("contains filters escape LIKE wildcards", () =>
    Effect.gen(function*() {
      const { text, params } = yield* compile(query({}, { name: "50%_off" }))
      expect(text).toContain(`WHERE "name" LIKE ? ESCAPE '\\'`)
      expect(params).toEqual(["%50\\%\\_off%"])
    }))

  it.effect("eq filters are encoded with the field's DB schema", () =>
    Effect.gen(function*() {
      const { text, params } = yield* compile(query({ sort: "name", dir: "asc" }, { role: "admin", active: "true", teamId: "3" }))
      expect(text).toBe(
        `SELECT * FROM users WHERE ("role" = ? AND "teamId" = ? AND "active" = ?) ORDER BY "name" ASC, "id" ASC`
      )
      // active: boolean -> 1 via Model.BooleanSqlite
      expect(params).toEqual(["admin", 3, 1])
    }))

  it.effect("null sentinel compiles to IS NULL", () =>
    Effect.gen(function*() {
      const { text, params } = yield* compile(query({}, { teamId: "null" }))
      expect(text).toContain(`WHERE "teamId" IS NULL`)
      expect(params).toEqual([])
    }))
})
