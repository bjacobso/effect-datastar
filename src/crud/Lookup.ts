/**
 * Lookups for relations: the `{ value, label }` options of another table,
 * used for foreign-key selects, `eq` filters and showing labels in tables.
 *
 *   const TeamLookup = Lookup.make({ table: "teams", value: "id", label: "name" })
 *
 * `options` reads through `effect/sql`, so wrap it in `Reactivity.stream([table], ...)`
 * to keep it live.
 */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export interface Option {
  readonly value: string
  readonly label: string
}

export interface Lookup {
  readonly table: string
  readonly options: Effect.Effect<ReadonlyArray<Option>, import("effect/sql").SqlError.SqlError>
}

export const make = (config: { readonly table: string; readonly value: string; readonly label: string }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const options = sql<{ value: string | number; label: string }>`
      SELECT ${sql(config.value)} AS value, ${sql(config.label)} AS label
      FROM ${sql(config.table)} ORDER BY ${sql(config.label)}`.pipe(
        Effect.map((rows) => rows.map((r) => ({ value: String(r.value), label: r.label })))
      )
    return { table: config.table, options } satisfies Lookup
  })

/** `value -> label` map, for rendering foreign keys in tables. */
export const labels = (options: ReadonlyArray<Option>): ReadonlyMap<string, string> =>
  new Map(options.map((o) => [o.value, o.label]))
