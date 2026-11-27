/**
 * A resource's table, without rendering: its signals, the draft and errors of
 * its dialog, the lock (an embed's server-fixed filter) and the tenant.
 *
 * The list page and every embed each have one, in their own signal namespace
 * (`users.*`, `members.*`). An embed adds a lock: one `eq` filter the server
 * fixes from `?scope=`, which also prefills creates and bounds edits and
 * deletes. The views (`view.tsx`), the live table (`live.tsx`), the row
 * actions (`rows.ts`) and the bulk actions (`bulk.ts`) all work from this.
 *
 * Internal to the resource modules.
 */
import type { SignalPath } from "@effect-datastar/datastar/Attrs.ts"
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import { Signals } from "@effect-datastar/datastar/Expr.ts"
import { Cause, Effect, Schema, type Stream } from "effect"
import type { HttpServerRequest } from "effect/http"
import type { SqlError } from "effect/sql"
import type * as Bulk from "../Bulk.tsx"
import { toast, unexpected } from "../Feedback.tsx"
import * as Form from "../Form.ts"
import type * as Query from "../Query.ts"
import { EMBED, readSignals, SCOPE, type Wired } from "./context.ts"
import type { Fields, IdKey, LookupOf, ModelLike, RepoOf } from "./types.ts"

/** An embed's lock value (validated), or `undefined` for the list page's table. */
export type Lock = string | undefined

/** What a table's routes need: its repo, the relations' lookups, the request and the tenant. */
export type Requires<Name extends string, T> = RepoOf<Name> | LookupOf<string> | HttpServerRequest.HttpServerRequest | T

/** The handlers behind a table's routes. */
export interface Handlers<IdType, R> {
  readonly view: (lock: Lock) => Stream.Stream<Datastar.Events, never, R>
  readonly save: (id: IdType | undefined, lock: Lock) => Effect.Effect<Datastar.Events, never, R>
  readonly edit: (id: IdType, lock: Lock) => Effect.Effect<Datastar.Events, never, R>
  /** `deleted`: the events to send once the row is gone. */
  readonly remove: (id: IdType, lock: Lock, deleted: Datastar.Events) => Effect.Effect<Datastar.Events, never, R>
  readonly bulkRemove: (lock: Lock) => Effect.Effect<Datastar.Events, never, R>
  readonly bulkUpdate: (lock: Lock) => Effect.Effect<Datastar.Events, never, R>
}

/** Which table a table route is for. */
export interface Spec<Sortable extends string, QK extends string, FK extends string> {
  /** Signal namespace and DOM id prefix. */
  readonly ns: string
  readonly title: string
  readonly heading: "h1" | "h2"
  readonly query: {
    readonly schema: Schema.Codec<Query.ListQuery<Sortable, QK>, Query.ListQuery<Sortable, QK>>
    readonly initial: Query.ListQuery<Sortable, QK>
    readonly filters: ReadonlyArray<Query.FilterInfo>
  }
  /** The locked filter, if any. */
  readonly lockKey: string | undefined
  /** The query the server runs: the client's, plus the lock. */
  readonly full: (q: Query.ListQuery<Sortable, QK>, lock: Lock) => Query.ListQuery<Sortable, FK>
  /** Mirror the query into the address bar (only one table per page can own the URL). */
  readonly syncUrl: boolean
}

export const model = <
  Name extends string,
  M extends ModelLike,
  Id extends IdKey<M>,
  Sortable extends Fields<M>,
  FK extends string,
  T,
  L,
  QK extends string
