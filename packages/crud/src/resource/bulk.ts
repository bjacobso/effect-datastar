/**
 * Bulk actions on a table's selection (`POST /users/bulk/delete`,
 * `POST /users/bulk/update`): the ids are decoded with the id field's schema
 * (1 to `MAX_SELECTION`), the update's value with the field's `jsonUpdate`
 * schema, and the repo runs each in one transaction. Rows outside the lock
 * count as gone. The toast reports partial failures; rows the database kept
 * stay selected (see `Bulk.tsx` for the UI).
 *
 * Internal to the resource modules.
 */
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import { Data, Effect, Schema } from "effect"
import * as Bulk from "../Bulk.tsx"
import { toast, unexpected } from "../Feedback.tsx"
import * as Form from "../Form.ts"
import * as Query from "../Query.ts"
import { readSignals, type Wired } from "./context.ts"
import type { Lock, Model } from "./table.ts"
import type { Fields, IdKey, ModelLike } from "./types.ts"

/** A bulk update's value is not a valid value of its field. */
class BulkValueError extends Data.TaggedError("BulkValueError")<{ readonly label: string }> {}

export const make = <
  Name extends string,
  M extends ModelLike,
  Id extends IdKey<M>,
  Sortable extends Fields<M>,
  FK extends string,
  T,
  L,
  A,
  QK extends string
>(
  w: Wired<Name, M, Id, Sortable, FK, T, L, A>,
  t: Model<Name, M, Id, Sortable, FK, T, L, A, QK>
) => {
  type Row = M["Type"]
  type IdType = M["fields"][Id]["Type"]
  const { ns } = t

  const readSelection = readSignals(ns, Schema.Struct({ selection: w.SelectionSchema }))
  const readBulkUpdate = readSignals(
    ns,
    Schema.Struct({ selection: w.SelectionSchema, bulk: Schema.Struct({ field: Schema.String, value: Schema.String }) })
  )
  const only = (lock: Lock) => (row: Row) => t.inScope(row, lock)
  /** After a bulk action: the toast, and the selection that is left (`[]` unless something was kept). */
  const done = (summary: { readonly message: string; readonly kind: "ok" | "error" }, keep: ReadonlyArray<IdType>) => [
    toast(summary.message, summary.kind),
    Datastar.patchSignals({ [ns]: { selection: w.encodeIds(keep) } })
  ]
  const badSelection = () => Effect.succeed(toast("Select at least one row", "error"))

  /** Delete the selection in one transaction. Rows the database keeps (references) stay selected. */
  const remove = (lock: Lock) =>
    Effect.gen(function*() {
      yield* w.require("bulk")
      const repo = yield* w.Repo
      const { selection } = yield* readSelection
      const result = yield* repo.deleteMany(selection, { only: only(lock) })
      const outcome = { done: result.done.length, missing: result.missing.length, restricted: result.restricted.length }
      return done(Bulk.summary("deleted", outcome, w.messages.bulkDeleteRestricted), result.restricted)
    }).pipe(
      Effect.catchTags({
        Forbidden: (e) => Effect.succeed(toast(e.message, "error")),
        SignalsError: badSelection,
        SchemaError: unexpected,
        SqlError: unexpected
      })
    )

  /** Set one of the `bulk.set` fields on the selection, in one transaction. */
  const update = (lock: Lock) =>
    Effect.gen(function*() {
      yield* w.require("bulk")
      const repo = yield* w.Repo
      const { selection, bulk } = yield* readBulkUpdate
      const field = t.setFields.find((f) => f.key === bulk.field)
      if (field === undefined) return toast(`${bulk.field} can't be set in bulk`, "error")
      const raw = field.nullable && bulk.value === Query.NULL ? "" : field.kind === "boolean" ? bulk.value === "true" : bulk.value
      const schema = Schema.Struct({ [field.key]: w.model.jsonUpdate.fields[field.key]! }) as unknown as
        & Schema.Codec<Record<string, unknown>, unknown>
        & { readonly fields: Schema.Struct.Fields }
      const patch = yield* Form.decode(schema, { [field.key]: raw }).pipe(
        Effect.mapError(() => new BulkValueError({ label: field.label }))
      )
      const result = yield* repo.updateMany(selection, patch as Partial<M["update"]["Type"]>, { only: only(lock) })
      return done(Bulk.summary("updated", { done: result.done.length, missing: result.missing.length, restricted: 0 }, () => ""), [])
    }).pipe(
      Effect.catchTags({
        Forbidden: (e) => Effect.succeed(toast(e.message, "error")),
        SignalsError: badSelection,
        BulkValueError: (e) => Effect.succeed(toast(`Invalid ${e.label.toLowerCase()}`, "error")),
        // A reference to a row of another tenant (or a deleted one): nothing was changed.
        InvalidReference: (e) =>
          Effect.succeed(toast(w.messages.invalidReference[e.column] ?? `That ${e.column} no longer exists`, "error")),
        SchemaError: unexpected,
        SqlError: (e) => {
          const match = e.reason._tag === "UniqueViolation"
            ? w.pick(w.messages.unique, e)
            : e.reason._tag === "ConstraintError"
            ? w.pick(w.messages.invalidReference, e)
            : undefined
          return match ? Effect.succeed(toast(match[1], "error")) : unexpected(e)
        }
      })
    )

  return { remove, update }
}
