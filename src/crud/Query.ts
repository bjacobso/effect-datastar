/**
 * List queries derived from a model + a small typed config.
 *
 *   const UserQuery = Query.make(User, {
 *     sortable: ["name", "email", "createdAt"],
 *     filters: { name: "contains", role: "eq", active: "eq" },
 *     defaultSort: ["createdAt", "desc"],
 *     pageSizes: [10, 25, 50]
 *   })
 *
 * Gives you:
 *   - `schema`  : the signals schema for the query (page/pageSize/sort/dir/filters).
 *                 Sort is a literal union of sortable keys, `eq` filters on enums
 *                 only accept enum members, so bad input never reaches SQL.
 *   - `initial` : default query value
 *   - `filters` : per-filter field metadata (label, operator, options) for rendering
 *   - `where` / `orderBy` / `limit` : `effect/sql` fragments
 */
import { Schema } from "effect"
import type { Statement } from "effect/sql"
import * as Field from "./Field.ts"

export type Operator = "contains" | "eq"
export type Dir = "asc" | "desc"

export interface Config<Sortable extends string, Filters extends Record<string, Operator>> {
  readonly sortable: ReadonlyArray<Sortable>
  readonly filters: Filters
  readonly defaultSort: readonly [Sortable, Dir]
  readonly pageSizes: readonly [number, ...Array<number>]
}

export interface ListQuery<Sortable extends string, FilterKey extends string> {
  readonly page: number
  readonly pageSize: number
  readonly sort: Sortable
  readonly dir: Dir
  /** Raw filter input; `""` means "no filter". Validated per field. */
  readonly filters: { readonly [K in FilterKey]: string }
}

export interface FilterInfo extends Field.FieldInfo {
  readonly operator: Operator
}

export interface QueryDef<Sortable extends string, FilterKey extends string> {
  readonly schema: Schema.Codec<ListQuery<Sortable, FilterKey>, ListQuery<Sortable, FilterKey>>
  readonly initial: ListQuery<Sortable, FilterKey>
  readonly sortable: ReadonlyArray<Sortable>
  readonly pageSizes: ReadonlyArray<number>
  readonly filters: ReadonlyArray<FilterInfo>
  readonly where: (sql: SqlHelpers, q: ListQuery<Sortable, FilterKey>) => Statement.Fragment
  readonly orderBy: (sql: SqlHelpers, q: ListQuery<Sortable, FilterKey>, idColumn: string) => Statement.Fragment
  /**
   * Columns that decide which rows a query returns and in what order: the sort
   * column and every active filter. A change to any other column can't move a
   * row into, out of, or within the results.
   */
  readonly columns: (q: ListQuery<Sortable, FilterKey>) => ReadonlyArray<string>
  /**
   * URL search params for a query; values equal to the defaults are omitted.
   * Filters use their field name (`?role=admin&teamId=3&sort=name`).
   */
  readonly toSearchParams: (q: ListQuery<Sortable, FilterKey>) => URLSearchParams
  /** Query from URL search params. Lenient: invalid or unknown params fall back to defaults. */
  readonly fromSearchParams: (params: URLSearchParams) => ListQuery<Sortable, FilterKey>
}

/** The subset of the `sql` tag we use. */
type SqlHelpers = Statement.Constructor

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Schema for the raw filter string, validated against the field's own type. */
/** Filter value meaning `IS NULL` (for nullable fields, e.g. "no team"). */
export const NULL = "null"

const filterSchema = (field: Field.FieldInfo, op: Operator): Schema.Codec<string, string> => {
  if (op === "contains") return Schema.String
  const nulls = field.nullable ? [NULL] : []
  switch (field.kind) {
    case "enum":
      return Schema.Literals(["", ...nulls, ...field.options]) as any
    case "boolean":
      return Schema.Literals(["", ...nulls, "true", "false"]) as any
    case "number":
      return Schema.String.check(
        Schema.isPattern(field.nullable ? /^(-?\d+(\.\d+)?|null)?$/ : /^(-?\d+(\.\d+)?)?$/)
      )
    default:
      return Schema.String
  }
}

/** Raw filter string -> decoded field value -> DB-encoded value. */
const toDbValue = (field: Field.FieldInfo, raw: string): unknown => {
  const value = field.kind === "boolean" ? raw === "true" : field.kind === "number" ? Number(raw) : raw
  return Schema.encodeUnknownSync(field.schema as any)(value)
}

