/**
 * Generic, schema-driven CRUD components (pure: props -> HTML).
 *
 * They take a base signal path (e.g. `users.query`) and derive every binding
 * from field metadata, so a resource only has to compose them.
 */
import { DateTime } from "effect"
import * as ds from "../datastar/Attrs.ts"
import type { SignalPath } from "../datastar/Attrs.ts"
import type * as Field from "./Field.ts"
import type { Option } from "./Lookup.ts"
import { NULL, type FilterInfo } from "./Query.ts"

const at = (base: SignalPath, ...rest: Array<string>) => [base, ...rest].join(".") as SignalPath
const ref = (path: SignalPath) => `$${path}`
const str = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

/**
 * Options for a field: from a lookup (relations) when given, otherwise derived
 * from the schema (enum members / yes-no).
 */
const fieldOptions = (field: Field.FieldInfo, lookup?: ReadonlyArray<Option>): ReadonlyArray<Option> =>
  lookup ?? (field.kind === "boolean"
    ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }]
    : field.options.map((o) => ({ value: o, label: o })))

/** Lookup options per field key, for relation fields. */
export type Lookups = Readonly<Record<string, ReadonlyArray<Option>>>

/** Stable DOM ids, so live views can re-render selects whose options come from lookups. */
export const filterId = (prefix: string, key: string) => `${prefix}-filter-${key}`
export const fieldId = (prefix: string, key: string) => `${prefix}-field-${key}`

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const FilterSelect = (props: {
  readonly prefix: string
  readonly filter: FilterInfo
  readonly query: SignalPath
  readonly lookup?: ReadonlyArray<Option> | undefined
}) => {
  const f = props.filter
  return (
    <select
      id={filterId(props.prefix, f.key)}
      {...ds.merge(ds.bind(at(props.query, "filters", f.key)), ds.on("change", `${ref(at(props.query, "page"))} = 1`))}
    >
      <option value="">All</option>
      {f.nullable ? <option value={NULL}>None</option> : ""}
      {fieldOptions(f, props.lookup).map((o) => <option value={o.value} safe>{o.label}</option>)}
    </select>
  )
}

export const FilterBar = (props: {
  readonly prefix: string
  readonly filters: ReadonlyArray<FilterInfo>
  readonly query: SignalPath
  readonly lookups?: Lookups | undefined
}) => (
  <div class="filters">
    {props.filters.map((f) => (
      <label>
        <span safe>{f.label}</span>
        {f.operator === "contains"
          ? (
            <input
              type="search"
              placeholder={`Search ${f.label.toLowerCase()}…`}
              {...ds.merge(
                ds.bind(at(props.query, "filters", f.key)),
                ds.on("input", `${ref(at(props.query, "page"))} = 1`)
              )}
            />
          )
          : <FilterSelect prefix={props.prefix} filter={f} query={props.query} lookup={props.lookups?.[f.key]} />}
      </label>
    ))}
  </div>
)

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export const formatCell = (field: Field.FieldInfo, value: unknown): string => {
  if (value === null || value === undefined) return "—"
  if (typeof value === "boolean") return value ? "✓" : "✗"
  if (DateTime.isDateTime(value)) return DateTime.formatIso(value).slice(0, 16).replace("T", " ")
  return String(value)
}

