/** @jsxImportSource @effect-datastar/ui */
/**
 * The detail page (`GET /users/:id`): the row's fields with Edit and Delete,
 * then its sections (embeds of other resources' tables, or any rendering of
 * the row), kept live by `GET /users/:id/view`. Unknown and malformed ids get
 * a 404 page.
 *
 * Internal to the resource modules.
 */
import * as stylex from "@stylexjs/stylex"
import * as ds from "@effect-datastar/datastar/Attrs.ts"
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import * as Endpoint from "@effect-datastar/datastar/Endpoint.ts"
import { Action } from "@effect-datastar/datastar/Expr.ts"
import * as Shared from "@effect-datastar/datastar/Shared.ts"
import { Button } from "@effect-datastar/ui/Button.tsx"
import { Alert, Card, EmptyState } from "@effect-datastar/ui/display.tsx"
import { render } from "@effect-datastar/ui/Html.ts"
import { Icon } from "@effect-datastar/ui/icons.tsx"
import { Context, Effect, Stream } from "effect"
import { HttpRouter } from "effect/http"
import { Reactivity } from "effect/reactivity"
import { Fragment } from "react"
import * as Components from "../components.tsx"
import { toast, unexpected } from "../Feedback.tsx"
import * as Policy from "../Policy.ts"
import { FROM, type Wired } from "./context.ts"
import type { TableEndpoints } from "./endpoints.ts"
import { cell, html, styles } from "./render.tsx"
import type { Fields, IdKey, ModelLike, SectionInput, SectionOf } from "./types.ts"
import type { Views } from "./view.tsx"

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
  endpoints: TableEndpoints<Name, M, Id, Sortable, FK, NoInfer<T>, NoInfer<L>, NoInfer<A>>,
  /** The list page's table: its dialog and relation selects. */
  list: Views<Name, M, Id, Sortable, FK, NoInfer<T>, NoInfer<L>, NoInfer<A>, QK>,
  sections: ReadonlyArray<SectionInput<M["Type"], M["fields"][Id]["Type"]>>
) => {
  type Row = M["Type"]
  type IdType = M["fields"][Id]["Type"]
  const { name, prefix, idColumn } = w
  const { edit, remove } = endpoints

  /** The row's fields with Edit and Delete, or a notice once it has been deleted. Re-rendered live. */
  const RecordView = (props: {
    readonly row: Row | undefined
    readonly lookups: Components.Lookups
    readonly capabilities?: Policy.Capabilities | undefined
  }) => {
    const row = props.row
    if (row === undefined) {
      return (
        <section id={`${name}-record`} {...stylex.props(styles.record)}>
          <h1 {...stylex.props(styles.h1)}>Not found</h1>
          <Alert tone="warning">{`This ${w.noun} no longer exists.`}</Alert>
        </section>
      )
    }
    const caps = props.capabilities ?? Policy.allCapabilities
    const id = String(row[idColumn])
    return (
      <section id={`${name}-record`} {...stylex.props(styles.record)}>
        <header {...stylex.props(styles.bar, styles.flush)}>
          <h1 {...stylex.props(styles.h1)}>{w.label(row)}</h1>
          {(caps.update || caps.delete) && (
            <span {...stylex.props(styles.actions)}>
              {caps.update && <Button icon="edit" {...ds.on("click", edit.call({ id }))}>Edit</Button>}
              {caps.delete && (
                <Button
                  variant="danger"
                  icon="trash"
                  {...ds.on(
                    "click",
                    Action.confirm(`Delete ${w.label(row)}?`, remove.call({ id }, { search: { [FROM]: "detail" } })).toExpr()
                  )}
                >
                  Delete
                </Button>
              )}
            </span>
          )}
        </header>
        <Card>
          <dl {...stylex.props(styles.dl)}>
            {w.tableFields.map((field) => {
              const custom = cell(w, field, props.lookups, { link: false })
              return (
                <div key={field.key} {...stylex.props(styles.dlRow)}>
                  <dt {...stylex.props(styles.dt)}>{field.label}</dt>
                  <dd id={`${name}-record-${field.key}`} {...stylex.props(styles.dd)}>
                    {custom ? custom(row) : <Components.CellValue field={field} value={w.get(row, field.key)} />}
                  </dd>
                </div>
              )
            })}
          </dl>
        </Card>
      </section>
    )
  }

  const findRecord = (id: IdType) =>
    Effect.flatMap(w.Repo, (repo) => repo.findById(id)).pipe(
      Effect.map((row): Row | undefined => row),
      Effect.catchTag("NoSuchElementError", () => Effect.succeed(undefined))
    )

  /** Shared live records, by tenant and id. */
  const records = Shared.registry()

  /**
   * Live record: re-renders when this row changes (its record key, e.g.
   * `users[orgId=1]:42`, which the repo invalidates with every change to the
   * row) or a related table does (e.g. a rename), and re-sends the edit
   * dialog's relation selects when their options change. Changes to other rows
   * of the table don't wake it, and a re-render that comes out the same isn't sent.
   *
   * Tabs showing the same record share it (see `Shared`): one read and one
   * render per change, and a tab that stops reading is switched to the latest
   * record instead of queueing every version.
   */
  const record = Endpoint.make(
    "GET",
    "/:id/view",
    Stream.unwrap(Effect.gen(function*() {
      const caps = yield* w.capabilities
      if (!caps.read) return Stream.fromEffect(Effect.succeed([toast(`Not allowed to read ${w.noun}s`, "error")] as ReadonlyArray<Datastar.DatastarEvent>))
      const reactivity = yield* Reactivity.Reactivity
      const repo = yield* w.Repo
      const services = yield* w.relationServices
      const id = yield* w.readId
      const tenantKey = w.scope === undefined ? null : (yield* w.scope.value).encoded
      const tenantOnly = w.tenant === undefined
        ? Context.empty()
        : Context.pick(w.tenant.service)(yield* Effect.context<T>())
      // The row's record key under the tenant's table key (as `Reactivity` derives it from
      // `{ [key]: [id] }`), the bare table key for invalidations from outside the repo, and
      // the related tables' keys.
      const recordKey = `${yield* repo.key}:${String(w.encodeId(id))}`
      const keys = [recordKey, name, ...yield* Effect.forEach(services, ([, l]) => l.key)]
      const source = Effect.gen(function*() {
        const context = yield* Effect.context<T>()
        let lastOptions: string | undefined
        let lastRecord: string | undefined
        let lookups: Components.Lookups = {}
        const read = Effect.all([
          repo.findById(id).pipe(
            Effect.map((row): Row | undefined => row),
            Effect.catchTag("NoSuchElementError", () => Effect.succeed(undefined))
          ),
          w.lookupsFor(services)
        ])
        const deltas = reactivity.stream([...new Set(keys)], read).pipe(
          Stream.map(([row, loaded]): ReadonlyArray<Datastar.DatastarEvent> => {
            lookups = loaded
            const html = render(<RecordView row={row} lookups={loaded} capabilities={caps} />)
            const events = html === lastRecord ? [] : [Datastar.patchElements(html)]
            lastRecord = html
            const key = JSON.stringify(loaded)
            if (lastOptions !== undefined && key !== lastOptions) events.push(...list.fieldSelects(loaded))
            lastOptions = key
            return events
          }),
          Stream.provideContext(context),
          Stream.catch((error) => Stream.fromEffect(Effect.map(unexpected(error), (e) => [e])))
        )
        const snapshot = (first: boolean): ReadonlyArray<Datastar.DatastarEvent> | undefined =>
          lastRecord === undefined
            ? undefined
            // A tab that fell behind may have missed new select options too.
            : first
            ? [Datastar.patchElements(lastRecord)]
            : [Datastar.patchElements(lastRecord), ...list.fieldSelects(lookups)]
        return { deltas, snapshot } satisfies Shared.Source
      }).pipe(Effect.provideContext(tenantOnly as Context.Context<T>))
      return Shared.subscribe(records, JSON.stringify([tenantKey, Policy.capabilitiesKey(caps), w.encodeId(id)]), source)
    })).pipe(Stream.catch((error) => Stream.fromEffect(unexpected(error)))),
    { prefix, include: [] }
  )

  const forbidden = html(
    w.layout({
      title: "Forbidden",
      active: prefix,
      children: (
        <main>
          <Card>
            <EmptyState icon="alert" title="Forbidden">
              {`You do not have permission to view ${w.title.toLowerCase()}.`}
            </EmptyState>
          </Card>
        </main>
      )
    }),
    403
  )

  const notFound = html(
    w.layout({
      title: "Not found",
      active: prefix,
      children: (
        <main>
          <Card>
            <EmptyState
              icon="alert"
              title="Not found"
              action={<a href={prefix} {...stylex.props(styles.link)}>{`Back to ${w.title}`}</a>}
            >
              {`There is no such ${w.noun}.`}
            </EmptyState>
          </Card>
        </main>
      )
    }),
    404
  )

  /** The page; `sectionOf` renders the embeds among its sections. */
  const route = (sectionOf: SectionOf) =>
    HttpRouter.route(
      "GET",
      `${prefix}/:id`,
      Effect.gen(function*() {
        const caps = yield* w.capabilities
        if (!caps.read) return yield* forbidden
        const id = yield* Effect.option(w.readId)
        if (id._tag === "None") return yield* notFound
        const row = yield* findRecord(id.value)
        if (row === undefined) return yield* notFound
        const lookups = yield* w.lookupsFor(yield* w.relationServices)
        const extra = yield* Effect.all(
          sections.map((section) => typeof section === "function" ? section(row) : sectionOf(section)(row[idColumn]))
        )
        return yield* html(w.layout({
          title: w.label(row),
          active: prefix,
          children: (
            <main>
              <p {...stylex.props(styles.crumbs)}>
                <a href={prefix} {...stylex.props(styles.crumb)}>
                  <Icon name="arrowLeft" size={14} />
                  {w.title}
                </a>
              </p>
              <div id={`${name}-record-live`} $init={record.call({ id: String(id.value) })}>
                <RecordView row={row} lookups={lookups} capabilities={caps} />
              </div>
              {extra.map((section, i) => <Fragment key={i}>{section}</Fragment>)}
              {caps.update && <list.Editor lookups={lookups} />}
              <Components.Toast />
            </main>
          )
        }))
      })
    )

  return { record, route }
}