export const make = <
  M extends { readonly fields: Schema.Struct.Fields },
  const Sortable extends keyof M["fields"] & string,
  const Filters extends { readonly [K in keyof M["fields"] & string]?: Operator }
>(
  model: M,
  config: Config<Sortable, Filters & Record<string, Operator>>
): QueryDef<Sortable, keyof Filters & string> => {
  type FK = keyof Filters & string
  const filters: Array<FilterInfo> = Object.entries(config.filters as Record<string, Operator>).map(([key, operator]) => ({
    ...Field.info(key, model.fields[key]!),
    operator
  }))

  const pieces = {
    page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    pageSize: Schema.Literals(config.pageSizes),
    sort: Schema.Literals(config.sortable),
    dir: Schema.Literals(["asc", "desc"])
  }
  const filterSchemas = Object.fromEntries(filters.map((f) => [f.key, filterSchema(f, f.operator)]))
  const schema = Schema.Struct({
    ...pieces,
    filters: Schema.Struct(filterSchemas)
  }) as unknown as QueryDef<Sortable, FK>["schema"]

  /** Decode one URL param with its own schema; `undefined` if invalid. */
  const param = (s: Schema.Top, raw: string | null, numeric: boolean): unknown => {
    if (raw === null) return undefined
    const exit = Schema.decodeUnknownExit(s as Schema.Codec<unknown, unknown>)(numeric ? Number(raw) : raw)
    return exit._tag === "Success" ? exit.value : undefined
  }

  const initial: ListQuery<Sortable, FK> = {
    page: 1,
    pageSize: config.pageSizes[0],
    sort: config.defaultSort[0],
    dir: config.defaultSort[1],
    filters: Object.fromEntries(filters.map((f) => [f.key, ""])) as ListQuery<Sortable, FK>["filters"]
  }

  const toSearchParams = (q: ListQuery<Sortable, FK>) => {
    const params = new URLSearchParams()
    for (const f of filters) {
      const v = (q.filters as Record<string, string>)[f.key]
      if (v) params.set(f.key, v)
    }
    if (q.sort !== initial.sort || q.dir !== initial.dir) {
      params.set("sort", q.sort)
      params.set("dir", q.dir)
    }
    if (q.pageSize !== initial.pageSize) params.set("pageSize", String(q.pageSize))
    if (q.page !== 1) params.set("page", String(q.page))
    return params
  }

  const fromSearchParams = (params: URLSearchParams): ListQuery<Sortable, FK> => {
    const or = <A>(value: unknown, fallback: A) => (value === undefined ? fallback : value as A)
    return {
      page: or(param(pieces.page, params.get("page"), true), initial.page),
      pageSize: or(param(pieces.pageSize, params.get("pageSize"), true), initial.pageSize),
      sort: or(param(pieces.sort, params.get("sort"), false), initial.sort),
      dir: or(param(pieces.dir, params.get("dir"), false), initial.dir),
      filters: Object.fromEntries(
        filters.map((f) => [f.key, or(param(filterSchemas[f.key]!, params.get(f.key), false), "")])
      ) as ListQuery<Sortable, FK>["filters"]
    }
  }

  return {
    schema,
    initial,
    toSearchParams,
    fromSearchParams,
    sortable: config.sortable,
    pageSizes: config.pageSizes,
    filters,
    where: (sql, q) => {
      const clauses: Array<Statement.Fragment> = []
      for (const f of filters) {
        const raw = (q.filters as Record<string, string>)[f.key]
        if (!raw) continue
        clauses.push(
          f.operator === "contains"
            ? sql`${sql(f.key)} LIKE ${`%${escapeLike(raw)}%`} ESCAPE '\\'`
            : f.nullable && raw === NULL
            ? sql`${sql(f.key)} IS NULL`
            : sql`${sql(f.key)} = ${toDbValue(f, raw) as any}`
        )
      }
      return clauses.length === 0 ? sql.literal("") : sql`WHERE ${sql.and(clauses)}`
    },
    columns: (q) => [
      q.sort,
      ...filters.filter((f) => (q.filters as Record<string, string>)[f.key] !== "").map((f) => f.key)
    ],
    orderBy: (sql, q, idColumn) => {
      const dir = sql.literal(q.dir === "asc" ? "ASC" : "DESC")
      return sql`ORDER BY ${sql(q.sort)} ${dir}, ${sql(idColumn)} ${dir}`
    }
  }
}
