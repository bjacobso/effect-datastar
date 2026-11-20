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
import type { FilterInfo } from "./Query.ts"

const at = (base: SignalPath, ...rest: Array<string>) => [base, ...rest].join(".") as SignalPath
const ref = (path: SignalPath) => `$${path}`
const str = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const FilterBar = (props: { readonly filters: ReadonlyArray<FilterInfo>; readonly query: SignalPath }) => {
  const resetPage = `${ref(at(props.query, "page"))} = 1`
  return (
    <div class="filters">
      {props.filters.map((f) => {
        const bound = ds.merge(ds.bind(at(props.query, "filters", f.key)), ds.on("input", resetPage))
        if (f.operator === "contains") {
          return (
            <label>
              <span safe>{f.label}</span>
              <input type="search" placeholder={`Search ${f.label.toLowerCase()}…`} {...bound} />
            </label>
          )
        }
        const options = f.kind === "boolean"
          ? [["true", "Yes"], ["false", "No"]] as const
          : f.options.map((o) => [o, o] as const)
        return (
          <label>
            <span safe>{f.label}</span>
            <select {...bound}>
              <option value="">All</option>
              {options.map(([value, label]) => <option value={value} safe>{label}</option>)}
            </select>
          </label>
        )
      })}
    </div>
  )
}

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

export const FormField = (props: { readonly field: Field.FieldInfo; readonly draft: SignalPath; readonly errors: SignalPath }) => {
  const f = props.field
  const bind = ds.bind(at(props.draft, f.key))
  const error = ref(at(props.errors, f.key))
  const invalid = ds.attr("aria-invalid", `${error} ? 'true' : 'false'`)
  const input = (() => {
    switch (f.widget) {
      case "checkbox":
        return <input type="checkbox" {...bind} />
      case "select":
        return (
          <select {...ds.merge(bind, invalid)}>
            {f.nullable ? <option value="">—</option> : ""}
            {f.options.map((o) => <option value={o} safe>{o}</option>)}
          </select>
        )
      case "textarea":
        return <textarea {...ds.merge(bind, invalid)} />
      case "readonly":
        return <input disabled {...bind} />
      default:
        return <input type={f.widget} {...ds.merge(bind, invalid)} />
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