>(w: Wired<Name, M, Id, Sortable, FK, T, L>, spec: Spec<Sortable, QK, FK>) => {
  type Row = M["Type"]
  type IdType = M["fields"][Id]["Type"]
  const { ns, lockKey } = spec
  const tenantColumn = w.tenant?.column
  const fields = w.formFields.filter((f) => f.key !== lockKey)
  // The draft, errors and form leave out the lock and the tenant: the server owns those fields.
  const serverOwned = (key: string) => key === lockKey || key === tenantColumn
  const form = {
    fields: Object.fromEntries(
      Object.entries(w.model.jsonCreate.fields as Schema.Struct.Fields).filter(([k]) => !serverOwned(k))
    ) as Schema.Struct.Fields
  }
  const keys = fields.map((f) => f.key)
  const blankDraft = Form.blankDraft(form)
  const noErrors = Form.noErrors(keys)
  const draftSchema = Form.draftSchema(form)

  const editorSchema = { draft: draftSchema, errors: Form.errorsSchema(form), dialog: Schema.Boolean }
  // Bulk selection (see `Bulk`) and, for the table that owns the URL, history state (see `UrlState`).
  const bulkSchema = {
    selection: w.IdsSchema,
    bulk: Schema.Struct({ field: Schema.String, value: Schema.String }),
    _page: w.IdsSchema,
    _url: Schema.optionalKey(Schema.String),
    _nav: Schema.optionalKey(Schema.String),
    _typing: Schema.optionalKey(Schema.Boolean),
    _pushed: Schema.optionalKey(Schema.Boolean)
  }
  const path = (...parts: Array<string>) => [ns, ...parts].join(".") as SignalPath
  const inScope = (row: Row, lock: Lock) => lockKey === undefined || lock === undefined || String(w.get(row, lockKey)) === lock
  const fieldErrors = (errors: Partial<Record<string, string>>) =>
    Datastar.patchSignals({ [ns]: { errors: { ...noErrors, ...errors } } })

  return {
    spec,
    ns,
    lockKey,
    /** The form's fields: not the lock. */
    fields,
    keys,
    blankDraft,
    noErrors,
    serverOwned,
    /** The table's columns: not the lock. */
    columns: w.tableFields.filter((f) => f.key !== lockKey),
    /** Relations other than the lock: their selects get live options. */
    scopedRelations: w.relations.filter(([k]) => k !== lockKey),
    signals: Signals.from(Schema.Struct({ [ns]: Schema.Struct({ query: spec.query.schema, ...editorSchema, ...bulkSchema }) })),
    /** Just the dialog's signals, for a page without the table (the detail page). */
    editorSignals: Signals.from(Schema.Struct({ [ns]: Schema.Struct(editorSchema) })),
    path,
    $: (...parts: Array<string>) => `$${path(...parts)}`,
    /** The search params that pick this table and its lock on the shared routes. */
    search: (lock: Lock) => (lock === undefined ? undefined : { [EMBED]: ns, [SCOPE]: lock }),
    bulkPaths: {
      selection: path("selection"),
      page: path("_page"),
      field: path("bulk", "field"),
      value: path("bulk", "value")
    } satisfies Bulk.Paths,
    /**
     * The fields "Set <field>…" offers: not the lock (an embed's rows keep it), and not a
     * many-to-many field (its value is a set of ids in a join table, which a one-value
     * bulk select can't express, and `Repo.updateMany` doesn't write).
     */
    setFields: (w.config.bulk?.set ?? []).flatMap((key) =>
      key === lockKey ? [] : fields.filter((f) => f.key === key && f.kind !== "ids")
    ),
    readQuery: Effect.map(readSignals(ns, Schema.Struct({ query: spec.query.schema })), (s) => s.query),
    readDraft: Effect.map(readSignals(ns, Schema.Struct({ draft: draftSchema })), (s) => s.draft),
    inScope,
    /** `findById`, but rows outside the lock don't exist. */
    findInScope: (id: IdType, lock: Lock) =>
      Effect.gen(function*() {
        const row = yield* (yield* w.Repo).findById(id)
        return inScope(row, lock) ? row : yield* Effect.fail(new Cause.NoSuchElementError())
      }),
    fieldErrors,
    closeDialog: Datastar.patchSignals({ [ns]: { dialog: false, draft: blankDraft, errors: noErrors } }),
    /** A failed save: a field error for a unique or foreign key violation, else a toast. */
    saveError: (e: SqlError.SqlError) => {
      const match = e.reason._tag === "UniqueViolation"
        ? w.pick(w.messages.unique, e)
        : e.reason._tag === "ConstraintError"
        ? w.pick(w.messages.invalidReference, e)
        : undefined
      if (!match) return unexpected(e)
      // The locked field isn't in the form (e.g. its row was deleted meanwhile): say so in a toast.
      return Effect.succeed(match[0] === lockKey ? toast(match[1], "error") : fieldErrors({ [match[0]]: match[1] }))
    },
    /** Canonical URL for a query, e.g. `/users?teamId=3&sort=name&dir=asc`. */
    urlFor: (q: Query.ListQuery<Sortable, FK>) => {
      const qs = w.query.toSearchParams(q).toString()
      return qs ? `${w.prefix}?${qs}` : w.prefix
    }
  }
}

/** A table's model (see `model`). */
export type Model<
  Name extends string,
  M extends ModelLike,
  Id extends IdKey<M>,
  Sortable extends Fields<M>,
  FK extends string,
  T,
  L,
  QK extends string
> = ReturnType<typeof model<Name, M, Id, Sortable, FK, T, L, QK>>
