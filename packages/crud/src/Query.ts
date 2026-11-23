/**
 * List queries derived from a model + a small typed config.
 *
 *   const UserQuery = Query.make(User, {
 *     sortable: ["name", "email", "createdAt"],
 *     filters: { name: "contains", role: "eq", active: "eq", createdAt: "range", tags: "has" },
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
 *
 * Operators:
 *   - `contains`: `LIKE %value%`
 *   - `eq`: equal to a value of the field (`null` for `IS NULL` on nullable fields)
 *   - `range`: a date range on a `date` or `datetime` field, as two filters,
 *     `${key}From` and `${key}To` (ISO dates, both inclusive, either may be blank):
 *     `?createdAtFrom=2026-01-01&createdAtTo=2026-01-31`
 *   - `has`: a many-to-many field (`ManyToMany.Ids`) includes an id: `?tags=3`
 */
import { Schema } from "effect"
import type { Statement } from "effect/sql"
import * as Field from "./Field.ts"
import * as ManyToMany from "./ManyToMany.ts"
import { isIsoDate, nextDay } from "./Schemas.ts"

export type Operator = "contains" | "eq" | "range" | "has"
export type Dir = "asc" | "desc"

/** The query's filter keys for a filters config: a `range` filter is two, `${key}From` and `${key}To`. */
export type Keys<Filters> = {
  [K in keyof Filters & string]: Filters[K] extends "range" ? `${K}From` | `${K}To` : K
}[keyof Filters & string]

/** The two filter keys of a `range` filter. */
export const rangeKeys = (key: string) => [`${key}From`, `${key}To`] as const

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

/** A list query as flat, optional params (see `QueryDef.params`). */
export type ListParams<Sortable extends string, FilterKey extends string> =
  & {
    readonly page?: number
    readonly pageSize?: number
    readonly sort?: Sortable
    readonly dir?: Dir
  }
  & { readonly [K in FilterKey]?: string }

export interface FilterInfo extends Field.FieldInfo {
  readonly operator: Operator
  /** Its keys in the query's `filters` (and the URL): `[key]`, or `rangeKeys(key)` for a range. */
  readonly params: ReadonlyArray<string>
}

export interface QueryDef<Sortable extends string, FilterKey extends string> {
  readonly schema: Schema.Codec<ListQuery<Sortable, FilterKey>, ListQuery<Sortable, FilterKey>>
  readonly initial: ListQuery<Sortable, FilterKey>
  readonly sortable: ReadonlyArray<Sortable>
  readonly pageSizes: ReadonlyArray<number>
  readonly filters: ReadonlyArray<FilterInfo>
  /**
   * `WHERE` for the query's filters, and-ed with any `extra` clauses (e.g. a tenant scope).
   * `idColumn` is needed for `has` filters (`id IN (SELECT ... FROM the join table)`).
   */
  readonly where: (
    sql: SqlHelpers,
    q: ListQuery<Sortable, FilterKey>,
    idColumn: string,
    extra?: ReadonlyArray<Statement.Fragment>
  ) => Statement.Fragment
  readonly orderBy: (sql: SqlHelpers, q: ListQuery<Sortable, FilterKey>, idColumn: string) => Statement.Fragment
  /**
   * Columns that decide which rows a query returns and in what order: the sort
   * column and every active filter (a many-to-many filter counts as its field).
   * A change to any other column can't move a row into, out of, or within the results.
   */
  readonly columns: (q: ListQuery<Sortable, FilterKey>) => ReadonlyArray<string>
  /**
   * URL search params for a query; values equal to the defaults are omitted.
   * Filters use their key (`?role=admin&teamId=3&createdAtFrom=2026-01-01&sort=name`).
   */
  readonly toSearchParams: (q: ListQuery<Sortable, FilterKey>) => URLSearchParams
  /** Query from URL search params. Lenient: invalid or unknown params fall back to defaults. */
  readonly fromSearchParams: (params: URLSearchParams) => ListQuery<Sortable, FilterKey>
  /**
   * The query as flat, optional params with the URL-state names (`page`,
   * `pageSize`, `sort`, `dir` and one per filter key), validated strictly with the
   * same per-field schemas as the signals. For APIs, where an invalid param
   * should be an error rather than a silent default.
   */
  readonly params: Schema.Codec<ListParams<Sortable, FilterKey>, ListParams<Sortable, FilterKey>>
  /** Params -> query: missing params take their defaults. */
  readonly fromParams: (params: ListParams<Sortable, FilterKey>) => ListQuery<Sortable, FilterKey>
  /**
   * The same query with one `eq` filter fixed by the server (e.g. a "has many"
   * view locked to `teamId = 3`). The client-facing schema drops that filter and
   * rejects signals that try to set it.
   */
  readonly lock: <L extends FilterKey>(key: L) => Locked<Sortable, FilterKey, L>
}

