/**
 * Rendering shared by a resource's pages: how a field's value is shown (custom
 * cells, relation labels and chips, the linked display column), the page
 * response, and the styles of the list and detail pages.
 *
 * Internal to the resource modules.
 */
import * as stylex from "@stylexjs/stylex"
import { document } from "@effect-datastar/ui/Html.ts"
import { color, font, space } from "@effect-datastar/ui/theme/tokens.stylex.ts"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import type { ReactNode } from "react"
import * as Components from "../components.tsx"
import type * as Field from "../Field.ts"
import type { Wired } from "./context.ts"
import type { Fields, IdKey, ModelLike } from "./types.ts"

/**
 * How a field's value is shown: a custom cell, a linked relation label, chips, or the
 * linked display column. `undefined`: the plain value (`Components.CellValue`).
 */
export const cell = <Name extends string, M extends ModelLike, Id extends IdKey<M>, Sortable extends Fields<M>, FK extends string, T, L>(
  w: Wired<Name, M, Id, Sortable, FK, T, L>,
  field: Field.FieldInfo,
  lookups: Components.Lookups,
  options: { readonly link: boolean }
): ((row: M["Type"]) => ReactNode) | undefined => {
  type Row = M["Type"]
  const custom = w.columns[field.key]
  if (custom) return (row: Row) => custom(row, lookups)
  const related = w.relations.some(([k]) => k === field.key)
  if (field.kind === "ids" && related) {
    const options = lookups[field.key] ?? []
    return (row: Row) => <Components.Chips values={(w.get(row, field.key) ?? []) as ReadonlyArray<unknown>} options={options} />
  }
  if (related) {
    const byValue = new Map((lookups[field.key] ?? []).map((o) => [o.value, o]))
    return (row: Row) => {
      const v = w.get(row, field.key)
      if (v === null || v === undefined) return <span {...stylex.props(styles.subtle)}>—</span>
      const option = byValue.get(String(v))
      if (!option) return <span>?</span>
      return option.href ? <a href={option.href} {...stylex.props(styles.link)}>{option.label}</a> : <span>{option.label}</span>
    }
  }
  if (options.link && field.key === w.display) {
    return (row: Row) => <a href={w.href(row[w.idColumn])} {...stylex.props(styles.link, styles.strong)}>{w.label(row)}</a>
  }
  return undefined
}

/** A page, in the layout (which may be an Effect, e.g. one that reads the signed-in account). */
export const html = <R,>(page: ReactNode | Effect.Effect<ReactNode, never, R>, status = 200) =>
  Effect.map(
    Effect.isEffect(page) ? page : Effect.succeed(page),
    (element) => HttpServerResponse.html(document(element)).pipe(HttpServerResponse.setStatus(status))
  )

export const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", marginBottom: space["--dw-space-10"] },
  bar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space["--dw-space-4"],
    marginBottom: space["--dw-space-5"]
  },
  flush: { marginBottom: 0 },
  actions: { display: "flex", gap: space["--dw-space-2"] },
  h1: {
    fontSize: font["--dw-text-xl"],
    fontWeight: font["--dw-weight-semibold"],
    letterSpacing: "-0.02em",
    lineHeight: font["--dw-leading-tight"]
  },
  h2: {
    fontSize: font["--dw-text-lg"],
    fontWeight: font["--dw-weight-semibold"],
    letterSpacing: "-0.01em",
    lineHeight: font["--dw-leading-tight"]
  },
  loading: { padding: space["--dw-space-5"] },
  link: {
    color: color["--dw-accent-text"],
    textDecoration: { default: "none", ":hover": "underline" }
  },
  strong: { fontWeight: font["--dw-weight-medium"] },
  subtle: { color: color["--dw-text-subtle"] },
  crumbs: { marginBottom: space["--dw-space-4"] },
  crumb: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["--dw-space-1"],
    color: { default: color["--dw-text-muted"], ":hover": color["--dw-text"] },
    fontSize: font["--dw-text-sm"],
    fontWeight: font["--dw-weight-medium"],
    textDecoration: "none"
  },
  record: { display: "flex", flexDirection: "column", gap: space["--dw-space-5"], marginBottom: space["--dw-space-10"] },
  dl: { display: "flex", flexDirection: "column", gap: space["--dw-space-3"] },
  dlRow: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(120px, 1fr) 3fr", "@media (max-width: 640px)": "minmax(0, 1fr)" },
    gap: { default: space["--dw-space-3"], "@media (max-width: 640px)": "2px" },
    alignItems: "baseline"
  },
  dt: { color: color["--dw-text-muted"], fontSize: font["--dw-text-sm"] },
  dd: { minWidth: 0, overflowWrap: "anywhere" }
})
