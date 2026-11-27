/**
 * SQL dialect abstraction for the CRUD layer (`SqliteDialect` and `PostgresDialect`).
 *
 * `effect/sql`'s `Statement` compiler already handles bind placeholders (`?` vs `$1`),
 * identifier escaping, and `INSERT` / `UPDATE` record helpers. This module isolates the
 * remaining SQL-dialect differences that `Repo`, `ManyToMany`, and query builders need:
 *
 *   - Case-insensitive substring predicates (`LIKE ... ESCAPE '\'` vs `ILIKE ... ESCAPE '\'`)
 *   - Many-to-many correlated JSON array subqueries (`json_group_array` vs `COALESCE(json_agg(...), '[]'::json)`)
 *   - Deserializing JSON array results (SQLite returns text; Postgres drivers return arrays)
 *   - Normalizing `COUNT(*)` results (SQLite returns `number`; Postgres drivers often return `string` or `bigint`)
 *   - Identifier quoting and placeholder formatting
 *   - Constraint error classification (SQLite `SQLITE_CONSTRAINT_*` vs Postgres SQLSTATE `23505` / `23503` / `23502` / `23514`)
 *
 * `Repo.make` reads `SqlDialect` optionally via `Effect.serviceOption` and defaults to
 * `SqliteDialect`, so existing SQLite callers require no layer changes.
 */
import { Context, Layer } from "effect"
import type { SqlError, Statement } from "effect/sql"

export type DialectName = "sqlite" | "postgres"

export type ForeignKeyKind = "invalidReference" | "restrict" | "unknown"

/** Structured classification of a database constraint violation. */
export type ConstraintViolation =
  | {
    readonly _tag: "UniqueViolation"
    readonly constraint?: string | undefined
    readonly column?: string | undefined
    readonly columns?: ReadonlyArray<string> | undefined
  }
  | {
    readonly _tag: "ForeignKeyViolation"
    readonly kind: ForeignKeyKind
    readonly constraint?: string | undefined
    readonly column?: string | undefined
  }
  | {
    readonly _tag: "NotNullViolation"
    readonly column?: string | undefined
  }
  | {
    readonly _tag: "CheckViolation"
    readonly constraint?: string | undefined
  }

export interface JsonArraySubqueryOptions {
  readonly joinTable: string
  readonly fromColumn: string
  readonly toColumn: string
  readonly parentTable: string
  readonly parentIdColumn: string
  readonly alias: string
}

export interface SqlDialectService {
  readonly name: DialectName
  /** Quotes a SQL identifier (including dotted `table.column` forms) with double quotes. */
  readonly quoteIdentifier: (identifier: string) => string
  /** Formats a 1-based positional bind parameter placeholder (`?` for SQLite, `$1` for Postgres). */
  readonly placeholder: (index: number) => string
  /** Escapes `\`, `%`, and `_` for use in a `LIKE` / `ILIKE` pattern with `ESCAPE '\'`. */
  readonly escapeLike: (value: string) => string
  /** Case-insensitive substring predicate (`LIKE` on SQLite, `ILIKE` on Postgres). */
  readonly contains: (sql: Statement.Constructor, column: string, value: string) => Statement.Fragment
  /** Correlated subquery returning a row's related join-table ids as a sorted JSON array. */
  readonly jsonArraySubquery: (sql: Statement.Constructor, options: JsonArraySubqueryOptions) => Statement.Fragment
  /** Normalizes a JSON array column value (JSON text on SQLite, parsed array on Postgres) to a JS array. */
  readonly parseJsonArray: (raw: unknown) => ReadonlyArray<unknown>
  /** Encodes a boolean for SQL binding (`1`/`0` on SQLite, `boolean` on Postgres). */
  readonly encodeBoolean: (value: boolean) => number | boolean
  /** Normalizes a `COUNT(*)` result (`number`, `bigint`, or numeric `string`) to a JS `number`. */
  readonly decodeCount: (value: unknown) => number
  /** Classifies a `SqlError` into a structured constraint violation, or `undefined` if not a constraint error. */
  readonly classifyError: (error: SqlError.SqlError) => ConstraintViolation | undefined
  /** Whether `error` is a unique / primary-key constraint violation. */
  readonly isUniqueViolation: (error: SqlError.SqlError) => boolean
  /** Whether `error` is a foreign-key restriction preventing a delete. */
  readonly isForeignKeyRestrict: (error: SqlError.SqlError) => boolean
  /** Whether `error` is a foreign-key violation caused by an invalid reference on write. */
  readonly isInvalidReference: (error: SqlError.SqlError) => boolean
}

