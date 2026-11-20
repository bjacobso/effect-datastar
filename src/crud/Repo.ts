/**
 * CRUD repository = `SqlModel.makeRepository` (insert/update/findById/delete)
 * + derived paginated `list` + reactivity.
 *
 * Every mutation invalidates the table's reactivity key, and `live(q)` is a
 * Stream that re-runs `list(q)` whenever that key is invalidated, so any number
 * of open browser tabs re-render on change.
 */
import { Effect, Schema } from "effect"
import { Reactivity } from "effect/reactivity"
import type { Model } from "effect/schema"
import { SqlClient, SqlModel } from "effect/sql"
import type { SqlError } from "effect/sql"
import type { ListQuery, QueryDef } from "./Query.ts"

export interface Page<A> {
  readonly rows: ReadonlyArray<A>
  readonly total: number
  readonly page: number
  readonly pages: number
}

export const make = <
  S extends Model.Any & Schema.Codec<any, any, never, never>,
  const Id extends (keyof S["Type"]) & (keyof S["update"]["Type"]) & (keyof S["fields"]) & string,
  Sortable extends string,
  FK extends string
>(
  model: S,
  options: { readonly table: string; readonly idColumn: Id; readonly query: QueryDef<Sortable, FK> }
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const reactivity = yield* Reactivity.Reactivity
    const base = yield* SqlModel.makeRepository(model, {
      tableName: options.table,
      spanPrefix: options.table,
      idColumn: options.idColumn
    })
    const keys = [options.table]
    const decodeRows = Schema.decodeUnknownEffect(Schema.Array(model))
    const table = sql(options.table)

    const list = (q: ListQuery<Sortable, FK>): Effect.Effect<Page<S["Type"]>, SqlError.SqlError | Schema.SchemaError> =>
      Effect.gen(function*() {
        const where = options.query.where(sql, q)
        const [rows, counted] = yield* Effect.all([
          sql`SELECT * FROM ${table} ${where} ${options.query.orderBy(sql, q, options.idColumn)}
              LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
          sql<{ total: number }>`SELECT COUNT(*) AS total FROM ${table} ${where}`
        ], { concurrency: "unbounded" })
        const total = counted[0]?.total ?? 0
        return {
          rows: yield* decodeRows(rows),
          total,
          page: q.page,
          pages: Math.max(1, Math.ceil(total / q.pageSize))
        }
      }).pipe(Effect.withSpan(`${options.table}.list`))

    return {
      findById: base.findById,
      list,
      /** Re-emits the page whenever the table is mutated. */
      live: (q: ListQuery<Sortable, FK>) => reactivity.stream(keys, list(q)),
      insert: (value: S["insert"]["Type"]) => reactivity.mutation(keys, base.insert(value)),
      update: (value: S["update"]["Type"]) => reactivity.mutation(keys, base.update(value)),
      delete: (id: S["fields"][Id]["Type"]) => reactivity.mutation(keys, base.delete(id))
    }
  })

