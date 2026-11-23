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
  /** Link to the referenced row's page, when it has one. */
  readonly href?: string | undefined
  /** The row's color (`#rrggbb`), when the table has a color field: tag chips. */
  readonly color?: string | undefined
}

export interface Lookup {
  readonly table: string
  readonly options: Effect.Effect<ReadonlyArray<Option>, import("effect/sql").SqlError.SqlError>
}

export const make = (config: {
  readonly table: string
  readonly value: string
  readonly label: string
  readonly href?: ((value: string) => string) | undefined
  /** A color column, read along with the label. */
  readonly color?: string | undefined
}) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const color = config.color === undefined ? sql.literal("") : sql`, ${sql(config.color)} AS color`
    const options = sql<{ value: string | number; label: string; color?: string }>`
      SELECT ${sql(config.value)} AS value, ${sql(config.label)} AS label ${color}
      FROM ${sql(config.table)} ORDER BY ${sql(config.label)}`.pipe(
        Effect.map((rows) => rows.map((r): Option => {
          const value = String(r.value)
          return {
            value,
            label: r.label,
            ...(config.href ? { href: config.href(value) } : {}),
            ...(typeof r.color === "string" ? { color: r.color } : {})
          }
        }))
      )
    return { table: config.table, options } satisfies Lookup
  })

/** `value -> label` map, for rendering foreign keys in tables. */
export const labels = (options: ReadonlyArray<Option>): ReadonlyMap<string, string> =>
  new Map(options.map((o) => [o.value, o.label]))
