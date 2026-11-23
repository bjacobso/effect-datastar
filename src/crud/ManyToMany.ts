/**
 * Many-to-many fields: a model field holding the ids of related rows, stored
 * in a join table instead of a column.
 *
 *   // the model: storage
 *   tags: ManyToMany.Ids(TagId, { table: "user_tags", from: "userId", to: "tagId" })
 *
 *   // the app: what the ids point at (labels, options, live updates)
 *   Users.with({ manyToMany: { tags: Tags } })
 *
 * The field is a plain `ReadonlyArray<TagId>` in every variant of the model,
 * so rows, the JSON API (read and write) and form drafts all carry it. The
 * `through` annotation tells the rest of the CRUD layer where it lives:
 *
 *   - `Repo` reads it with each row (one correlated subquery, no extra
 *     statement), writes it in the same transaction as the row, and reports a
 *     change to it as a change to the row's `tags` column.
 *   - `Query` filters on it with the `has` operator (`?tags=3`).
 *   - `Field` derives a multi-select widget for it.
 *
 * The join table should reference both tables with `ON DELETE CASCADE`, so
 * deleting either side removes its join rows. With a tenant, give it the
 * tenant column too (`through.tenant`), and composite foreign keys to both
 * sides' `(id, tenant)`: the database then rejects a link across tenants.
 * (`Repo` checks the ids against the tenant first, as it does for any
 * reference, so the user sees "That tag no longer exists".)
 *
 * SQLite-specific: the read uses `json_group_array`.
 */
import { Effect, Schema } from "effect"
import { SqlError } from "effect/sql"
import type { Statement } from "effect/sql"
import type * as Field from "./Field.ts"

export type Through = Field.Through

/** The ids of related rows, stored in the join table `through`. */
export const Ids = <S extends Schema.Top>(id: S, through: Through) => Schema.Array(id).annotate({ through })

/** A many-to-many field of a model, as `Field.links` finds it. */
export type Link = Field.FieldInfo & { readonly through: Through }

type Sql = Statement.Constructor

const compare = (a: unknown, b: unknown) => (a === b ? 0 : (a as number) < (b as number) ? -1 : 1)

/** Distinct and sorted: the canonical form of an id list (as `select` reads it). */
export const canonical = <A>(ids: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(ids)].sort(compare)

/**
 * `(SELECT json_group_array(tagId) ...) AS tags`: the field's ids for each row
 * of `table`, as a JSON array text, in ascending order. `parse` turns it back
 * into an array before the row is decoded.
 */
export const select = (sql: Sql, link: Link, table: string, idColumn: string): Statement.Fragment => {
  const { from, to } = link.through
  return sql`(SELECT json_group_array(${sql(to)}) FROM (
    SELECT ${sql(to)} FROM ${sql(link.through.table)}
    WHERE ${sql(from)} = ${sql(table)}.${sql(idColumn)} ORDER BY ${sql(to)}
  )) AS ${sql(link.key)}`
}

/** Replaces each link's JSON text (from `select`) with the array, in place. */
export const parse = (links: ReadonlyArray<Link>, rows: ReadonlyArray<Record<string, unknown>>) => {
  for (const row of rows) {
    for (const link of links) {
      const raw = row[link.key]
      row[link.key] = typeof raw === "string" ? JSON.parse(raw) : []
    }
  }
  return rows
}

/** `WHERE` clause: rows whose `link` includes `value` (an encoded id). */
export const has = (sql: Sql, link: Link, idColumn: string, value: unknown): Statement.Fragment => {
  const { from, to, table } = link.through
  return sql`${sql(idColumn)} IN (SELECT ${sql(from)} FROM ${sql(table)} WHERE ${sql(to)} = ${value})`
}

/**
 * A foreign key failure on the join table names the field, so the resource's
 * `invalidReference` message for it is picked (SQLite's message names no column).
 */
const nameField = (link: Link) => (e: SqlError.SqlError) =>
  e.reason._tag === "ConstraintError"
    ? Effect.fail(
      new SqlError.SqlError({
        reason: new SqlError.ConstraintError({
          cause: e.reason.cause,
          message: `${e.reason.message ?? "FOREIGN KEY constraint failed"}: ${link.key}`,
          ...(e.reason.operation === undefined ? {} : { operation: e.reason.operation })
        })
      })
    )
    : Effect.fail(e)

/**
 * Makes the join rows of row `id` exactly `ids` (encoded), touching only the
 * difference: nothing at all when they already match. `known` is the current
 * ids when the caller has read them in the same transaction (`[]` for a row
 * just inserted); otherwise they are read first. Run it in the row's transaction.
 */
export const write = (
  sql: Sql,
  link: Link,
  id: unknown,
  ids: ReadonlyArray<unknown>,
  known: ReadonlyArray<unknown> | undefined,
  /** More columns for each new join row (the tenant, see `Through.tenant`). */
  extra: Readonly<Record<string, unknown>> = {}
) =>
  Effect.gen(function*() {
    const { from, to, table } = link.through
    const wanted = canonical(ids)
    const current = known !== undefined
      ? known
      : (yield* sql<{ id: unknown }>`SELECT ${sql(to)} AS id FROM ${sql(table)} WHERE ${sql(from)} = ${id}`)
        .map((r) => r.id)
    const removed = current.filter((v) => !wanted.includes(v))
    const added = wanted.filter((v) => !current.includes(v))
    if (removed.length > 0) {
      yield* sql`DELETE FROM ${sql(table)} WHERE ${sql(from)} = ${id} AND ${
        sql.in(to, removed)
      }`
    }
    if (added.length > 0) {
      yield* sql`INSERT INTO ${sql(table)} ${
        sql.insert(added.map((v) => ({ ...extra, [from]: id, [to]: v })) as unknown as readonly [Record<string, unknown>, ...Array<Record<string, unknown>>])
      }`.pipe(Effect.catchTag("SqlError", nameField(link)))
    }
  })