export class SqlDialect extends Context.Service<SqlDialect, SqlDialectService>()(
  "@effect-datastar/crud/SqlDialect"
) {}

// --- shared helpers ----------------------------------------------------------

const quoteDouble = (identifier: string): string =>
  identifier
    .split(".")
    .map((part) => `"${part.replace(/"/g, "\"\"")}"`)
    .join(".")

export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`)

const decodeCount = (value: unknown): number => {
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

const parseJsonArray = (raw: unknown): ReadonlyArray<unknown> => {
  if (Array.isArray(raw)) return raw
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

interface RawDbError {
  readonly code?: unknown
  readonly errcode?: unknown
  readonly errno?: unknown
  readonly message?: unknown
  readonly detail?: unknown
  readonly constraint?: unknown
  readonly constraint_name?: unknown
  readonly column?: unknown
  readonly column_name?: unknown
  readonly cause?: unknown
}

const asRecord = (u: unknown): RawDbError | undefined =>
  typeof u === "object" && u !== null ? (u as RawDbError) : undefined

const asString = (u: unknown): string | undefined => (typeof u === "string" && u.length > 0 ? u : undefined)

const unwrapCause = (error: SqlError.SqlError): RawDbError | undefined => {
  const first = asRecord(error.reason.cause)
  if (first === undefined) return undefined
  if (first.code !== undefined || first.errcode !== undefined || first.detail !== undefined || first.constraint !== undefined) {
    return first
  }
  const nested = asRecord(first.cause)
  return nested ?? first
}

const errorText = (error: SqlError.SqlError, raw: RawDbError | undefined): string =>
  [
    error.reason.message,
    asString(raw?.message),
    asString(raw?.detail),
    typeof error.reason.cause === "string" ? error.reason.cause : undefined
  ]
    .filter((s): s is string => s !== undefined && s.length > 0)
    .join("\n")

const stripQuotes = (s: string) => s.trim().replace(/^"(.*)"$/, "$1").replace(/""/g, "\"")

const parsePgDetailColumns = (detail: string | undefined): ReadonlyArray<string> | undefined => {
  if (detail === undefined) return undefined
  const match = /Key \(([^)]+)\)=/.exec(detail)
  if (match === null || match[1] === undefined) return undefined
  const cols = match[1].split(",").map(stripQuotes).filter((c) => c.length > 0)
  return cols.length > 0 ? cols : undefined
}

const parseSqliteColumns = (text: string, prefix: RegExp): {
  readonly constraint?: string | undefined
  readonly column?: string | undefined
  readonly columns?: ReadonlyArray<string> | undefined
} => {
  const match = prefix.exec(text)
  if (match === null || match[1] === undefined) return {}
  const rawList = match[1].trim()
  const parts = rawList.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  const columns = parts.map((p) => {
    const dot = p.lastIndexOf(".")
    return dot === -1 ? p : p.slice(dot + 1)
  })
  return {
    constraint: rawList,
    column: columns[0],
    columns: columns.length > 0 ? columns : undefined
  }
}

const makeHelpers = (classifyError: SqlDialectService["classifyError"]) => ({
  classifyError,
  isUniqueViolation: (error: SqlError.SqlError) => classifyError(error)?._tag === "UniqueViolation",
  isForeignKeyRestrict: (error: SqlError.SqlError) => {
    const v = classifyError(error)
    return v?._tag === "ForeignKeyViolation" && (v.kind === "restrict" || v.kind === "unknown")
  },
  isInvalidReference: (error: SqlError.SqlError) => {
    const v = classifyError(error)
    return v?._tag === "ForeignKeyViolation" && (v.kind === "invalidReference" || v.kind === "unknown")
  }
})

// --- SQLite dialect ----------------------------------------------------------

const classifySqliteError = (error: SqlError.SqlError): ConstraintViolation | undefined => {
  const raw = unwrapCause(error)
  const code = asString(raw?.code)
  const errcode = typeof raw?.errcode === "number" ? raw.errcode : typeof raw?.errno === "number" ? raw.errno : undefined
  const text = errorText(error, raw)

  if (
    error.reason._tag === "UniqueViolation" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    errcode === 2067 ||
    errcode === 1555 ||
    /UNIQUE constraint failed/i.test(text)
  ) {
    const parsed = parseSqliteColumns(text, /UNIQUE constraint failed:\s*([^\n]+)/i)
    const reasonConstraint = error.reason._tag === "UniqueViolation" ? asString(error.reason.constraint) : undefined
    const constraint = parsed.constraint ?? reasonConstraint
    const column = parsed.column ?? (constraint?.includes(".") ? constraint.slice(constraint.lastIndexOf(".") + 1) : constraint)
    return {
      _tag: "UniqueViolation",
      ...(constraint === undefined ? {} : { constraint }),
      ...(column === undefined ? {} : { column }),
      ...(parsed.columns === undefined ? {} : { columns: parsed.columns })
    }
  }

  if (code === "SQLITE_CONSTRAINT_NOTNULL" || errcode === 1299 || /NOT NULL constraint failed/i.test(text)) {
    const parsed = parseSqliteColumns(text, /NOT NULL constraint failed:\s*([^\n]+)/i)
    return {
      _tag: "NotNullViolation",
      ...(parsed.column === undefined ? {} : { column: parsed.column })
    }
  }

  if (code === "SQLITE_CONSTRAINT_CHECK" || errcode === 275 || /CHECK constraint failed/i.test(text)) {
    const match = /CHECK constraint failed:\s*([^\n]+)/i.exec(text)
    const constraint = match?.[1]?.trim()
    return {
      _tag: "CheckViolation",
      ...(constraint === undefined || constraint.length === 0 ? {} : { constraint })
    }
  }

  if (
    code === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
    errcode === 787 ||
    /FOREIGN KEY constraint failed/i.test(text)
  ) {
    const named = /FOREIGN KEY constraint failed:\s*([A-Za-z0-9_]+)/i.exec(text)
    const column = named?.[1]
    return {
      _tag: "ForeignKeyViolation",
      kind: column !== undefined ? "invalidReference" : "unknown",
      ...(column === undefined ? {} : { column })
    }
  }

  if (error.reason._tag === "ConstraintError") {
    return { _tag: "ForeignKeyViolation", kind: "unknown" }
  }

  return undefined
}

export const SqliteDialect: SqlDialectService = {
  name: "sqlite",
  quoteIdentifier: quoteDouble,
  placeholder: () => "?",
  escapeLike,
  contains: (sql, column, value) => sql`${sql(column)} LIKE ${`%${escapeLike(value)}%`} ESCAPE '\\'`,
  jsonArraySubquery: (sql, o) =>
    sql`(SELECT json_group_array(${sql(o.toColumn)}) FROM (
    SELECT ${sql(o.toColumn)} FROM ${sql(o.joinTable)}
    WHERE ${sql(o.fromColumn)} = ${sql(o.parentTable)}.${sql(o.parentIdColumn)} ORDER BY ${sql(o.toColumn)}
  )) AS ${sql(o.alias)}`,
  parseJsonArray,
  encodeBoolean: (value) => (value ? 1 : 0),
  decodeCount,
  ...makeHelpers(classifySqliteError)
}

export const SqliteDialectLayer: Layer.Layer<SqlDialect> = Layer.succeed(SqlDialect, SqliteDialect)

// --- Postgres dialect --------------------------------------------------------

const classifyPostgresError = (error: SqlError.SqlError): ConstraintViolation | undefined => {
  const raw = unwrapCause(error)
  const code = asString(raw?.code)
  const constraint =
    asString(raw?.constraint) ??
    asString(raw?.constraint_name) ??
    (error.reason._tag === "UniqueViolation" ? asString(error.reason.constraint) : undefined)
  const detail = asString(raw?.detail)
  const explicitColumn = asString(raw?.column) ?? asString(raw?.column_name)
  const text = errorText(error, raw)

  if (error.reason._tag === "UniqueViolation" || code === "23505" || /duplicate key value violates unique constraint/i.test(text)) {
    const detailCols = parsePgDetailColumns(detail ?? text)
    const column = explicitColumn ?? detailCols?.[0]
    return {
      _tag: "UniqueViolation",
      ...(constraint === undefined ? {} : { constraint }),
      ...(column === undefined ? {} : { column }),
      ...(detailCols === undefined ? {} : { columns: detailCols })
    }
  }

  if (code === "23502" || /violates not-null constraint/i.test(text)) {
    const match = /null value in column "([^"]+)"/i.exec(text)
    const column = explicitColumn ?? match?.[1]
    return {
      _tag: "NotNullViolation",
      ...(column === undefined ? {} : { column })
    }
  }

  if (code === "23514" || /violates check constraint/i.test(text)) {
    const match = /violates check constraint "([^"]+)"/i.exec(text)
    const name = constraint ?? match?.[1]
    return {
      _tag: "CheckViolation",
      ...(name === undefined ? {} : { constraint: name })
    }
  }

  if (code === "23503" || /violates foreign key constraint/i.test(text) || /FOREIGN KEY constraint failed/i.test(text)) {
    const detailCols = parsePgDetailColumns(detail ?? text)
    const named = /FOREIGN KEY constraint failed:\s*([A-Za-z0-9_]+)/i.exec(text)
    const column = explicitColumn ?? detailCols?.[0] ?? named?.[1]
    const kind: ForeignKeyKind = /is still referenced from table/i.test(text)
      ? "restrict"
      : /is not present in table/i.test(text) || named !== null
      ? "invalidReference"
      : "unknown"
    return {
      _tag: "ForeignKeyViolation",
      kind,
      ...(constraint === undefined ? {} : { constraint }),
      ...(column === undefined ? {} : { column })
    }
  }

  if (error.reason._tag === "ConstraintError") {
    return { _tag: "ForeignKeyViolation", kind: "unknown" }
  }

  return undefined
}

export const PostgresDialect: SqlDialectService = {
  name: "postgres",
  quoteIdentifier: quoteDouble,
  placeholder: (index) => `$${index}`,
  escapeLike,
  contains: (sql, column, value) => sql`${sql(column)} ILIKE ${`%${escapeLike(value)}%`} ESCAPE '\\'`,
  jsonArraySubquery: (sql, o) =>
    sql`(SELECT COALESCE(json_agg(${sql(o.toColumn)} ORDER BY ${sql(o.toColumn)}), '[]'::json)
    FROM ${sql(o.joinTable)}
    WHERE ${sql(o.fromColumn)} = ${sql(o.parentTable)}.${sql(o.parentIdColumn)}) AS ${sql(o.alias)}`,
  parseJsonArray,
  encodeBoolean: (value) => value,
  decodeCount,
  ...makeHelpers(classifyPostgresError)
}

export const PostgresDialectLayer: Layer.Layer<SqlDialect> = Layer.succeed(SqlDialect, PostgresDialect)
