/**
 * Lookups for relations: the `{ value, label }` options of another table,
 * used for foreign-key selects, `eq` filters and showing labels in tables.
 *
 *   const TeamLookup = Lookup.make({ table: "teams", value: "id", label: "name" })
 *
 * `options` reads through `effect/sql`, so wrap it in `Reactivity.stream([yield* lookup.key], ...)`
 * to keep it live. With a tenant `scope`, the options are the current
 * tenant's rows only, and `key` is that tenant's key (see `Scope.ts`).
 */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql"
import * as Scope from "./Scope.ts"

export interface Option {
  readonly value: string
  readonly label: string
  /** Link to the referenced row's page, when it has one. */
  readonly href?: string | undefined
}

/** `R`: what the scope needs (the tenant service), `never` if unscoped. */
export interface Lookup<R = never> {
  readonly table: string
  readonly options: Effect.Effect<ReadonlyArray<Option>, SqlError.SqlError, R>
  /** The reactivity key the table's changes are announced on, for the current scope. */
  readonly key: Effect.Effect<string, never, R>
}

export const make = <R = never>(config: {
  readonly table: string
  readonly value: string
  readonly label: string
  readonly href?: ((value: string) => string) | undefined
  readonly scope?: Scope.Scope<R> | undefined
}) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const scope = config.scope
    const current: Effect.Effect<Scope.Current | undefined, never, R> = scope === undefined
      ? Effect.succeed(undefined)
      : scope.value
    const options = Effect.flatMap(current, (v) =>
      sql<{ value: string | number; label: string }>`
        SELECT ${sql(config.value)} AS value, ${sql(config.label)} AS label
        FROM ${sql(config.table)}
        ${v === undefined || scope === undefined ? sql.literal("") : sql`WHERE ${sql(scope.column)} = ${v.encoded}`}
        ORDER BY ${sql(config.label)}`.pipe(
        Effect.map((rows) =>
          rows.map((r): Option => {
            const value = String(r.value)
            return config.href ? { value, label: r.label, href: config.href(value) } : { value, label: r.label }
          })
        )
      ))
    const key = Effect.map(current, (v) =>
      v === undefined || scope === undefined || !scope.isolateKeys
        ? config.table
        : Scope.key(config.table, scope.column, v.encoded))
    const lookup: Lookup<R> = { table: config.table, options, key }
    return lookup
  })

/** `value -> label` map, for rendering foreign keys in tables. */
export const labels = (options: ReadonlyArray<Option>): ReadonlyMap<string, string> =>
  new Map(options.map((o) => [o.value, o.label]))
