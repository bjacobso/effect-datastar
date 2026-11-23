import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { User } from "../src/app/User.ts"
import { Users } from "../src/app/Users.tsx"
import * as Query from "@effect-datastar/crud/Query.ts"

const UserQuery = Users.query

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
    ["non-numeric id filter", query({}, { teamId: "abc" })],
    // Numeric, but not a value of the field's schema (`TeamId` is an integer).
    ["fractional id filter", query({}, { teamId: "1.5" })],
    ["number-like but not a number", query({}, { teamId: "1e3" })],
    ["blank-padded id", query({}, { teamId: " 3" })]
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
      const [text, params] = sql`SELECT * FROM users ${UserQuery.where(sql, q, "id")} ${UserQuery.orderBy(sql, q, "id")}`
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

describe("Query URL params", () => {
  it("omits defaults", () => {
    expect(UserQuery.toSearchParams(UserQuery.initial).toString()).toBe("")
  })

  it("round-trips a non-default query", () => {
    const q = query({ page: 3, pageSize: 25, sort: "name", dir: "asc" }, { name: "ada", teamId: "null", active: "true" })
    const params = UserQuery.toSearchParams(q)
    expect(params.toString()).toBe("name=ada&teamId=null&active=true&sort=name&dir=asc&pageSize=25&page=3")
    expect(UserQuery.fromSearchParams(params)).toEqual(q)
  })

  it("ignores invalid and unknown params, keeping the rest", () => {
    const q = UserQuery.fromSearchParams(
      new URLSearchParams("sort=password&dir=asc&page=-2&pageSize=7&role=root&teamId=2&evil=1")
    )
    expect(q).toEqual(query({ dir: "asc" }, { teamId: "2" }))
  })

  it.each(["1.5", "abc", "-0.5", "1e3"])("drops a teamId the field's schema rejects (%s)", (teamId) => {
    const q = UserQuery.fromSearchParams(new URLSearchParams(`teamId=${teamId}&sort=name`))
    expect(q).toEqual(query({ sort: "name" }))
  })

  it("every query its schema accepts compiles (the filter values encode)", () => {
    for (const teamId of ["", "null", "0", "3", "-2"]) {
      expect(decode(query({}, { teamId }))._tag).toBe("Success")
    }
  })
})

describe("date ranges and many-to-many filters", () => {
  it("a range filter is two keys, each an ISO date or blank", () => {
    expect(Object.keys(UserQuery.initial.filters)).toEqual(
      expect.arrayContaining(["createdAtFrom", "createdAtTo", "tags"])
    )
    expect(UserQuery.filters.find((f) => f.key === "createdAt")).toMatchObject({
      operator: "range",
      kind: "datetime",
      params: ["createdAtFrom", "createdAtTo"]
    })
    expect(decode(query({}, { createdAtFrom: "2026-01-01", createdAtTo: "" }))._tag).toBe("Success")
    for (const bad of ["2026-02-30", "2026-1-1", "yesterday", "2026-01-01T00:00"]) {
      expect(decode(query({}, { createdAtFrom: bad }))._tag, bad).toBe("Failure")
    }
  })

  it("a has filter takes one of the related ids", () => {
    expect(UserQuery.filters.find((f) => f.key === "tags")).toMatchObject({ operator: "has", kind: "ids" })
    expect(decode(query({}, { tags: "3" }))._tag).toBe("Success")
    expect(decode(query({}, { tags: "x" }))._tag).toBe("Failure")
    expect(decode(query({}, { tags: "1.5" }))._tag).toBe("Failure")
  })

  it("round-trips through the URL, dropping invalid dates", () => {
    const q = query({}, { createdAtFrom: "2026-01-01", createdAtTo: "2026-01-31", tags: "2" })
    const params = UserQuery.toSearchParams(q)
    expect(params.toString()).toBe("tags=2&createdAtFrom=2026-01-01&createdAtTo=2026-01-31")
    expect(UserQuery.fromSearchParams(params)).toEqual(q)
    expect(UserQuery.fromSearchParams(new URLSearchParams("createdAtFrom=2026-13-01&createdAtTo=2026-02-01")))
      .toEqual(query({}, { createdAtTo: "2026-02-01" }))
  })

  it("range and has filters count as query columns (they decide which rows match)", () => {
    expect(UserQuery.columns(query({}, { createdAtTo: "2026-01-31", tags: "1" }))).toEqual(["createdAt", "tags", "createdAt"])
  })

  it("rejects a range on a non-date field, and has on a plain field", () => {
    const config = { sortable: ["name"], defaultSort: ["name", "asc"], pageSizes: [10] } as const
    expect(() => Query.make(User, { ...config, filters: { name: "range" } })).toThrow("is not a date")
    expect(() => Query.make(User, { ...config, filters: { name: "has" } })).toThrow("is not many-to-many")
    expect(() => Query.make(User, { ...config, filters: { tags: "eq" } })).toThrow("use has")
  })
})

layer(SqliteClient.layer({ filename: ":memory:" }))("date range and has SQL", (it) => {
  const compile = (q: ReturnType<typeof query>) =>
    Effect.map(Effect.service(SqlClient.SqlClient), (sql) => {
      const [text, params] = sql`SELECT * FROM users ${UserQuery.where(sql, q, "id")}`.compile()
      return { text: text.replace(/\s+/g, " ").trim(), params }
    })

  it.effect("a datetime range compares ISO text; the `to` day is inclusive", () =>
    Effect.gen(function*() {
      const { text, params } = yield* compile(query({}, { createdAtFrom: "2026-01-01", createdAtTo: "2026-01-31" }))
      expect(text).toBe(`SELECT * FROM users WHERE ("createdAt" >= ? AND "createdAt" < ?)`)
      expect(params).toEqual(["2026-01-01", "2026-02-01"])
    }))

  it.effect("either end may be blank", () =>
    Effect.gen(function*() {
      expect((yield* compile(query({}, { createdAtTo: "2026-12-31" }))).params).toEqual(["2027-01-01"])
      expect((yield* compile(query({}, { createdAtFrom: "2026-03-01" }))).text).toContain(`WHERE "createdAt" >= ?`)
    }))

  it.effect("has: rows whose join table holds the id", () =>
    Effect.gen(function*() {
      const { text, params } = yield* compile(query({}, { tags: "3" }))
      expect(text).toBe(`SELECT * FROM users WHERE "id" IN (SELECT "userId" FROM "user_tags" WHERE "tagId" = ?)`)
      expect(params).toEqual([3])
    }))
})
