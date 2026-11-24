/**
 * Custom React 19 JSX runtime with typed `$`-prefixed Datastar props.
 *
 * Enable per-file with `/** @jsxImportSource @effect-datastar/ui *\/` or in `tsconfig.json`.
 * Compiles `$signals`, `$bind`, `$show`, `$text`, `$effect`, `$init`, `$indicator`,
 * `$ignoreMorph`, `$on`, `$onSignalPatch`, `$attr`, and `$class` on intrinsic HTML/SVG
 * elements into Datastar `data-*` attributes matching `@effect-datastar/datastar/Attrs.ts`.
 */
import type * as React from "react"
import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime"
import * as Attrs from "@effect-datastar/datastar/Attrs.ts"

export { Fragment }

// ---------------------------------------------------------------------------
// Structural DSL interfaces (shared with @effect-datastar/datastar Expr DSL)
// ---------------------------------------------------------------------------

export interface ExprLike<A = unknown> {
  readonly toExpr: () => string
  readonly _type?: A | undefined
}

export interface SignalLike<A = unknown> extends ExprLike<A> {
  readonly path: Attrs.SignalPath
}

export interface ActionLike {
  readonly toExpr: () => string
}

export type EventHandlerSpec =
  | ActionLike
  | string
  | ({ readonly run: ActionLike | string } & Attrs.Modifiers)

export interface OnSignalPatchSpec extends Attrs.Modifiers {
  readonly include: ReadonlyArray<SignalLike | Attrs.SignalPath>
  readonly run: ActionLike | string
}

export interface DatastarProps {
  readonly $signals?: Attrs.Attrs | Record<string, unknown> | undefined
  readonly $bind?: SignalLike<string | number | boolean> | Attrs.SignalPath | undefined
  readonly $show?: ExprLike<boolean> | string | undefined
  readonly $text?: ExprLike<string | number | boolean> | string | undefined
  readonly $effect?: ActionLike | ExprLike<unknown> | string | undefined
  readonly $init?: ActionLike | ExprLike<unknown> | string | undefined
  readonly $indicator?: SignalLike<boolean> | Attrs.SignalPath | undefined
  readonly $ignoreMorph?: boolean | undefined
  readonly $on?: Readonly<Record<string, EventHandlerSpec | undefined>> | undefined
  readonly $onSignalPatch?: OnSignalPatchSpec | undefined
  readonly $attr?: Readonly<Record<string, ExprLike<unknown> | string | undefined>> | undefined
  readonly $class?: Readonly<Record<string, ExprLike<boolean> | string | undefined>> | undefined
}

// ---------------------------------------------------------------------------
// Extended JSX namespace
// ---------------------------------------------------------------------------

export namespace JSX {
  export type ElementType = React.JSX.ElementType
  export type Element = React.JSX.Element
  export type ElementClass = React.JSX.ElementClass
  export type ElementAttributesProperty = React.JSX.ElementAttributesProperty
  export type ElementChildrenAttribute = React.JSX.ElementChildrenAttribute
  export type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>
  export type IntrinsicAttributes = React.JSX.IntrinsicAttributes
  export type IntrinsicClassAttributes<T> = React.JSX.IntrinsicClassAttributes<T>
  export type IntrinsicElements = {
    [K in keyof React.JSX.IntrinsicElements]: React.JSX.IntrinsicElements[K] & DatastarProps
  }
}

// ---------------------------------------------------------------------------
// Runtime compilation
// ---------------------------------------------------------------------------

const DATASTAR_PROP_KEYS = new Set([
  "$signals",
  "$bind",
  "$show",
  "$text",
  "$effect",
  "$init",
  "$indicator",
  "$ignoreMorph",
  "$on",
  "$onSignalPatch",
  "$attr",
  "$class"
])

const isExprLike = (value: unknown): value is { readonly toExpr: () => string } =>
  typeof value === "object" &&
  value !== null &&
  "toExpr" in value &&
  typeof (value as { readonly toExpr: unknown }).toExpr === "function"

const toExpr = (value: ExprLike<unknown> | ActionLike | string): string =>
  typeof value === "string" ? value : value.toExpr()