/** A query with filter `L` fixed server-side. */
export interface Locked<Sortable extends string, FilterKey extends string, L extends FilterKey> {
  readonly key: L
  readonly field: FilterInfo
  /** Client signals schema: no `filters[L]`, and decoding fails if it is present. */
  readonly schema: Schema.Codec<ListQuery<Sortable, Exclude<FilterKey, L>>, ListQuery<Sortable, Exclude<FilterKey, L>>>
  readonly initial: ListQuery<Sortable, Exclude<FilterKey, L>>
  /** The filters the client may still use. */
  readonly filters: ReadonlyArray<FilterInfo>
  /**
   * Validate a lock value (e.g. a path param) against the field's own schema.
   * Returns the canonical filter string, or `undefined` if it is empty, `null`
   * or not a valid value of the field.
   */
  readonly parse: (raw: string) => string | undefined
  /** The full query the server runs: the client's query plus the lock. */
  readonly apply: (q: ListQuery<Sortable, Exclude<FilterKey, L>>, value: string) => ListQuery<Sortable, FilterKey>
}

/** The subset of the `sql` tag we use. */
type SqlHelpers = Statement.Constructor

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Filter value meaning `IS NULL` (for nullable fields, e.g. "no team"). */
export const NULL = "null"

const NUMBER = /^-?\d+(\.\d+)?$/

/** Raw filter string -> the field's (decoded) value, before validation. */
const fromRaw = (field: Field.FieldInfo, raw: string): unknown =>
  field.kind === "boolean" ? raw === "true" : field.kind === "number" ? Number(raw) : raw

/**
 * Whether a non-empty `eq` filter value is a valid value of the field: it
 * parses as the field's kind and the field's own schema accepts it, so
 * `teamId=1.5` is rejected because `TeamId` is an integer. This is exactly
 * what `toDbValue` needs to succeed.
 */
const isFieldValue = (field: Field.FieldInfo) => {
  const encode = Schema.encodeUnknownExit(field.schema as Schema.Codec<unknown, unknown>)
  return (raw: string): boolean =>
    (field.kind !== "number" || NUMBER.test(raw)) && encode(fromRaw(field, raw))._tag === "Success"
}

/** Schema for the raw filter string, validated against the field's own schema. */
const filterSchema = (field: Field.FieldInfo, op: Operator): Schema.Codec<string, string> => {
  if (op === "contains") return Schema.String
  if (op === "range") {
    return Schema.String.check(
      Schema.makeFilter((raw: string) => raw === "" || isIsoDate(raw), { message: `Invalid ${field.label} date` })
    )
  }
  if (op === "has") {
    const valid = isFieldValue(field.element!)
    return Schema.String.check(
      Schema.makeFilter((raw: string) => raw === "" || valid(raw), { message: `Invalid ${field.label}` })
    )
  }
  const nulls = field.nullable ? [NULL] : []
  switch (field.kind) {
    case "enum":
      return Schema.Literals(["", ...nulls, ...field.options]) as unknown as Schema.Codec<string, string>
    case "boolean":
      return Schema.Literals(["", ...nulls, "true", "false"]) as unknown as Schema.Codec<string, string>
    default: {
      const valid = isFieldValue(field)
      return Schema.String.check(
        Schema.makeFilter(
          (raw: string) => raw === "" || (field.nullable && raw === NULL) || valid(raw),
          { message: `Invalid ${field.label}` }
        )
      )
    }
  }
}

/** Raw filter string -> decoded field value -> DB-encoded value. */
const toDbValue = (field: Field.FieldInfo, raw: string): unknown =>
  Schema.encodeUnknownSync(field.schema as Schema.Codec<unknown, unknown>)(fromRaw(field, raw))

export const make = <
  M extends { readonly fields: Schema.Struct.Fields },
  const Sortable extends keyof M["fields"] & string,
  const Filters extends { readonly [K in keyof M["fields"] & string]?: Operator }
