/**
 * Generic, schema-driven CRUD components (pure: props -> React elements, rendered to
 * HTML on the server).
 *
 * They take a base signal path (e.g. `users.query`) and derive every binding from field
 * metadata, so a resource only has to compose them. Styled with StyleX and the `@dw/ui`
 * tokens; no client JS except the islands (the relation select and the dialog).
 */
import * as stylex from "@stylexjs/stylex"
import { DateTime } from "effect"
import type { ReactNode } from "react"
import * as ds from "../datastar/Attrs.ts"
import type { SignalPath } from "../datastar/Attrs.ts"
import * as Island from "../islands/Island.tsx"
import { Dialog, Select } from "../islands/islands.tsx"
import { Button } from "../ui/Button.tsx"
import { Badge } from "../ui/display.tsx"
import { styles as form } from "../ui/form.tsx"
import { Icon } from "../ui/icons.tsx"
import { styles as overlay } from "../ui/overlay.tsx"
import { shared } from "../ui/shared.ts"
import { color, font, motion, radius, shadow, size, space } from "../ui/theme/tokens.stylex.ts"
import type * as Field from "./Field.ts"
import type { Option } from "./Lookup.ts"
import { type FilterInfo, NULL } from "./Query.ts"

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
// Filters (native controls)
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
      {...stylex.props(shared.control, styles.select)}
    >
      <option value="">All</option>
      {f.nullable && <option value={NULL}>None</option>}
      {fieldOptions(f, props.lookup).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

export const FilterBar = (props: {
  readonly prefix: string
  readonly filters: ReadonlyArray<FilterInfo>
  readonly query: SignalPath
  readonly lookups?: Lookups | undefined
}) => (
  <div {...stylex.props(styles.filters)}>
    {props.filters.map((f) => (
      <label key={f.key} {...stylex.props(styles.filter)}>
        <span {...stylex.props(styles.filterLabel)}>{f.label}</span>
        {f.operator === "contains"
          ? (
            <span {...stylex.props(styles.search)}>
              <Icon name="search" size={14} {...stylex.props(styles.searchIcon)} />
              <input
                type="search"
                placeholder={`Search ${f.label.toLowerCase()}…`}
                {...ds.merge(
                  ds.bind(at(props.query, "filters", f.key)),
                  ds.on("input", `${ref(at(props.query, "page"))} = 1`)
                )}
                {...stylex.props(shared.control, styles.searchInput)}
              />
            </span>
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

/** A field's value as shown in tables and on detail pages: badges for enums and booleans. */
export const CellValue = (props: { readonly field: Field.FieldInfo; readonly value: unknown }) => {
  const { field, value } = props
  if (value === null || value === undefined) return <span {...stylex.props(shared.subtle)}>—</span>
  if (typeof value === "boolean") return <Badge tone={value ? "success" : "neutral"}>{value ? "Yes" : "No"}</Badge>
  if (field.kind === "enum") return <Badge tone="accent">{String(value)}</Badge>
  if (DateTime.isDateTime(value)) return <span {...stylex.props(styles.date)}>{formatCell(field, value)}</span>
  return <span>{formatCell(field, value)}</span>
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
    <th
      aria-sort={active ? (props.current.dir === "asc" ? "ascending" : "descending") : "none"}
      {...stylex.props(styles.th)}
    >
      <button
        type="button"
        {...ds.on(
          "click",
          `${sort} === ${key} ? ${dir} = (${dir} === 'asc' ? 'desc' : 'asc') : (${sort} = ${key}, ${dir} = 'asc')`
        )}
        {...stylex.props(styles.sort, shared.focusRing, active && styles.sortActive)}
      >
        {props.field.label}
        <Icon
          name={active ? (props.current.dir === "asc" ? "arrowUp" : "arrowDown") : "arrowUpDown"}
          size={13}
          {...stylex.props(styles.sortIcon, active && styles.sortIconActive)}
        />
      </button>
    </th>
  )
}

export interface Column<A> {
  readonly field: Field.FieldInfo
  readonly sortable: boolean
  readonly render?: ((row: A) => ReactNode) | undefined
}

/** One `<tr>`, with a stable id so a live view can patch just this row. */
export const TableRow = <A extends object>(props: {
  readonly row: A
  readonly columns: ReadonlyArray<Column<A>>
  readonly rowId: (row: A) => string
  readonly actions?: ((row: A) => ReactNode) | undefined
}) => (
  <tr id={props.rowId(props.row)} {...stylex.props(styles.tr)}>
    {props.columns.map((c) => (
      <td key={c.field.key} {...stylex.props(styles.td)}>
        {c.render
          ? c.render(props.row)
          : <CellValue field={c.field} value={(props.row as Record<string, unknown>)[c.field.key]} />}
      </td>
    ))}
    {props.actions && <td {...stylex.props(styles.td, styles.actions)}>{props.actions(props.row)}</td>}
  </tr>
)

export const Table = <A extends object>(props: {
  readonly id: string
  readonly columns: ReadonlyArray<Column<A>>
  readonly rows: ReadonlyArray<A>
  readonly rowId: (row: A) => string
  readonly query: SignalPath
  readonly current: { readonly sort: string; readonly dir: "asc" | "desc" }
  readonly actions?: ((row: A) => ReactNode) | undefined
}) => (
  <div {...stylex.props(styles.scroll)}>
    <table id={props.id} {...stylex.props(styles.table)}>
      <thead>
        <tr>
          {props.columns.map((c) =>
            c.sortable
              ? <SortHeader key={c.field.key} field={c.field} query={props.query} current={props.current} />
              : <th key={c.field.key} {...stylex.props(styles.th)}>{c.field.label}</th>
          )}
          {props.actions && <th {...stylex.props(styles.th)}><span {...stylex.props(shared.visuallyHidden)}>Actions</span></th>}
        </tr>
      </thead>
      <tbody>
        {props.rows.length === 0
          ? (
            <tr>
              <td colSpan={props.columns.length + 1} {...stylex.props(styles.td, styles.empty)}>
                Nothing matches these filters.
              </td>
            </tr>
          )
          : props.rows.map((row) => (
            <TableRow key={props.rowId(row)} row={row} columns={props.columns} rowId={props.rowId} actions={props.actions} />
          ))}
      </tbody>
    </table>
  </div>
)

/** A row's Edit / Delete buttons. */
export const RowActions = (props: { readonly edit: ds.Expr; readonly remove: ds.Expr }) => (
  <span {...stylex.props(styles.rowActions)}>
    <Button variant="ghost" size="sm" icon="edit" {...ds.on("click", props.edit)}>Edit</Button>
    <Button variant="ghost" size="sm" icon="trash" xstyle={styles.dangerText} {...ds.on("click", props.remove)}>
      Delete
    </Button>
  </span>
)

/** The card a live table renders into (table + pagination). */
export const TablePanel = (props: { readonly id: string; readonly busy?: boolean; readonly children: ReactNode }) => (
  <section id={props.id} aria-busy={props.busy || undefined} {...stylex.props(styles.panel)}>
    {props.children}
  </section>
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
  const PageButton = (p: { readonly to: number; readonly disabled: boolean; readonly label: string; readonly icon: "chevronsLeft" | "chevronLeft" | "chevronRight" | "chevronsRight" }) => (
    <button
      type="button"
      aria-label={p.label}
      title={p.label}
      disabled={p.disabled}
      {...go(p.to)}
      {...stylex.props(styles.pageButton, shared.focusRing)}
    >
      <Icon name={p.icon} size={15} />
    </button>
  )
  return (
    <nav aria-label="Pagination" {...stylex.props(styles.pagination)}>
      <span data-total="" {...stylex.props(styles.total)}>{props.total} total</span>
      <span {...stylex.props(styles.pages)}>
        <PageButton to={1} disabled={props.page <= 1} label="First page" icon="chevronsLeft" />
        <PageButton to={props.page - 1} disabled={props.page <= 1} label="Previous page" icon="chevronLeft" />
        <span data-page="" {...stylex.props(styles.pageText)}>Page {props.page} of {props.pages}</span>
        <PageButton to={props.page + 1} disabled={props.page >= props.pages} label="Next page" icon="chevronRight" />
        <PageButton to={props.pages} disabled={props.page >= props.pages} label="Last page" icon="chevronsRight" />
      </span>
      <label {...stylex.props(styles.perPage)}>
        Per page
        <select
          {...ds.merge(ds.bind(at(props.query, "pageSize")), ds.on("change", `${page} = 1`))}
          {...stylex.props(shared.control, styles.select, styles.perPageSelect)}
        >
          {props.pageSizes.map((n) => <option key={n} value={String(n)}>{n}</option>)}
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

/**
 * A select field. Relations (options from a lookup) are a ui-sdk Select island bound to
 * the draft; enums are a native select. Both keep the same id, so a live view can
 * replace either when its options change.
 */
export const FieldSelect = (props: FieldProps) => {
  const id = fieldId(props.prefix, props.field.key)
  if (props.lookup !== undefined) {
    return (
      <Island.Mount
        island={Select}
        id={id}
        props={{
          options: props.lookup.map((o) => ({ value: o.value, label: o.label })),
          label: props.field.label,
          emptyLabel: props.field.nullable ? `No ${props.field.label.toLowerCase()}` : undefined
        }}
        attrs={ds.merge(ds.bind(at(props.draft, props.field.key)), invalidAttr(props))}
      />
    )
  }
  return (
    <select
      id={id}
      {...ds.merge(ds.bind(at(props.draft, props.field.key)), invalidAttr(props))}
      {...stylex.props(shared.control, styles.select)}
    >
      {props.field.nullable && <option value="">—</option>}
      {fieldOptions(props.field, props.lookup).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

/** Shows the field's server-side error (from the `errors` signals). */
const FieldError = (props: { readonly error: SignalPath }) => (
  <small aria-live="polite" {...ds.text(ref(props.error))} {...stylex.props(form.error, styles.fieldError)} />
)

export const FormField = (props: FieldProps) => {
  const f = props.field
  const bind = ds.bind(at(props.draft, f.key))
  const error = at(props.errors, f.key)
  if (f.widget === "checkbox") {
    return (
      <div {...stylex.props(form.field)}>
        <label {...stylex.props(form.check)}>
          <input type="checkbox" {...bind} {...stylex.props(form.checkbox, shared.focusRing)} />
          <span {...stylex.props(form.label)}>{f.label}</span>
        </label>
        <FieldError error={error} />
      </div>
    )
  }
  const input = (() => {
    switch (f.widget) {
      case "select":
        return <FieldSelect {...props} />
      case "textarea":
        return <textarea {...ds.merge(bind, invalidAttr(props))} {...stylex.props(shared.control, form.textarea)} />
      case "readonly":
        return <input disabled {...bind} {...stylex.props(shared.control)} />
      default:
        return <input type={f.widget} {...ds.merge(bind, invalidAttr(props))} {...stylex.props(shared.control)} />
    }
  })()
  // A relation select is an island (no labelable element), so it is named by `aria-label`.
  const Wrapper = f.widget === "select" && props.lookup !== undefined ? "div" : "label"
  return (
    <Wrapper {...stylex.props(form.field)}>
      <span {...stylex.props(form.label)}>{f.label}</span>
      {input}
      <FieldError error={error} />
    </Wrapper>
  )
}

// ---------------------------------------------------------------------------
// Dialog + toast
// ---------------------------------------------------------------------------

/**
 * Create/edit dialog for a draft: a ui-sdk Dialog island, open while the `open` signal is
 * true. The form inside is server-rendered with its Datastar bindings. `submit` is the
 * Datastar expression to run (typically `$draft.id ? update : create`).
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
  const titleId = `${props.prefix}-dialog-title`
  return (
    <Island.Mount
      island={Dialog}
      id={`${props.prefix}-dialog`}
      props={{ labelledBy: titleId }}
      attrs={ds.merge(ds.attr("open", open), ds.on("close", `${open} = false`))}
      display="contents"
      content={
        <form noValidate {...ds.on("submit", props.submit, { prevent: true })} {...stylex.props(styles.form)}>
          <h2
            id={titleId}
            {...ds.text(`${ref(at(props.draft, "id"))} ? ${str(`Edit ${props.noun}`)} : ${str(`New ${props.noun}`)}`)}
            {...stylex.props(overlay.dialogTitle)}
          />
          {props.fields.map((field) => (
            <FormField
              key={field.key}
              prefix={props.prefix}
              field={field}
              draft={props.draft}
              errors={props.errors}
              lookup={props.lookups?.[field.key]}
            />
          ))}
          <footer {...stylex.props(styles.dialogActions)}>
            <Button variant="ghost" {...ds.on("click", `${open} = false`)}>Cancel</Button>
            <Button type="submit" variant="primary">Save</Button>
          </footer>
        </form>
      }
    />
  )
}

export const Toast = (props: { readonly message?: string | undefined; readonly kind?: "ok" | "error" | undefined }) =>
  props.message === undefined
    ? <div id="toast" />
    : (
      <div id="toast" role="status" {...stylex.props(styles.toast, props.kind === "error" && styles.toastError)}>
        <Icon name={props.kind === "error" ? "alert" : "check"} size={16} />
        {props.message}
      </div>
    )

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const fade = stylex.keyframes({
  "0%": { opacity: 0, transform: "translateY(8px)" },
  "8%": { opacity: 1, transform: "none" },
  "80%": { opacity: 1, transform: "none" },
  "100%": { opacity: 0, visibility: "hidden" }
})

const chevron =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2380808b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")"

const styles = stylex.create({
  filters: { display: "flex", flexWrap: "wrap", gap: space["--dw-space-3"], marginBottom: space["--dw-space-4"] },
  filter: { display: "flex", flexDirection: "column", gap: "6px", minWidth: "170px", flexGrow: 1, flexBasis: "170px" },
  filterLabel: { fontSize: font["--dw-text-xs"], fontWeight: font["--dw-weight-medium"], color: color["--dw-text-muted"] },
  search: { position: "relative", display: "block" },
  searchIcon: {
    position: "absolute",
    insetInlineStart: "11px",
    top: "50%",
    transform: "translateY(-50%)",
    color: color["--dw-text-subtle"],
    pointerEvents: "none"
  },
  searchInput: { paddingInlineStart: "32px" },
  select: {
    appearance: "none",
    paddingInlineEnd: "32px",
    backgroundImage: chevron,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 10px center",
    backgroundSize: "16px",
    cursor: "pointer"
  },
  panel: {
    backgroundColor: color["--dw-surface"],
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color["--dw-border"],
    borderRadius: radius["--dw-radius-lg"],
    boxShadow: shadow["--dw-shadow-md"],
    overflow: "hidden"
  },
  scroll: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: font["--dw-text-md"] },
  th: {
    textAlign: "start",
    paddingBlock: "10px",
    paddingInline: space["--dw-space-4"],
    backgroundColor: color["--dw-surface-muted"],
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color["--dw-border"],
    fontSize: font["--dw-text-xs"],
    fontWeight: font["--dw-weight-medium"],
    color: color["--dw-text-muted"],
    whiteSpace: "nowrap"
  },
  sort: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["--dw-space-1"],
    padding: 0,
    borderWidth: 0,
    borderRadius: radius["--dw-radius-sm"],
    backgroundColor: "transparent",
    color: { default: "inherit", ":hover": color["--dw-text"] },
    font: "inherit",
    cursor: "pointer"
  },
  sortActive: { color: color["--dw-text"] },
  sortIcon: { color: color["--dw-text-subtle"] },
  sortIconActive: { color: color["--dw-accent"] },
  tr: {
    backgroundColor: { default: "transparent", ":hover": color["--dw-surface-muted"] },
    transitionProperty: "background-color",
    transitionDuration: motion["--dw-duration-fast"]
  },
  td: {
    paddingBlock: "10px",
    paddingInline: space["--dw-space-4"],
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color["--dw-border"],
    verticalAlign: "middle"
  },
  actions: { textAlign: "end", whiteSpace: "nowrap", paddingBlock: "6px" },
  rowActions: { display: "inline-flex", gap: space["--dw-space-1"] },
  dangerText: { color: { default: color["--dw-danger"], ":hover": color["--dw-danger"] } },
  empty: { textAlign: "center", color: color["--dw-text-muted"], paddingBlock: space["--dw-space-10"] },
  date: { fontVariantNumeric: "tabular-nums", color: color["--dw-text-muted"] },
  pagination: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["--dw-space-3"],
    paddingBlock: space["--dw-space-3"],
    paddingInline: space["--dw-space-4"],
    color: color["--dw-text-muted"],
    fontSize: font["--dw-text-sm"]
  },
  total: { fontVariantNumeric: "tabular-nums" },
  pages: { display: "flex", alignItems: "center", gap: space["--dw-space-1"] },
  pageText: { paddingInline: space["--dw-space-2"], fontVariantNumeric: "tabular-nums", color: color["--dw-text"] },
  pageButton: {
    display: "grid",
    placeItems: "center",
    width: size["--dw-control-sm"],
    height: size["--dw-control-sm"],
    padding: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color["--dw-border-strong"],
    borderRadius: radius["--dw-radius-md"],
    backgroundColor: { default: color["--dw-surface"], ":hover": color["--dw-surface-muted"], ":disabled": "transparent" },
    color: color["--dw-text"],
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.45 }
  },
  perPage: { display: "flex", alignItems: "center", gap: space["--dw-space-2"] },
  perPageSelect: { width: "auto", minHeight: size["--dw-control-sm"], paddingBlock: "4px" },
  form: { display: "flex", flexDirection: "column", gap: space["--dw-space-4"] },
  // Takes no room until the server sends an error.
  fieldError: { display: { default: "flex", ":empty": "none" } },
  dialogActions: {
    display: "flex",
    justifyContent: "flex-end",
    flexDirection: { default: "row", "@media (max-width: 640px)": "column-reverse" },
    gap: space["--dw-space-2"],
    paddingTop: space["--dw-space-2"]
  },
  toast: {
    position: "fixed",
    insetInlineEnd: space["--dw-space-4"],
    bottom: space["--dw-space-4"],
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    gap: space["--dw-space-2"],
    maxWidth: "min(420px, calc(100vw - 32px))",
    paddingBlock: "10px",
    paddingInline: space["--dw-space-4"],
    borderRadius: radius["--dw-radius-md"],
    backgroundColor: color["--dw-success"],
    color: color["--dw-on-accent"],
    boxShadow: shadow["--dw-shadow-lg"],
    fontWeight: font["--dw-weight-medium"],
    animationName: fade,
    animationDuration: "3s",
    animationFillMode: "forwards"
  },
  toastError: { backgroundColor: color["--dw-danger"], color: color["--dw-on-danger"] }
})
