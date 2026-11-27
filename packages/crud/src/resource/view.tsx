/** @jsxImportSource @effect-datastar/ui */
/**
 * A table, rendered: the section with its filters, live table, paging and
 * create/edit dialog (`View`), the dialog alone (`Editor`, for the detail
 * page), a whole table and a single row (for the live view's patches), and
 * the relation selects re-sent when their options change.
 *
 * Internal to the resource modules.
 */
import * as stylex from "@stylexjs/stylex"
import * as ds from "@effect-datastar/datastar/Attrs.ts"
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import * as Endpoint from "@effect-datastar/datastar/Endpoint.ts"
import { Action, type Signal, Signals } from "@effect-datastar/datastar/Expr.ts"
import { Button } from "@effect-datastar/ui/Button.tsx"
import { Skeleton } from "@effect-datastar/ui/display.tsx"
import { render } from "@effect-datastar/ui/Html.ts"
import { Effect, Schema } from "effect"
import * as Bulk from "../Bulk.tsx"
import * as Components from "../components.tsx"
import type * as Query from "../Query.ts"
import type * as Repo from "../Repo.ts"
import * as UrlState from "../UrlState.ts"
import type { Wired } from "./context.ts"
import type { TableEndpoints } from "./endpoints.ts"
import { cell, styles } from "./render.tsx"
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
  t: Model<Name, M, Id, Sortable, FK, T, L, QK>,
  endpoints: TableEndpoints<Name, M, Id, Sortable, FK, T, L>
) => {
  type Row = M["Type"]
  type Q = Query.ListQuery<Sortable, QK>
  const { ns, path, search, bulkPaths, spec } = t
  const { bulkRemove, bulkUpdate, create, edit, remove, restore, update, view } = endpoints

  /** Form selects whose options come from lookups; replaced so `data-bind` re-applies the signal value. */
  const fieldSelects = (lookups: Components.Lookups, only?: ReadonlySet<string>): Array<Datastar.DatastarEvent> =>
    t.scopedRelations.filter(([key]) => only === undefined || only.has(key)).flatMap(([key]) => {
      const field = t.fields.find((f) => f.key === key)
      return field
        ? [Datastar.patchElements(
          render(
            <Components.FieldSelect prefix={ns} field={field} draft={path("draft")} errors={path("errors")} lookup={lookups[key]} />
          ),
          { selector: `#${Components.fieldId(ns, key)}`, mode: "replace" }
        )]
        : []
    })
  /** Filter and form selects whose options come from lookups. */
  const relationSelects = (lookups: Components.Lookups, only?: ReadonlySet<string>): Array<Datastar.DatastarEvent> => [
    ...t.scopedRelations.filter(([key]) => only === undefined || only.has(key)).flatMap(([key]) => {
      const filter = spec.query.filters.find((f) => f.key === key)
      return filter
        ? [Datastar.patchElements(
          render(<Components.FilterSelect prefix={ns} filter={filter} query={path("query")} lookup={lookups[key]} />),
          { selector: `#${Components.filterId(ns, key)}`, mode: "replace" }
        )]
        : []
    }),
    ...fieldSelects(lookups, only)
  ]

  const columnsFor = (lookups: Components.Lookups): ReadonlyArray<Components.Column<Row>> =>
    t.columns.map((field) => ({
      field,
      sortable: (w.query.sortable as ReadonlyArray<string>).includes(field.key),
      render: cell(w, field, lookups, { link: true })
    }))

  const paginationId = `${ns}-pagination`
  /** A rendered table without its pagination, and the pagination (`""` if it has none). */
  const splitPagination = (html: string): readonly [string, string] => {
    const start = html.lastIndexOf(`<nav id="${paginationId}"`)
    const end = html.indexOf("</nav>", start)
    return start < 0 || end < 0
      ? [html, ""]
      : [html.slice(0, start) + html.slice(end + 6), html.slice(start, end + 6)]
  }

  const rowId = (row: Row) => `${ns}-${String(row[w.idColumn])}`
  const actions = (lock: Lock) => (row: Row) => {
    const id = String(row[w.idColumn])
    return (
      <Components.RowActions
        edit={edit.call({ id }, { search: search(lock) })}
        remove={Action.confirm(`Delete ${w.label(row)}?`, remove.call({ id }, { search: search(lock) }))}
      />
    )
  }

  const select: Components.Select<Row> = {
    header: <Bulk.SelectAll paths={bulkPaths} />,
    cell: (row) => <Bulk.SelectRow paths={bulkPaths} id={w.encodeId(row[w.idColumn])} label={w.label(row)} />
  }

  /** A single row, as rendered in the table (same id), for row-level patches. */
  const RowView = (props: { readonly row: Row; readonly lookups: Components.Lookups; readonly lock: Lock }) => (
    <Components.TableRow
      row={props.row}
      columns={columnsFor(props.lookups)}
      rowId={rowId}
      actions={actions(props.lock)}
      select={select}
    />
  )

  const TableView = (props: {
    readonly page: Repo.Page<Row>
    readonly current: { readonly sort: string; readonly dir: Query.Dir }
    readonly lookups: Components.Lookups
    readonly lock: Lock
  }) => (
    <Components.TablePanel id={`${ns}-table`}>
      <Bulk.Bar
        id={`${ns}-bulk`}
        paths={bulkPaths}
        plural={`${w.noun}s`}
        setters={t.setFields.map((f) => ({
          key: f.key,
          label: f.label,
          options: Components.fieldOptions(f, props.lookups[f.key]),
          nullable: f.nullable
        }))}
        update={bulkUpdate.call(undefined, {
          include: [path("selection"), path("bulk")],
          search: search(props.lock)
        })}
        remove={bulkRemove.call(undefined, { include: [path("selection")], search: search(props.lock) })}
      />
      <Components.Table
        id={`${ns}-rows`}
        columns={columnsFor(props.lookups)}
        rows={props.page.rows}
        rowId={rowId}
        query={path("query")}
        current={props.current}
        actions={actions(props.lock)}
        select={select}
      />
      <Components.Pagination
        id={paginationId}
        query={path("query")}
        page={props.page.page}
        pages={props.page.pages}
        total={props.page.total}
        pageSizes={w.query.pageSizes}
      />
    </Components.TablePanel>
  )

  const editorSig = Signals.from(
    Schema.Struct({
      draft: Schema.Struct({ id: Schema.Unknown }),
      errors: Schema.Unknown,
      dialog: Schema.Boolean
    }),
    ns
  )
  const draftSig = editorSig.draft as unknown as Signal<unknown>
  const draftIdSig = editorSig.draft.id

  /** The create/edit dialog (create when `draft.id` is blank). */
  const Dialog = (props: { readonly lock: Lock; readonly lookups?: Components.Lookups | undefined }) => {
    const updateCall = update.call(
      { id: Endpoint.js(draftIdSig) },
      { include: [path("draft")], search: search(props.lock) }
    )
    const createCall = create.call(undefined, { include: [path("draft")], search: search(props.lock) })
    return (
      <Components.FormDialog
        prefix={ns}
        noun={w.noun}
        fields={t.fields}
        draft={path("draft")}
        errors={path("errors")}
        open={path("dialog")}
        submit={Action.raw(
          `if (${draftIdSig.isNotNull().and(draftIdSig.neq("")).toExpr()}) { ${updateCall} } else { ${createCall} }`
        )}
        lookups={props.lookups}
      />
    )
  }

  interface Initial {
    readonly page: Repo.Page<Row>
    readonly lookups: Components.Lookups
  }

  /**
   * Filters, live table, paging and dialog, server-rendered for `query`. The
   * live stream then takes over. Carries its own `data-signals`, so it can sit
   * inside any page.
   */
  const View = (props: { readonly query: Q; readonly lock: Lock; readonly initial?: Initial | undefined }) => {
    const liveCall = view.call(undefined, { include: [path("query")], search: search(props.lock) })
    const openCreate = Action.seq(
      draftSig.set(t.blankDraft),
      editorSig.errors.set(t.noErrors),
      editorSig.dialog.set(true)
    )
    return (
      <section
        id={`${ns}-section`}
        {...stylex.props(styles.section)}
        $signals={t.signals.init({
          [ns]: {
            query: props.query,
            draft: t.blankDraft,
            errors: t.noErrors,
            dialog: false,
            selection: [],
            bulk: { field: "", value: "" },
            _page: props.initial ? w.pageIds(props.initial.page.rows) : [],
            ...(spec.syncUrl ? UrlState.initial(t.urlFor(spec.full(props.query, props.lock))) : {})
          }
        })}
        $effect={spec.syncUrl ? UrlState.effect(ns) : undefined}
        $on={spec.syncUrl
          ? {
            popstate: {
              run: UrlState.popstate(ns, restore.call(undefined, { include: [], searchExpr: "location.search" })),
              window: true
            }
          }
          : undefined}
      >
        <header {...stylex.props(styles.bar)}>
          {spec.heading === "h1"
            ? <h1 {...stylex.props(styles.h1)}>{spec.title}</h1>
            : <h2 {...stylex.props(styles.h2)}>{spec.title}</h2>}
          <Button variant="primary" icon="plus" {...ds.on("click", openCreate.toExpr())}>
            {`New ${w.noun}`}
          </Button>
        </header>
        <Components.FilterBar prefix={ns} filters={spec.query.filters} query={path("query")} lookups={props.initial?.lookups} />
        <div
          id={`${ns}-live`}
          $init={liveCall}
          $onSignalPatch={{ run: liveCall, include: [path("query")], debounce: "200ms" }}
          // Here, not on the section: an element has one `data-effect`, and the section's keeps the URL.
          $effect={Bulk.prune(bulkPaths)}
        >
          {props.initial
            ? <TableView page={props.initial.page} current={props.query} lookups={props.initial.lookups} lock={props.lock} />
            : (
              <Components.TablePanel id={`${ns}-table`} busy>
                <div {...stylex.props(styles.loading)}>
                  <Skeleton lines={4} />
                </div>
              </Components.TablePanel>
            )}
        </div>
        <Dialog lock={props.lock} lookups={props.initial?.lookups} />
      </section>
    )
  }

  /** Just the edit dialog and its signals, for a page without the table (the detail page). */
  const Editor = (props: { readonly lookups: Components.Lookups }) => (
    <div $signals={t.editorSignals.init({ [ns]: { draft: t.blankDraft, errors: t.noErrors, dialog: false } })}>
      <Dialog lock={undefined} lookups={props.lookups} />
    </div>
  )

  /** First page + lookups for the initial render; `None` (and logged) on failure, so the shell is still served. */
  const initial = (q: Q, lock: Lock) =>
    Effect.gen(function*() {
      const repo = yield* w.Repo
      const services = yield* w.relationServices
      let current = q
      let page = yield* repo.list(spec.full(current, lock))
      if (page.page > page.pages) {
        current = { ...current, page: page.pages }
        page = yield* repo.list(spec.full(current, lock))
      }
      return { query: current, page, lookups: yield* w.lookupsFor(services) }
    }).pipe(
      Effect.tapError((e) => Effect.logError("initial render failed", e)),
      Effect.option
    )

  return { fieldSelects, relationSelects, splitPagination, RowView, TableView, View, Editor, initial }
}

/** A table's views (see `make`). */
export type Views<
  Name extends string,
  M extends ModelLike,
  Id extends IdKey<M>,
  Sortable extends Fields<M>,
  FK extends string,
  T,
  L,
  QK extends string
> = ReturnType<typeof make<Name, M, Id, Sortable, FK, T, L, QK>>