>(
  model: M,
  config: Config<Sortable, Filters & Record<string, Operator>>
): QueryDef<Sortable, Keys<Filters>> => {
  type FK = Keys<Filters>
  const filters: Array<FilterInfo> = Object.entries(config.filters as Record<string, Operator>).map(([key, operator]) => {
    const info = Field.info(key, model.fields[key]!)
    if (operator === "range" && info.kind !== "date" && info.kind !== "datetime") {
      throw new Error(`Query: "${key}" is not a date, so it can't have a range filter`)
    }
    if ((operator === "has") !== (info.kind === "ids")) {
      throw new Error(`Query: "${key}" ${info.kind === "ids" ? "is many-to-many: use has" : "is not many-to-many"}`)
    }
    return { ...info, operator, params: operator === "range" ? rangeKeys(key) : [key] }
  })
  /** Every filter key of the query, in order. */
  const paramKeys = filters.flatMap((f) => f.params)

  const pieces = {
    page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    pageSize: Schema.Literals(config.pageSizes),
    sort: Schema.Literals(config.sortable),
    dir: Schema.Literals(["asc", "desc"])
  }
  const filterSchemas = Object.fromEntries(
    filters.flatMap((f) => f.params.map((key) => [key, filterSchema(f, f.operator)] as const))
  )
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
    filters: Object.fromEntries(paramKeys.map((k) => [k, ""])) as ListQuery<Sortable, FK>["filters"]
  }

  const toSearchParams = (q: ListQuery<Sortable, FK>) => {
    const params = new URLSearchParams()
    for (const k of paramKeys) {
      const v = (q.filters as Record<string, string>)[k]
      if (v) params.set(k, v)
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
        paramKeys.map((k) => [k, or(param(filterSchemas[k]!, params.get(k), false), "")])
      ) as ListQuery<Sortable, FK>["filters"]
    }
  }

  const lock = <L extends FK>(key: L): Locked<Sortable, FK, L> => {
    const field = filters.find((f) => f.key === key)
    if (field === undefined || field.operator !== "eq") throw new Error(`Query.lock: "${key}" is not an eq filter`)
    const rest = filters.filter((f) => f.key !== key)
    const { [key]: _, ...restFilters } = initial.filters
    const decodeField = Schema.decodeUnknownExit(field.schema as Schema.Codec<unknown, unknown>)
    return {
      key,
      field,
      filters: rest,
      schema: Schema.Struct({
        ...pieces,
        filters: Schema.Struct({
          ...Object.fromEntries(rest.flatMap((f) => f.params).map((k) => [k, filterSchemas[k]!])),
          [key]: Schema.optionalKey(Schema.Never)
        })
      }) as unknown as Locked<Sortable, FK, L>["schema"],
      initial: { ...initial, filters: restFilters as ListQuery<Sortable, Exclude<FK, L>>["filters"] },
      parse: (raw) => {
        if (raw === "" || raw === NULL) return undefined
        if (Schema.decodeUnknownExit(filterSchemas[key]!)(raw)._tag !== "Success") return undefined
        const value = fromRaw(field, raw)
        const decoded = decodeField(value)
        return decoded._tag === "Success" && decoded.value !== null ? String(value) : undefined
      },
      apply: (q, value) => ({ ...q, filters: { ...q.filters, [key]: value } }) as ListQuery<Sortable, FK>
    }
  }

  return {
    lock,
    schema,
    initial,
    toSearchParams,
    fromSearchParams,
    params: Schema.Struct({
      page: Schema.optionalKey(pieces.page),
      pageSize: Schema.optionalKey(pieces.pageSize),
      sort: Schema.optionalKey(pieces.sort),
      dir: Schema.optionalKey(pieces.dir),
      ...Object.fromEntries(paramKeys.map((k) => [k, Schema.optionalKey(filterSchemas[k]!)]))
    }) as unknown as QueryDef<Sortable, FK>["params"],
    fromParams: (p) => ({
      page: p.page ?? initial.page,
      pageSize: p.pageSize ?? initial.pageSize,
      sort: p.sort ?? initial.sort,
      dir: p.dir ?? initial.dir,
      filters: Object.fromEntries(
        paramKeys.map((k) => [k, (p as Readonly<Record<string, unknown>>)[k] ?? ""])
      ) as ListQuery<Sortable, FK>["filters"]
    }),
    sortable: config.sortable,
    pageSizes: config.pageSizes,
    filters,
    where: (sql, q, idColumn, extra = []) => {
      const clauses: Array<Statement.Fragment> = [...extra]
      const value = (key: string) => (q.filters as Record<string, string>)[key] ?? ""
      for (const f of filters) {
        if (f.operator === "range") {
          // ISO text compares as dates. A datetime's `to` day ends where the next day starts.
          const [from, to] = f.params.map(value) as [string, string]
          if (from) clauses.push(sql`${sql(f.key)} >= ${from}`)
          if (to) clauses.push(f.kind === "datetime" ? sql`${sql(f.key)} < ${nextDay(to)}` : sql`${sql(f.key)} <= ${to}`)
          continue
        }
        const raw = value(f.key)
        if (!raw) continue
        clauses.push(
          f.operator === "contains"
            ? sql`${sql(f.key)} LIKE ${`%${escapeLike(raw)}%`} ESCAPE '\\'`
            : f.operator === "has"
            ? ManyToMany.has(sql, f as ManyToMany.Link, idColumn, toDbValue(f.element!, raw))
            : f.nullable && raw === NULL
            ? sql`${sql(f.key)} IS NULL`
            : sql`${sql(f.key)} = ${toDbValue(f, raw)}`
        )
      }
      return clauses.length === 0 ? sql.literal("") : sql`WHERE ${sql.and(clauses)}`
    },
    columns: (q) => [
      q.sort,
      ...filters.filter((f) => f.params.some((k) => (q.filters as Record<string, string>)[k] !== "")).map((f) => f.key)
    ],
    orderBy: (sql, q, idColumn) => {
      const dir = sql.literal(q.dir === "asc" ? "ASC" : "DESC")
      return sql`ORDER BY ${sql(q.sort)} ${dir}, ${sql(idColumn)} ${dir}`
    }
  }
}
