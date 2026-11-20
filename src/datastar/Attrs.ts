/**
 * Typed Datastar attribute helpers.
 *
 * Datastar v1 attribute names contain `:` and `.` (e.g. `data-on:input__debounce.250ms`),
 * which JSX can't express directly, so helpers return attribute objects to spread:
 *
 *   <input {...ds.bind(sig.path("users.form.name"))} {...ds.on("input", "...", { debounce: "250ms" })} />
 *
 * `Signals.make(schema)` gives signal paths/refs checked against the signals schema,
 * so `sig.$("users.query.pag")` is a compile error.
 */
import { Schema } from "effect"

export type Attrs = Record<string, string>

/** A JavaScript expression evaluated by Datastar. */
export type Expr = string

// ---------------------------------------------------------------------------
// Signal paths
// ---------------------------------------------------------------------------

type Primitive = string | number | boolean | null | undefined
type IsPlainObject<T> = T extends Primitive | ReadonlyArray<any> | Date | Function ? false : T extends object ? true
  : false

/** All dotted paths into a (JSON-ish) object type. */
export type Paths<T> = IsPlainObject<T> extends true ? {
    [K in keyof T & string]: K | (IsPlainObject<T[K]> extends true ? `${K}.${Paths<T[K]>}` : never)
  }[keyof T & string]
  : never

declare const PathBrand: unique symbol
/** A signal path that has been checked against a signals schema. */
export type SignalPath = string & { readonly [PathBrand]: true }

export interface Signals<S extends Schema.Top> {
  readonly schema: S
  /** Checked dotted path, e.g. for `data-bind`. */
  readonly path: (p: Paths<S["Type"]>) => SignalPath
  /** Signal reference for expressions: `$users.query.page`. */
  readonly $: (p: Paths<S["Type"]>) => Expr
  /** `data-signals` attribute with the encoded initial value. */
  readonly init: (value: S["Type"]) => Attrs
  /** Encode a (partial) value for a `patchSignals` event. */
  readonly encode: (value: S["Type"]) => unknown
}

export const make = <S extends Schema.Codec<any, any, never, never>>(schema: S): Signals<S> => {
  const encode = Schema.encodeSync(schema as any) as (value: S["Type"]) => unknown
  return {
    schema,
    path: (p) => p as unknown as SignalPath,
    $: (p) => `$${p}`,
    init: (value) => ({ "data-signals": JSON.stringify(encode(value)) }),
    encode
  }
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

export interface Modifiers {
  readonly debounce?: `${number}ms` | undefined
  readonly throttle?: `${number}ms` | undefined
  readonly prevent?: boolean | undefined
  readonly stop?: boolean | undefined
  readonly window?: boolean | undefined
  readonly outside?: boolean | undefined
  readonly once?: boolean | undefined
}

const mods = (m?: Modifiers): string => {
  if (!m) return ""
  let out = ""
  if (m.debounce) out += `__debounce.${m.debounce}`
  if (m.throttle) out += `__throttle.${m.throttle}`
  if (m.prevent) out += "__prevent"
  if (m.stop) out += "__stop"
  if (m.window) out += "__window"
  if (m.outside) out += "__outside"
  if (m.once) out += "__once"
  return out
}

export const bind = (path: SignalPath): Attrs => ({ "data-bind": path })
export const on = (event: string, expr: Expr, m?: Modifiers): Attrs => ({ [`data-on:${event}${mods(m)}`]: expr })
export const init = (expr: Expr): Attrs => ({ "data-init": expr })
export const text = (expr: Expr): Attrs => ({ "data-text": expr })
export const show = (expr: Expr): Attrs => ({ "data-show": expr })
export const attr = (name: string, expr: Expr): Attrs => ({ [`data-attr:${name}`]: expr })
export const cls = (name: string, expr: Expr): Attrs => ({ [`data-class:${name}`]: expr })
export const indicator = (path: SignalPath): Attrs => ({ "data-indicator": path })
export const ignoreMorph = (): Attrs => ({ "data-ignore-morph": "" })

/** Run `expr` when any signal under one of `paths` changes (client-side or server-patched). */
export const onSignalPatch = (expr: Expr, options: { readonly include: ReadonlyArray<SignalPath> } & Modifiers): Attrs => ({
  [`data-on-signal-patch${mods(options)}`]: expr,
  "data-on-signal-patch-filter": `{include: ${includeRegex(options.include)}}`
})

/** Merge attribute objects (later wins). */
export const merge = (...attrs: ReadonlyArray<Attrs | undefined | false>): Attrs => Object.assign({}, ...attrs.filter(Boolean))

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

/** JS regex literal matching the given signal paths and everything under them. */
export const includeRegex = (paths: ReadonlyArray<SignalPath>): string =>
  `/^(${paths.map(escapeRegex).join("|")})(\\.|$)/`
