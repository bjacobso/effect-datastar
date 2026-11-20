/**
 * CRUD repository = `SqlModel.makeRepository` (insert/update/findById/delete)
 * + derived paginated `list` + reactivity.
 *
 * Every mutation invalidates the table's reactivity key, and `live(q)` is a
 * Stream that re-runs `list(q)` whenever that key is invalidated, so any number
 * of open browser tabs re-render on change.
 */
import { type Cause, Effect, Schema, type Stream } from "effect"
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

/** The repository a resource works with. */
export interface Repo<S extends Model.Any, Id extends keyof S["fields"], Sortable extends string, FK extends string> {
  readonly findById: (
    id: S["fields"][Id]["Type"]
  ) => Effect.Effect<S["Type"], Cause.NoSuchElementError | Schema.SchemaError | SqlError.SqlError>
  readonly list: (q: ListQuery<Sortable, FK>) => Effect.Effect<Page<S["Type"]>, SqlError.SqlError | Schema.SchemaError>
  /** Re-emits the page whenever the table is mutated. */
  readonly live: (q: ListQuery<Sortable, FK>) => Stream.Stream<Page<S["Type"]>, SqlError.SqlError | Schema.SchemaError>
  readonly insert: (value: S["insert"]["Type"]) => Effect.Effect<S["Type"], Schema.SchemaError | SqlError.SqlError>
  readonly update: (value: S["update"]["Type"]) => Effect.Effect<S["Type"], Schema.SchemaError | SqlError.SqlError>
  readonly delete: (id: S["fields"][Id]["Type"]) => Effect.Effect<void, Schema.SchemaError | SqlError.SqlError>
}

export const make = <
  S extends Model.Any & Schema.Codec<any, any, never, never>,
  const Id extends (keyof S["Type"]) & (keyof S["update"]["Type"]) & (keyof S["fields"]) & string,
  Sortable extends string,
  FK extends string
>(
  model: S,
  options: { readonly table: string; readonly idColumn: Id; readonly query: QueryDef<Sortable, FK> }
): Effect.Effect<Repo<S, Id, Sortable, FK>, never, SqlClient.SqlClient | Reactivity.Reactivity> =>
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

    // The model is constrained to need no services, which TS cannot see through the generic.
    const repo = {
      findById: base.findById,
      list,
      live: (q: ListQuery<Sortable, FK>) => reactivity.stream(keys, list(q)),
      insert: (value: S["insert"]["Type"]) => reactivity.mutation(keys, base.insert(value)),
      update: (value: S["update"]["Type"]) => reactivity.mutation(keys, base.update(value)),
      delete: (id: S["fields"][Id]["Type"]) => reactivity.mutation(keys, base.delete(id))
    }
    return repo as unknown as Repo<S, Id, Sortable, FK>
  })