const toSignalPath = (value: SignalLike<unknown> | Attrs.SignalPath): Attrs.SignalPath =>
  typeof value === "string" ? value : value.path

const hasDatastarProps = (props: Record<string, unknown>): boolean => {
  for (const key in props) {
    if (key.charCodeAt(0) === 36 && DATASTAR_PROP_KEYS.has(key)) return true
  }
  return false
}

/**
 * Strip `$`-prefixed Datastar props from intrinsic element props and compile them
 * to `data-*` attributes. Returns `props` unchanged (fast path) when none are present.
 */
export const transformProps = (type: React.ElementType, props: unknown): unknown => {
  if (typeof type !== "string" || props === null || typeof props !== "object") {
    return props
  }
  const record = props as Record<string, unknown>
  if (!hasDatastarProps(record)) {
    return props
  }

  const out: Record<string, unknown> = {}
  for (const key in record) {
    const val = record[key]
    if (key.charCodeAt(0) !== 36 || !DATASTAR_PROP_KEYS.has(key)) {
      out[key] = val
      continue
    }
    if (val === undefined) continue

    switch (key) {
      case "$signals": {
        if (val !== null && typeof val === "object") {
          const obj = val as Record<string, unknown>
          if (typeof obj["data-signals"] === "string") {
            out["data-signals"] = obj["data-signals"]
          } else {
            out["data-signals"] = JSON.stringify(obj)
          }
        }
        break
      }
      case "$bind": {
        out["data-bind"] = toSignalPath(val as SignalLike<string | number | boolean> | Attrs.SignalPath)
        break
      }
      case "$show": {
        out["data-show"] = toExpr(val as ExprLike<boolean> | string)
        break
      }
      case "$text": {
        out["data-text"] = toExpr(val as ExprLike<string | number | boolean> | string)
        break
      }
      case "$effect": {
        out["data-effect"] = toExpr(val as ActionLike | ExprLike<unknown> | string)
        break
      }
      case "$init": {
        out["data-init"] = toExpr(val as ActionLike | ExprLike<unknown> | string)
        break
      }
      case "$indicator": {
        out["data-indicator"] = toSignalPath(val as SignalLike<boolean> | Attrs.SignalPath)
        break
      }
      case "$ignoreMorph": {
        if (val === true) {
          out["data-ignore-morph"] = ""
        }
        break
      }
      case "$on": {
        if (val !== null && typeof val === "object") {
          for (const [event, spec] of Object.entries(val as Record<string, EventHandlerSpec | undefined>)) {
            if (spec === undefined) continue
            if (typeof spec === "string" || isExprLike(spec)) {
              Object.assign(out, Attrs.on(event, toExpr(spec)))
            } else {
              Object.assign(out, Attrs.on(event, toExpr(spec.run), spec))
            }
          }
        }
        break
      }
      case "$onSignalPatch": {
        if (val !== null && typeof val === "object") {
          const spec = val as OnSignalPatchSpec
          Object.assign(
            out,
            Attrs.onSignalPatch(toExpr(spec.run), {
              ...spec,
              include: spec.include.map(toSignalPath)
            })
          )
        }
        break
      }
      case "$attr": {
        if (val !== null && typeof val === "object") {
          for (const [name, expr] of Object.entries(val as Record<string, ExprLike<unknown> | string | undefined>)) {
            if (expr !== undefined) {
              out[`data-attr:${name}`] = toExpr(expr)
            }
          }
        }
        break
      }
      case "$class": {
        if (val !== null && typeof val === "object") {
          for (const [name, expr] of Object.entries(val as Record<string, ExprLike<boolean> | string | undefined>)) {
            if (expr !== undefined) {
              out[`data-class:${name}`] = toExpr(expr)
            }
          }
        }
        break
      }
    }
  }

  return out
}

export function jsx(
  type: React.ElementType,
  props: unknown,
  key?: React.Key
): React.ReactElement {
  return reactJsx(type, transformProps(type, props), key)
}

export function jsxs(
  type: React.ElementType,
  props: unknown,
  key?: React.Key
): React.ReactElement {
  return reactJsxs(type, transformProps(type, props), key)
}
