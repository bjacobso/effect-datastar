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

  const schema = Schema.Struct({
    page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    pageSize: Schema.Literals(config.pageSizes),
    sort: Schema.Literals(config.sortable),
    dir: Schema.Literals(["asc", "desc"]),
    filters: Schema.Struct(Object.fromEntries(filters.map((f) => [f.key, filterSchema(f, f.operator)])))
  }) as unknown as QueryDef<Sortable, FK>["schema"]

  const initial: ListQuery<Sortable, FK> = {
    page: 1,
    pageSize: config.pageSizes[0],
    sort: config.defaultSort[0],
    dir: config.defaultSort[1],
    filters: Object.fromEntries(filters.map((f) => [f.key, ""])) as ListQuery<Sortable, FK>["filters"]
  }

  return {
    schema,
    initial,
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
    orderBy: (sql, q, idColumn) => {
      const dir = sql.literal(q.dir === "asc" ? "ASC" : "DESC")
      return sql`ORDER BY ${sql(q.sort)} ${dir}, ${sql(idColumn)} ${dir}`
    }
  }
}
