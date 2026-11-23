/**
 * One row's actions on a table: save (create or update) from the dialog's
 * draft, open the edit dialog, delete. The lock and the tenant come from the
 * server, never the draft, and rows outside the lock don't exist.
 *
 * Internal to the resource modules.
 */
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import { Effect } from "effect"
import { toast, unexpected } from "../Feedback.tsx"
import * as Form from "../Form.ts"
import { construct, type Wired } from "./context.ts"
import type { Lock, Model } from "./table.ts"
import type { Fields, IdKey, ModelLike } from "./types.ts"

export const make = <
  Name extends string,
  M extends ModelLike,
  Id extends IdKey<M>,
  Sortable extends Fields<M>,
  FK extends string,
  T,
  L,
  QK extends string
>(
  w: Wired<Name, M, Id, Sortable, FK, T, L>,
  t: Model<Name, M, Id, Sortable, FK, T, L, QK>
) => {
  type IdType = M["fields"][Id]["Type"]
  const { lockKey, ns } = t
  const { model, idColumn } = w

  const save = (id: IdType | undefined, lock: Lock) =>
    Effect.gen(function*() {
      const repo = yield* w.Repo
      const raw = yield* t.readDraft
      // The lock and tenant are not in the form; the server sets them (and ignores any sent value).
      const locked = lockKey !== undefined && lock !== undefined ? { ...raw, [lockKey]: lock } : raw
      const draft = w.scope === undefined ? locked : { ...locked, [w.scope.column]: (yield* w.scope.value).encoded }
      // Unlocked tables skip the check: the update itself reports a missing row.
      if (id !== undefined && lock !== undefined) yield* t.findInScope(id, lock)
      const row = id === undefined
        ? yield* repo.insert(construct(model.insert, yield* Form.decode(model.jsonCreate, draft)))
        : yield* repo.update(construct(model.update, { ...(yield* Form.decode(model.jsonUpdate, draft)), [idColumn]: id }))
      return [t.closeDialog, toast(`${id === undefined ? "Created" : "Saved"} ${w.label(row)}`)]
    }).pipe(
      Effect.catchTags({
        SchemaError: (e) => Effect.succeed(t.fieldErrors(Form.errors(t.keys, e))),
        SqlError: t.saveError,
        SignalsError: unexpected,
        NoSuchElementError: w.goneToast,
        // A reference to a row of another tenant (or a deleted one).
        InvalidReference: (e) => {
          const message = w.messages.invalidReference[e.column] ?? `That ${e.column} no longer exists`
          return Effect.succeed(e.column === lockKey ? toast(message, "error") : t.fieldErrors({ [e.column]: message }))
        }
      })
    )

  const edit = (id: IdType, lock: Lock) =>
    Effect.gen(function*() {
      const row = yield* t.findInScope(id, lock)
      const draft = Object.fromEntries(
        Object.entries(Form.toDraft(model.jsonUpdate, row, row[idColumn])).filter(([k]) => !t.serverOwned(k))
      )
      return Datastar.patchSignals({ [ns]: { dialog: true, draft, errors: t.noErrors } })
    }).pipe(
      Effect.catchTags({ NoSuchElementError: w.goneToast, SchemaError: unexpected, SqlError: unexpected })
    )

  const remove = (id: IdType, lock: Lock, deleted: Datastar.Events) =>
    Effect.gen(function*() {
      const repo = yield* w.Repo
      if (lock !== undefined) yield* t.findInScope(id, lock)
      yield* repo.delete(id)
      return deleted
    }).pipe(
      Effect.catchTags({
        SqlError: (e) =>
          e.reason._tag === "ConstraintError"
            ? Effect.succeed(toast(w.messages.deleteRestricted ?? `This ${w.noun} is still referenced elsewhere.`, "error"))
            : unexpected(e),
        SchemaError: unexpected,
        NoSuchElementError: w.goneToast
      })
    )

  return { save, edit, remove }
}
