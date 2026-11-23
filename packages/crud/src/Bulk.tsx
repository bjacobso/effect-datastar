/**
 * Bulk actions on a table's selected rows: the selection checkboxes, the bar
 * ("N selected", Delete, "Set role…"), and the toasts that report the outcome.
 *
 * The selection is a plain signal, `${ns}.selection`: an array of row ids (the
 * id field's encoded form, e.g. numbers). It is sent only by the bulk actions
 * (`include: [selection]`); the live view's requests include just the query.
 * That keeps it client state in practice while the server still decodes it with
 * a schema like any other input, and can patch it (clear it after an action).
 *
 * `${ns}._page` (local, never sent) holds the ids on the current page. The live
 * view patches it with every page it renders; "select all" selects it, and an
 * effect drops selected ids that are no longer on the page (deleted, filtered
 * out, paged away).
 */
import * as stylex from "@stylexjs/stylex"
import * as ds from "@effect-datastar/datastar/Attrs.ts"
import type { SignalPath } from "@effect-datastar/datastar/Attrs.ts"
import { Button } from "@effect-datastar/ui/Button.tsx"
import { styles as form } from "@effect-datastar/ui/form.tsx"
import { shared } from "@effect-datastar/ui/shared.ts"
import { color, font, radius, space } from "@effect-datastar/ui/theme/tokens.stylex.ts"
import type { Option } from "./Lookup.ts"
import { NULL } from "./Query.ts"

const ref = (path: SignalPath) => `$${path}`
const js = (value: unknown) => JSON.stringify(value)

/** The signal paths of one table's bulk state. */
export interface Paths {
  /** Selected ids (sent with bulk actions). */
  readonly selection: SignalPath
  /** Ids on the current page (local). */
  readonly page: SignalPath
  /** The bulk update to apply: `{ field, value }` (sent with the update). */
  readonly field: SignalPath
  readonly value: SignalPath
}

/** Drops selected ids that are no longer on the page. For `data-effect` on the table's section. */
export const prune = (p: Paths): ds.Expr => {
  const sel = ref(p.selection)
  const page = ref(p.page)
  return `${sel}.some((id) => !${page}.includes(id)) && (${sel} = ${sel}.filter((id) => ${page}.includes(id)))`
}

/** The header checkbox: selects every row on this page, or none. */
export const SelectAll = (props: { readonly paths: Paths }) => {
  const sel = ref(props.paths.selection)
  const page = ref(props.paths.page)
  return (
    <input
      type="checkbox"
      aria-label="Select all on this page"
      {...ds.effect(
        `el.checked = ${page}.length > 0 && ${page}.every((id) => ${sel}.includes(id)); ` +
          `el.indeterminate = !el.checked && ${sel}.length > 0`
      )}
      {...ds.on("change", `${sel} = el.checked ? [...${page}] : []`)}
      {...stylex.props(form.checkbox, shared.focusRing)}
    />
  )
}

/** A row's checkbox. `id` is the row's id as it appears in the selection signal. */
export const SelectRow = (props: { readonly paths: Paths; readonly id: unknown; readonly label: string }) => {
  const sel = ref(props.paths.selection)
  const id = js(props.id)
  return (
    <input
      type="checkbox"
      aria-label={`Select ${props.label}`}
      {...ds.effect(`el.checked = ${sel}.includes(${id})`)}
      {...ds.on("change", `${sel} = el.checked ? [...${sel}.filter((x) => x !== ${id}), ${id}] : ${sel}.filter((x) => x !== ${id})`)}
      {...stylex.props(form.checkbox, shared.focusRing)}
    />
  )
}

/** A "Set <field>…" control of the bulk bar. */
export interface Setter {
  readonly key: string
  readonly label: string
  readonly options: ReadonlyArray<Option>
  /** Offers "No <label>" (sent as `null`). */
  readonly nullable: boolean
}

/**
 * Shown while anything is selected: the count, a "Set <field>…" select per
 * setter (choosing a value applies it), Delete and Clear.
 */
export const Bar = (props: {
  readonly id: string
  readonly paths: Paths
  /** The plural noun for the confirm ("users"). */
  readonly plural: string
  readonly setters: ReadonlyArray<Setter>
  /** The bulk update action (sends the selection and `field`/`value`). */
  readonly update: ds.Expr
  /** The bulk delete action (sends the selection). */
  readonly remove: ds.Expr
}) => {
  const sel = ref(props.paths.selection)
  return (
    <div
      id={props.id}
      role="toolbar"
      aria-label="Bulk actions"
      // Hidden until something is selected (and before Datastar runs). A morph resets the
      // style attribute; `data-show` watches it and applies itself again.
      style={{ display: "none" }}
      {...ds.show(`${sel}.length > 0`)}
      {...stylex.props(styles.bar)}
    >
      <span {...ds.text(`${sel}.length + ' selected'`)} {...stylex.props(styles.count)} />
      {props.setters.map((s) => (
        <select
          key={s.key}
          aria-label={`Set ${s.label.toLowerCase()}`}
          {...ds.on("change", `el.value !== '' && (${ref(props.paths.field)} = ${js(s.key)}, ${ref(props.paths.value)} = el.value, ${props.update}); el.value = ''`)}
          {...stylex.props(shared.control, styles.select)}
        >
          <option value="">{`Set ${s.label.toLowerCase()}…`}</option>
          {s.nullable && <option value={NULL}>{`No ${s.label.toLowerCase()}`}</option>}
          {s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ))}
      <span {...stylex.props(styles.spacer)} />
      <Button variant="ghost" size="sm" {...ds.on("click", `${sel} = []`)}>Clear</Button>
      <Button
        variant="danger"
        size="sm"
        icon="trash"
        {...ds.on("click", `confirm('Delete ' + ${sel}.length + ' selected ${props.plural.replace(/'/g, "\\'")}?') && ${props.remove}`)}
      >
        Delete
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export interface Outcome {
  readonly done: number
  readonly missing: number
  readonly restricted: number
}

const gone = (n: number) => `${n} no longer ${n === 1 ? "exists" : "exist"}`

/**
 * "3 deleted", or with what didn't: "2 deleted, 1 has members" (`restricted`
 * phrases the rows the database kept), "2 deleted, 1 no longer exists".
 */
export const summary = (verb: "deleted" | "updated", outcome: Outcome, restricted: (n: number) => string) => {
  const parts = [`${outcome.done} ${verb}`]
  if (outcome.restricted > 0) parts.push(restricted(outcome.restricted))
  if (outcome.missing > 0) parts.push(gone(outcome.missing))
  return { message: parts.join(", "), kind: outcome.done === 0 ? "error" as const : "ok" as const }
}

const styles = stylex.create({
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["--dw-space-2"],
    paddingBlock: space["--dw-space-2"],
    paddingInline: space["--dw-space-4"],
    backgroundColor: color["--dw-accent-soft"],
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color["--dw-border"],
    borderTopLeftRadius: radius["--dw-radius-lg"],
    borderTopRightRadius: radius["--dw-radius-lg"]
  },
  count: { fontWeight: font["--dw-weight-medium"], fontSize: font["--dw-text-sm"], marginInlineEnd: space["--dw-space-2"] },
  select: { width: "auto", minHeight: "30px", paddingBlock: "4px" },
  spacer: { flexGrow: 1 }
})
