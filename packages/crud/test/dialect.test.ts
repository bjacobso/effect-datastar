import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { Reactivity } from "effect/reactivity"
import { Model } from "effect/schema"
import { SqlClient, SqlError, Statement } from "effect/sql"
import {
  PostgresDialect,
  PostgresDialectLayer,
  SqlDialect,
  SqliteDialect,
  SqliteDialectLayer
} from "../src/Dialect.ts"
import * as Field from "../src/Field.ts"
import * as ManyToMany from "../src/ManyToMany.ts"
import * as Query from "../src/Query.ts"
import * as Repo from "../src/Repo.ts"

// --- mock SQL compilers & client for unit tests ------------------------------

const sqliteCompiler = Statement.makeCompilerSqlite()

const pgCompiler = Statement.makeCompiler({
  dialect: "pg",
  placeholder: (i) => `$${i}`,
  onIdentifier: Statement.defaultEscape("\""),
  onRecordUpdate: () => ["", []],
  onCustom: () => ["", []]
})

const makeMockSqlClient = (
  compiler: Statement.Compiler,
  handler: (sql: string, params: ReadonlyArray<unknown>) => Effect.Effect<ReadonlyArray<any>, SqlError.SqlError>
): SqlClient.SqlClient => {
  const execute = (sql: string, params: ReadonlyArray<unknown>) => handler(sql, params)
  const conn = {
    execute,
    executeRaw: execute,
    executeWithoutTransform: execute,
    executeValues: (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.map(execute(sql, params), (rows) => rows.map((r) => Object.values(r as Record<string, unknown>))),
    executeUnprepared: execute,
    executeStream: () => {
      throw new Error("not implemented")
    }
  }
  const acquirer = Effect.succeed(conn as any)
  const sql = ((strings: TemplateStringsArray, ...args: Array<any>) =>
    Statement.statement(acquirer, compiler, strings, args, [], undefined)) as unknown as SqlClient.SqlClient

  const fn = Object.assign(
    (stringsOrId: any, ...args: Array<any>) => {
      if (Array.isArray(stringsOrId) && "raw" in stringsOrId) {
        return Statement.statement(acquirer, compiler, stringsOrId as TemplateStringsArray, args, [], undefined)
      }
      return Statement.identifier(stringsOrId as string)
    },
    {
      literal: (value: string) => Statement.fragment([Statement.literal(value)]),
      in: (columnOrValues: any, values?: any) => {
        if (values !== undefined) {
          return Statement.fragment([
            Statement.identifier(columnOrValues),
            Statement.literal(" IN "),
            Statement.arrayHelper(values)
          ])
        }
        return Statement.fragment([Statement.arrayHelper(columnOrValues)])
      },
      and: Statement.and,
      or: Statement.or,
      csv: Statement.csv,
      insert: (value: any) => Statement.fragment([Statement.recordInsertHelper((Array.isArray(value) ? value : [value]) as any)]),
      update: (value: any, omit?: ReadonlyArray<string>) =>
        Statement.fragment([Statement.recordUpdateHelperSingle(value, omit ?? [])]),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      reserve: acquirer,
      safeIntegers: false,
      onDialect: (cases: Record<string, () => any>) => (cases[compiler.dialect] ?? cases.sqlite)!(),
      onDialectOrElse: (cases: Record<string, () => any>) => (cases[compiler.dialect] ?? cases.orElse)!()
    }
  )
  void sql
  return fn as unknown as SqlClient.SqlClient
}

const sqliteSql = makeMockSqlClient(sqliteCompiler, () => Effect.succeed([]))
const pgSql = makeMockSqlClient(pgCompiler, () => Effect.succeed([]))

const compile = (compiler: Statement.Compiler, fragment: Statement.Fragment) => compiler.compile(fragment, false)

// --- sample model & link for Repo / ManyToMany tests -------------------------

const TagId = Schema.Int.pipe(Schema.brand("TagId"))

class Item extends Model.Class<Item>("Item")({
  id: Model.Field({ select: Schema.Int, update: Schema.Int, json: Schema.Int }),
  name: Schema.String,
  tags: ManyToMany.Ids(TagId, { table: "item_tags", from: "itemId", to: "tagId" })
}) {}

const ItemQuery = Query.make(Item, {
  sortable: ["name"],
  filters: { name: "contains", tags: "has" },
  defaultSort: ["name", "asc"],
  pageSizes: [10, 25]
})

const tagsLink = Field.links(Item.fields)[0]!

// --- tests -------------------------------------------------------------------

describe("SqlDialect primitives", () => {
  it("quotes identifiers and formats placeholders per dialect", () => {
    expect(SqliteDialect.name).toBe("sqlite")
    expect(PostgresDialect.name).toBe("postgres")

    expect(SqliteDialect.quoteIdentifier("users")).toBe("\"users\"")
    expect(SqliteDialect.quoteIdentifier("users.id")).toBe("\"users\".\"id\"")
    expect(PostgresDialect.quoteIdentifier("my\"col")).toBe("\"my\"\"col\"")

    expect(SqliteDialect.placeholder(1)).toBe("?")
    expect(SqliteDialect.placeholder(3)).toBe("?")
    expect(PostgresDialect.placeholder(1)).toBe("$1")
    expect(PostgresDialect.placeholder(3)).toBe("$3")
  })

  it("encodes booleans, decodes counts, and parses JSON arrays", () => {
    expect(SqliteDialect.encodeBoolean(true)).toBe(1)
    expect(SqliteDialect.encodeBoolean(false)).toBe(0)
    expect(PostgresDialect.encodeBoolean(true)).toBe(true)
    expect(PostgresDialect.encodeBoolean(false)).toBe(false)

    for (const d of [SqliteDialect, PostgresDialect]) {
      expect(d.decodeCount(42)).toBe(42)
      expect(d.decodeCount(42n)).toBe(42)
      expect(d.decodeCount("42")).toBe(42)
      expect(d.decodeCount(undefined)).toBe(0)
      expect(d.decodeCount(null)).toBe(0)

      expect(d.parseJsonArray("[1,2,3]")).toEqual([1, 2, 3])
      expect(d.parseJsonArray([1, 2, 3])).toEqual([1, 2, 3])
      expect(d.parseJsonArray(null)).toEqual([])
      expect(d.parseJsonArray("not-json")).toEqual([])
    }
  })

  it("generates case-insensitive contains predicates with escaped LIKE wildcards", () => {
    const [sqliteText, sqliteParams] = compile(sqliteCompiler, SqliteDialect.contains(sqliteSql, "name", "50%_off\\x"))
    expect(sqliteText).toBe("\"name\" LIKE ? ESCAPE '\\'")
    expect(sqliteParams).toEqual(["%50\\%\\_off\\\\x%"])

    const [pgText, pgParams] = compile(pgCompiler, PostgresDialect.contains(pgSql, "name", "50%_off\\x"))
    expect(pgText).toBe("\"name\" ILIKE $1 ESCAPE '\\'")
    expect(pgParams).toEqual(["%50\\%\\_off\\\\x%"])
  })

  it("generates dialect-specific correlated JSON array subqueries", () => {
    const opts = {
      joinTable: "user_tags",
      fromColumn: "userId",
      toColumn: "tagId",
      parentTable: "users",
      parentIdColumn: "id",
      alias: "tags"
    }

    const [sqliteText] = compile(sqliteCompiler, SqliteDialect.jsonArraySubquery(sqliteSql, opts))
    expect(sqliteText).toContain("json_group_array(\"tagId\")")
    expect(sqliteText).toContain("FROM \"user_tags\"")
    expect(sqliteText).toContain("WHERE \"userId\" = \"users\".\"id\" ORDER BY \"tagId\"")
    expect(sqliteText).toContain("AS \"tags\"")

    const [pgText] = compile(pgCompiler, PostgresDialect.jsonArraySubquery(pgSql, opts))
    expect(pgText).toContain("COALESCE(json_agg(\"tagId\" ORDER BY \"tagId\"), '[]'::json)")
    expect(pgText).toContain("FROM \"user_tags\"")
    expect(pgText).toContain("WHERE \"userId\" = \"users\".\"id\"")
    expect(pgText).toContain("AS \"tags\"")
    expect(pgText).not.toContain("json_group_array")
  })
})

describe("SqlDialect constraint error classification", () => {
  it("classifies SQLite unique, foreign-key, not-null, and check errors", () => {
    const uniqueReason = new SqlError.SqlError({
      reason: new SqlError.UniqueViolation({
        cause: { code: "SQLITE_CONSTRAINT_UNIQUE", errcode: 2067, message: "UNIQUE constraint failed: users.email" },
        constraint: "users.email",
        message: "UNIQUE constraint failed: users.email"
      })
    })
    expect(SqliteDialect.classifyError(uniqueReason)).toEqual({
      _tag: "UniqueViolation",
      constraint: "users.email",
      column: "email",
      columns: ["email"]
    })
    expect(SqliteDialect.isUniqueViolation(uniqueReason)).toBe(true)
    expect(SqliteDialect.isForeignKeyRestrict(uniqueReason)).toBe(false)
    expect(SqliteDialect.isInvalidReference(uniqueReason)).toBe(false)

    const compositeUnique = new SqlError.SqlError({
      reason: new SqlError.UnknownError({
        cause: { code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: users.orgId, users.email" }
      })
    })
    expect(SqliteDialect.classifyError(compositeUnique)).toEqual({
      _tag: "UniqueViolation",
      constraint: "users.orgId, users.email",
      column: "orgId",
      columns: ["orgId", "email"]
    })

    const fkGeneric = new SqlError.SqlError({
      reason: new SqlError.ConstraintError({
        cause: { code: "SQLITE_CONSTRAINT_FOREIGNKEY", errcode: 787 },
        message: "FOREIGN KEY constraint failed"
      })
    })
    expect(SqliteDialect.classifyError(fkGeneric)).toEqual({
      _tag: "ForeignKeyViolation",
      kind: "unknown"
    })
    expect(SqliteDialect.isForeignKeyRestrict(fkGeneric)).toBe(true)
    expect(SqliteDialect.isInvalidReference(fkGeneric)).toBe(true)

    const fkNamed = new SqlError.SqlError({
      reason: new SqlError.ConstraintError({
        cause: { code: "SQLITE_CONSTRAINT_FOREIGNKEY" },
        message: "FOREIGN KEY constraint failed: tags"
      })
    })
    expect(SqliteDialect.classifyError(fkNamed)).toEqual({
      _tag: "ForeignKeyViolation",
      kind: "invalidReference",
      column: "tags"
    })
    expect(SqliteDialect.isInvalidReference(fkNamed)).toBe(true)
    expect(SqliteDialect.isForeignKeyRestrict(fkNamed)).toBe(false)

    const notNull = new SqlError.SqlError({
      reason: new SqlError.ConstraintError({
        cause: { code: "SQLITE_CONSTRAINT_NOTNULL", message: "NOT NULL constraint failed: users.name" }
      })
    })
    expect(SqliteDialect.classifyError(notNull)).toEqual({
      _tag: "NotNullViolation",
      column: "name"
    })
    expect(SqliteDialect.isForeignKeyRestrict(notNull)).toBe(false)

    const checkErr = new SqlError.SqlError({
      reason: new SqlError.ConstraintError({
        cause: { code: "SQLITE_CONSTRAINT_CHECK", message: "CHECK constraint failed: age_positive" }
      })
    })
    expect(SqliteDialect.classifyError(checkErr)).toEqual({
      _tag: "CheckViolation",
      constraint: "age_positive"
    })

    const connErr = new SqlError.SqlError({
      reason: new SqlError.ConnectionError({ cause: new Error("ECONNREFUSED") })
    })
    expect(SqliteDialect.classifyError(connErr)).toBeUndefined()
    expect(SqliteDialect.isUniqueViolation(connErr)).toBe(false)
    expect(SqliteDialect.isForeignKeyRestrict(connErr)).toBe(false)
    expect(SqliteDialect.isInvalidReference(connErr)).toBe(false)
  })

  it("classifies Postgres SQLSTATE 23505, 23503, 23502, and 23514 errors", () => {
    const pgUnique = new SqlError.SqlError({
      reason: new SqlError.UnknownError({
        cause: {
          code: "23505",
          constraint: "users_email_key",
          detail: "Key (email)=(ada@acme.test) already exists."
        }
      })
    })
    expect(PostgresDialect.classifyError(pgUnique)).toEqual({
      _tag: "UniqueViolation",
      constraint: "users_email_key",
      column: "email",
      columns: ["email"]
    })
    expect(PostgresDialect.isUniqueViolation(pgUnique)).toBe(true)
    expect(PostgresDialect.isForeignKeyRestrict(pgUnique)).toBe(false)

    const pgCompositeUnique = new SqlError.SqlError({
      reason: new SqlError.UniqueViolation({
        constraint: "users_org_email_key",
        cause: {
          code: "23505",
          constraint: "users_org_email_key",
          detail: "Key (\"orgId\", email)=(1, ada@acme.test) already exists."
        }
      })
    })
    expect(PostgresDialect.classifyError(pgCompositeUnique)).toEqual({
      _tag: "UniqueViolation",
      constraint: "users_org_email_key",
      column: "orgId",
      columns: ["orgId", "email"]
    })

    const pgFkInvalidRef = new SqlError.SqlError({
      reason: new SqlError.ConstraintError({
        cause: {
          code: "23503",
          constraint: "users_teamId_fkey",
          detail: "Key (teamId)=(999) is not present in table \"teams\"."
        }
      })
    })
    expect(PostgresDialect.classifyError(pgFkInvalidRef)).toEqual({
      _tag: "ForeignKeyViolation",
      kind: "invalidReference",
      constraint: "users_teamId_fkey",
      column: "teamId"
    })
    expect(PostgresDialect.isInvalidReference(pgFkInvalidRef)).toBe(true)
    expect(PostgresDialect.isForeignKeyRestrict(pgFkInvalidRef)).toBe(false)

    const pgFkRestrict = new SqlError.SqlError({
      reason: new SqlError.ConstraintError({
        cause: {
          code: "23503",
          constraint: "users_teamId_fkey",
          detail: "Key (id)=(2) is still referenced from table \"users\"."
        }
      })
    })
    expect(PostgresDialect.classifyError(pgFkRestrict)).toEqual({
      _tag: "ForeignKeyViolation",
      kind: "restrict",
      constraint: "users_teamId_fkey",
      column: "id"
    })
    expect(PostgresDialect.isForeignKeyRestrict(pgFkRestrict)).toBe(true)
    expect(PostgresDialect.isInvalidReference(pgFkRestrict)).toBe(false)

    const pgNotNull = new SqlError.SqlError({
      reason: new SqlError.ConstraintError({
        cause: { code: "23502", column: "email", message: "null value in column \"email\" violates not-null constraint" }
      })
    })
    expect(PostgresDialect.classifyError(pgNotNull)).toEqual({
      _tag: "NotNullViolation",
      column: "email"
    })
    expect(PostgresDialect.isForeignKeyRestrict(pgNotNull)).toBe(false)

    const pgCheck = new SqlError.SqlError({
      reason: new SqlError.ConstraintError({
        cause: { code: "23514", constraint: "users_role_check" }
      })
    })
    expect(PostgresDialect.classifyError(pgCheck)).toEqual({
      _tag: "CheckViolation",
      constraint: "users_role_check"
    })
  })
})

describe("ManyToMany dialect delegation", () => {
  it("delegates select and parse to the active dialect", () => {
    const [defaultSql] = compile(sqliteCompiler, ManyToMany.select(sqliteSql, tagsLink, "items", "id"))
    expect(defaultSql).toContain("json_group_array")

    const [pgSelectSql] = compile(pgCompiler, ManyToMany.select(pgSql, tagsLink, "items", "id", PostgresDialect))
    expect(pgSelectSql).toContain("COALESCE(json_agg(\"tagId\" ORDER BY \"tagId\"), '[]'::json)")

    const sqliteRows = ManyToMany.parse([tagsLink], [{ id: 1, tags: "[1,3]" }], SqliteDialect)
    expect(sqliteRows[0]!.tags).toEqual([1, 3])

    const pgRows = ManyToMany.parse([tagsLink], [{ id: 1, tags: [1, 3] }], PostgresDialect)
    expect(pgRows[0]!.tags).toEqual([1, 3])
  })

  it.effect("tags Postgres 23503 invalid references with the link key in ManyToMany.write", () =>
    Effect.gen(function*() {
      const failingPg = makeMockSqlClient(pgCompiler, () =>
        Effect.fail(
          new SqlError.SqlError({
            reason: new SqlError.ConstraintError({
              cause: {
                code: "23503",
                constraint: "item_tags_tagId_fkey",
                detail: "Key (tagId)=(999) is not present in table \"tags\"."
              },
              message: "insert or update on table \"item_tags\" violates foreign key constraint"
            })
          })
        ))
      const err = yield* Effect.flip(ManyToMany.write(failingPg, tagsLink, 1, [999], [], {}, PostgresDialect))
      expect(err.reason._tag).toBe("ConstraintError")
      expect(err.reason.message).toContain(": tags")
    }))
})

describe("Repo dialect delegation", () => {
  it.effect("defaults to SqliteDialect when SqlDialect is not provided", () =>
    Effect.gen(function*() {
      const queries: Array<string> = []
      const client = makeMockSqlClient(sqliteCompiler, (sql) => {
        queries.push(sql)
        if (sql.includes("COUNT(*)")) return Effect.succeed([{ total: 1 }])
        return Effect.succeed([{ id: 1, name: "Widget", tags: "[2,5]" }])
      })
      const repo = yield* Repo.make(Item, { table: "items", idColumn: "id", query: ItemQuery }).pipe(
        Effect.provide(Layer.merge(Layer.succeed(SqlClient.SqlClient, client), Reactivity.layer))
      )
      const page = yield* repo.list(ItemQuery.initial)
      expect(page.total).toBe(1)
      expect(page.rows).toEqual([Item.make({ id: 1, name: "Widget", tags: [2 as any, 5 as any] })])
      expect(queries.some((q) => q.includes("json_group_array"))).toBe(true)
    }))

  it.effect("uses PostgresDialectLayer for list queries, string COUNT(*), native JSON arrays, and deleteMany 23503 restrict", () =>
    Effect.gen(function*() {
      const queries: Array<string> = []
      const client = makeMockSqlClient(pgCompiler, (sql, params) => {
        queries.push(sql)
        if (sql.includes("COUNT(*)")) return Effect.succeed([{ total: "2" }])
        if (sql.startsWith("DELETE FROM")) {
          if (params[0] === 2) {
            return Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.ConstraintError({
                  cause: {
                    code: "23503",
                    constraint: "refs_itemId_fkey",
                    detail: "Key (id)=(2) is still referenced from table \"refs\"."
                  }
                })
              })
            )
          }
          return Effect.succeed([])
        }
        return Effect.succeed([
          { id: 1, name: "Alpha", tags: [1, 3] },
          { id: 2, name: "Beta", tags: [] }
        ])
      })
      const env = Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, client),
        Reactivity.layer,
        PostgresDialectLayer
      )
      const repo = yield* Repo.make(Item, { table: "items", idColumn: "id", query: ItemQuery }).pipe(
        Effect.provide(env)
      )

      const page = yield* repo.list(ItemQuery.initial)
      expect(page.total).toBe(2)
      expect(page.rows.map((r) => [r.id, r.tags])).toEqual([[1, [1, 3]], [2, []]])
      expect(queries.some((q) => q.includes("COALESCE(json_agg("))).toBe(true)
      expect(queries.some((q) => q.includes("json_group_array"))).toBe(false)

      const deleted = yield* repo.deleteMany([1, 2, 99])
      expect(deleted).toEqual({ done: [1], missing: [99], restricted: [2] })
    }))

  it.effect("SqlDialect layers provide the expected service instances", () =>
    Effect.gen(function*() {
      const sqlite = yield* Effect.provide(SqlDialect, SqliteDialectLayer)
      const pg = yield* Effect.provide(SqlDialect, PostgresDialectLayer)
      expect(sqlite.name).toBe("sqlite")
      expect(pg.name).toBe("postgres")
    }))
})