export const SortHeader = (props: {
  readonly field: Field.FieldInfo
  readonly query: SignalPath
  readonly current: { readonly sort: string; readonly dir: "asc" | "desc" }
}) => {
  const sort = ref(at(props.query, "sort"))
  const dir = ref(at(props.query, "dir"))
  const key = str(props.field.key)
  const active = props.current.sort === props.field.key
  return (
    <th>
      <button
        class={["sort", active && "active"]}
        {...ds.on(
          "click",
          `${sort} === ${key} ? ${dir} = (${dir} === 'asc' ? 'desc' : 'asc') : (${sort} = ${key}, ${dir} = 'asc')`
        )}
      >
        <span safe>{props.field.label}</span>
        <span class="arrow">{active ? (props.current.dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  )
}

export interface Column<A> {
  readonly field: Field.FieldInfo
  readonly sortable: boolean
  readonly render?: ((row: A) => JSX.Element) | undefined
}

export const Table = <A extends object>(props: {
  readonly id: string
  readonly columns: ReadonlyArray<Column<A>>
  readonly rows: ReadonlyArray<A>
  readonly rowId: (row: A) => string
  readonly query: SignalPath
  readonly current: { readonly sort: string; readonly dir: "asc" | "desc" }
  readonly actions?: ((row: A) => JSX.Element) | undefined
}) => (
  <table id={props.id}>
    <thead>
      <tr>
        {props.columns.map((c) =>
          c.sortable
            ? <SortHeader field={c.field} query={props.query} current={props.current} />
            : <th safe>{c.field.label}</th>
        )}
        {props.actions ? <th /> : ""}
      </tr>
    </thead>
    <tbody>
      {props.rows.length === 0
        ? (
          <tr>
            <td class="empty" colspan={String(props.columns.length + 1)}>Nothing matches these filters.</td>
          </tr>
        )
        : props.rows.map((row) => (
          <tr id={props.rowId(row)}>
            {props.columns.map((c) => (
              <td>{c.render ? c.render(row) : <span safe>{formatCell(c.field, (row as Record<string, unknown>)[c.field.key])}</span>}</td>
            ))}
            {props.actions ? <td class="actions">{props.actions(row)}</td> : ""}
          </tr>
        ))}
    </tbody>
  </table>
)

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const Pagination = (props: {
  readonly query: SignalPath
  readonly page: number
  readonly pages: number
  readonly total: number
  readonly pageSizes: ReadonlyArray<number>
}) => {
  const page = ref(at(props.query, "page"))
  const go = (n: number) => ds.on("click", `${page} = ${n}`)
  return (
    <nav class="pagination">
      <span>{props.total} total</span>
      <span class="pages">
        <button disabled={props.page <= 1} {...go(1)}>«</button>
        <button disabled={props.page <= 1} {...go(props.page - 1)}>‹</button>
        <span>Page {props.page} of {props.pages}</span>
        <button disabled={props.page >= props.pages} {...go(props.page + 1)}>›</button>
        <button disabled={props.page >= props.pages} {...go(props.pages)}>»</button>
      </span>
      <label>
        Per page
        <select {...ds.merge(ds.bind(at(props.query, "pageSize")), ds.on("change", `${page} = 1`))}>
          {props.pageSizes.map((n) => <option value={String(n)}>{n}</option>)}
        </select>
      </label>
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface FieldProps {
  readonly prefix: string
  readonly field: Field.FieldInfo
  readonly draft: SignalPath
  readonly errors: SignalPath
  readonly lookup?: ReadonlyArray<Option> | undefined
}

const invalidAttr = (props: FieldProps) =>
  ds.attr("aria-invalid", `${ref(at(props.errors, props.field.key))} ? 'true' : 'false'`)

export const FieldSelect = (props: FieldProps) => (
  <select
    id={fieldId(props.prefix, props.field.key)}
    {...ds.merge(ds.bind(at(props.draft, props.field.key)), invalidAttr(props))}
  >
    {props.field.nullable ? <option value="">—</option> : ""}
    {fieldOptions(props.field, props.lookup).map((o) => <option value={o.value} safe>{o.label}</option>)}
  </select>
)

export const FormField = (props: FieldProps) => {
  const f = props.field
  const bind = ds.bind(at(props.draft, f.key))
  const error = ref(at(props.errors, f.key))
  const input = (() => {
    switch (f.widget) {
      case "checkbox":
        return <input type="checkbox" {...bind} />
      case "select":
        return <FieldSelect {...props} />
      case "textarea":
        return <textarea {...ds.merge(bind, invalidAttr(props))} />
      case "readonly":
        return <input disabled {...bind} />
      default:
        return <input type={f.widget} {...ds.merge(bind, invalidAttr(props))} />
    }
  })()
  return (
    <label class={["field", f.widget === "checkbox" && "inline"]}>
      <span safe>{f.label}</span>
      {input}
      <small class="error" {...ds.text(error)} />
    </label>
  )
}

// ---------------------------------------------------------------------------
// Dialog + toast
// ---------------------------------------------------------------------------

/**
 * Create/edit dialog for a draft. `submit` is the Datastar expression to run
 * (typically `$draft.id ? update : create`).
 */
export const FormDialog = (props: {
  readonly prefix: string
  readonly noun: string
  readonly fields: ReadonlyArray<Field.FieldInfo>
  readonly draft: SignalPath
  readonly errors: SignalPath
  readonly open: SignalPath
  readonly submit: ds.Expr
  readonly lookups?: Lookups | undefined
}) => {
  const open = ref(props.open)
  return (
    <dialog
      id={`${props.prefix}-dialog`}
      {...ds.merge(ds.attr("open", open), ds.on("keydown", `evt.key === 'Escape' && (${open} = false)`))}
    >
      <form novalidate {...ds.on("submit", props.submit, { prevent: true })}>
        <h2 {...ds.text(`${ref(at(props.draft, "id"))} ? ${str(`Edit ${props.noun}`)} : ${str(`New ${props.noun}`)}`)} />
        {props.fields.map((field) => (
          <FormField
            prefix={props.prefix}
            field={field}
            draft={props.draft}
            errors={props.errors}
            lookup={props.lookups?.[field.key]}
          />
        ))}
        <footer>
          <button type="button" class="secondary" {...ds.on("click", `${open} = false`)}>Cancel</button>
          <button type="submit">Save</button>
        </footer>
      </form>
    </dialog>
  )
}

export const Toast = (props: { readonly message?: string; readonly kind?: "ok" | "error" }) =>
  props.message === undefined
    ? <div id="toast" />
    : <div id="toast" class={["toast", props.kind ?? "ok"]} safe>{props.message}</div>
