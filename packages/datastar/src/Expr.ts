/**
 * Layer 1 — Typed Signal Tree + Composable Datastar Expression AST.
 *
 * Compiles typed signal references, expressions, and actions into clean,
 * properly escaped Datastar JavaScript strings.
 */
import { Schema } from "effect"
import type { Attrs, Paths, SignalPath } from "./Attrs.ts"

// ---------------------------------------------------------------------------
// Structural interfaces (shared with JSX runtime)
// ---------------------------------------------------------------------------

/** Any typed value that compiles to a Datastar JS expression. */
export interface ExprLike<A = unknown> {
  readonly toExpr: () => string
  readonly _type?: A
}

/** A typed reference to a Datastar signal at a schema-checked path. */
export interface SignalLike<A = unknown> extends ExprLike<A> {
  readonly path: SignalPath
}

/** A Datastar statement / action expression (assignments, `@post(...)`, sequences). */
export interface ActionLike {
  readonly toExpr: () => string
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type Primitive = string | number | boolean | null | undefined

type IsPlainObject<T> =
  T extends Primitive | ReadonlyArray<unknown> | Date | ((...args: ReadonlyArray<any>) => any)
    ? false
    : T extends object
      ? true
      : false

// ---------------------------------------------------------------------------
// Expression interfaces
// ---------------------------------------------------------------------------

export interface BaseExpr<A> extends ExprLike<A> {
  readonly toExpr: () => string
  readonly toString: () => string
  readonly eq: (other: A | ExprLike<A>) => Expr<boolean>
  readonly neq: (other: A | ExprLike<A>) => Expr<boolean>
  readonly isNull: () => Expr<boolean>
  readonly isNotNull: () => Expr<boolean>
}

export interface BooleanExprMethods {
  readonly and: (other: boolean | ExprLike<boolean>) => Expr<boolean>
  readonly or: (other: boolean | ExprLike<boolean>) => Expr<boolean>
  readonly not: () => Expr<boolean>
  readonly ternary: <T, F = T>(
    thenBranch: T | ExprLike<T>,
    elseBranch: F | ExprLike<F>
  ) => Expr<T | F>
}

export interface NumberExprMethods {
  readonly gt: (other: number | ExprLike<number>) => Expr<boolean>
  readonly gte: (other: number | ExprLike<number>) => Expr<boolean>
  readonly lt: (other: number | ExprLike<number>) => Expr<boolean>
  readonly lte: (other: number | ExprLike<number>) => Expr<boolean>
  readonly add: (other: number | ExprLike<number>) => Expr<number>
  readonly sub: (other: number | ExprLike<number>) => Expr<number>
}

export interface StringExprMethods {
  readonly nonEmpty: () => Expr<boolean>
  readonly empty: () => Expr<boolean>
  readonly concat: (...parts: ReadonlyArray<string | ExprLike<string | number | boolean>>) => Expr<string>
  readonly includes: (substr: string | ExprLike<string>) => Expr<boolean>
  readonly trim: () => Expr<string>
}

export interface ArrayExprMethods<T> {
  readonly length: Expr<number>
  readonly includes: (item: T | ExprLike<T>) => Expr<boolean>
  readonly isEmpty: () => Expr<boolean>
  readonly nonEmpty: () => Expr<boolean>
  readonly every: (fn: (item: Expr<T>) => ExprLike<boolean>) => Expr<boolean>
  readonly some: (fn: (item: Expr<T>) => ExprLike<boolean>) => Expr<boolean>
  readonly filter: (fn: (item: Expr<T>) => ExprLike<boolean>) => Expr<ReadonlyArray<T>>
}

type TypeSpecificExpr<A> =
  [A] extends [boolean] ? BooleanExprMethods
    : [A] extends [number] ? NumberExprMethods
      : [A] extends [string] ? StringExprMethods
        : [A] extends [ReadonlyArray<infer T>] ? ArrayExprMethods<T>
          : {}

export type Expr<A> = BaseExpr<A> & TypeSpecificExpr<A>

// ---------------------------------------------------------------------------
// Signal interfaces
// ---------------------------------------------------------------------------

export interface BaseSignal<A> extends BaseExpr<A>, SignalLike<A> {
  readonly path: SignalPath
  readonly set: (value: A | ExprLike<A>) => Action
}

export interface BooleanSignalMethods {
  readonly toggle: () => Action
}

export interface NumberSignalMethods {
  readonly inc: (by?: number | ExprLike<number>) => Action
  readonly dec: (by?: number | ExprLike<number>) => Action
}

export interface ArraySignalMethods<T> {
  readonly toggle: (item: T | ExprLike<T>, checked?: ExprLike<boolean>) => Action
  readonly push: (item: T | ExprLike<T>) => Action
  readonly remove: (item: T | ExprLike<T>) => Action
  readonly clear: () => Action
}

type TypeSpecificSignal<A> =
  [A] extends [boolean] ? BooleanSignalMethods
    : [A] extends [number] ? NumberSignalMethods
      : [A] extends [ReadonlyArray<infer T>] ? ArraySignalMethods<T>
        : {}

export type Signal<A> = Expr<A> & BaseSignal<A> & TypeSpecificSignal<A>

export type SignalNode<T> =
  IsPlainObject<T> extends true
    ? Signal<T> & { readonly [K in keyof T]: SignalNode<T[K]> }
    : Signal<T>

export type SignalTree<S extends Schema.Top> = {
  readonly [K in keyof S["Type"]]: SignalNode<S["Type"][K]>
} & {
  readonly schema: S
  /** `data-signals` attribute with the encoded initial value. */
  readonly init: (value: S["Type"]) => Attrs
  /** Encode a value for `Datastar.patchSignals`. */
  readonly encode: (value: S["Type"]) => unknown
  /** Checked dotted path (compatible with `Attrs.Signals`). */
  readonly path: (p: Paths<S["Type"]>) => SignalPath
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export interface Action extends ActionLike {
  readonly toExpr: () => string
  readonly toString: () => string
}

const makeAction = (code: string): Action => ({
  toExpr: () => code,
  toString: () => code
})

const toActionCode = (a: ActionLike | string): string =>
  typeof a === "string" ? a : a.toExpr()

export const Action = {
  /** Wrap a raw Datastar action expression. */
  raw: (expr: string | ActionLike): Action => makeAction(toActionCode(expr)),

  /** Run multiple actions in sequence, ignoring falsy/empty entries. */
  seq: (...actions: ReadonlyArray<ActionLike | string | undefined | false | null>): Action => {
    const parts: Array<string> = []
    for (const a of actions) {
      if (!a) continue
      const code = toActionCode(a).trim()
      if (code.length > 0) parts.push(code)
    }
    return makeAction(parts.join("; "))
  },

  /** Conditionally run `action` when `cond` is truthy. */
  when: (cond: boolean | ExprLike<boolean>, action: ActionLike | string): Action =>
    makeAction(`if (${compileUnwrapped(cond)}) { ${toActionCode(action)} }`),

  /** Prompt with `window.confirm(msg)` before running `action`. */
  confirm: (msg: string | ExprLike<string>, action: ActionLike | string): Action =>
    makeAction(`if (confirm(${compileUnwrapped(msg)})) { ${toActionCode(action)} }`)
} as const

// ---------------------------------------------------------------------------
// Internal compilation helpers
// ---------------------------------------------------------------------------

const ATOMIC = Symbol("datastar.expr.atomic")

interface InternalExpr {
  readonly toExpr: () => string
  readonly [ATOMIC]?: boolean
}

export const isExprLike = (value: unknown): value is ExprLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "toExpr" in value &&
  typeof (value as { readonly toExpr?: unknown }).toExpr === "function"

const isAtomic = (value: unknown): boolean =>
  isExprLike(value) ? Boolean((value as InternalExpr)[ATOMIC]) : true

const compileLiteral = (value: unknown): string =>
  value === undefined ? "undefined" : JSON.stringify(value)

/** Compile an operand without adding outer parentheses (e.g. inside `(...)` or function args). */
const compileUnwrapped = (value: unknown): string =>
  isExprLike(value) ? value.toExpr() : compileLiteral(value)

/** Compile an operand, wrapping non-atomic expressions in `(...)` to preserve precedence. */
const compileOperand = (value: unknown): string => {
  if (!isExprLike(value)) return compileLiteral(value)
  const code = value.toExpr()
  return isAtomic(value) ? code : `(${code})`
}

const wrapSelf = (code: string, atomic: boolean): string =>
  atomic ? code : `(${code})`

let lambdaDepth = 0

const compileLambda = (
  selfCode: string,
  selfAtomic: boolean,
  method: "every" | "some" | "filter",
  fn: (item: Expr<any>) => ExprLike<boolean>
): Expr<any> => {
  const param = lambdaDepth === 0 ? "_x" : `_x${lambdaDepth}`
  lambdaDepth++
  try {
    const body = fn(createExpr(param, true))
    return createExpr(`${wrapSelf(selfCode, selfAtomic)}.${method}((${param}) => ${body.toExpr()})`, true)
  } finally {
    lambdaDepth--
  }
}

// ---------------------------------------------------------------------------
// Core Expr implementation
// ---------------------------------------------------------------------------

const createExpr = <A>(code: string, atomic: boolean): Expr<A> => {
  const self = wrapSelf(code, atomic)

  const obj: Record<string | symbol, unknown> = {
    [ATOMIC]: atomic,
    toExpr: () => code,
    toString: () => code,

    // Universal
    eq: (other: unknown) => createExpr<boolean>(`${self} === ${compileOperand(other)}`, false),
    neq: (other: unknown) => createExpr<boolean>(`${self} !== ${compileOperand(other)}`, false),
    isNull: () => createExpr<boolean>(`${self} == null`, false),
    isNotNull: () => createExpr<boolean>(`${self} != null`, false),

    // Boolean
    and: (other: unknown) => createExpr<boolean>(`${self} && ${compileOperand(other)}`, false),
    or: (other: unknown) => createExpr<boolean>(`${self} || ${compileOperand(other)}`, false),
    not: () => createExpr<boolean>(`!${self}`, true),
    ternary: (thenBranch: unknown, elseBranch: unknown) =>
      createExpr(`${self} ? ${compileOperand(thenBranch)} : ${compileOperand(elseBranch)}`, false),

    // Number
    gt: (other: unknown) => createExpr<boolean>(`${self} > ${compileOperand(other)}`, false),
    gte: (other: unknown) => createExpr<boolean>(`${self} >= ${compileOperand(other)}`, false),
    lt: (other: unknown) => createExpr<boolean>(`${self} < ${compileOperand(other)}`, false),
    lte: (other: unknown) => createExpr<boolean>(`${self} <= ${compileOperand(other)}`, false),
    add: (other: unknown) => createExpr<number>(`${self} + ${compileOperand(other)}`, false),
    sub: (other: unknown) => createExpr<number>(`${self} - ${compileOperand(other)}`, false),

    // String & Array shared
    nonEmpty: () => createExpr<boolean>(`${self}.length > 0`, false),
    empty: () => createExpr<boolean>(`${self}.length === 0`, false),
    isEmpty: () => createExpr<boolean>(`${self}.length === 0`, false),
    includes: (item: unknown) => createExpr<boolean>(`${self}.includes(${compileUnwrapped(item)})`, true),

    // String
    concat: (...parts: ReadonlyArray<unknown>) => {
      if (parts.length === 0) return createExpr<string>(code, atomic)
      const compiled = [self, ...parts.map(compileOperand)]
      return createExpr<string>(compiled.join(" + "), false)
    },
    trim: () => createExpr<string>(`${self}.trim()`, true),

    // Array
    every: (fn: (item: Expr<any>) => ExprLike<boolean>) => compileLambda(code, atomic, "every", fn),
    some: (fn: (item: Expr<any>) => ExprLike<boolean>) => compileLambda(code, atomic, "some", fn),
    filter: (fn: (item: Expr<any>) => ExprLike<boolean>) => compileLambda(code, atomic, "filter", fn)
  }

  Object.defineProperty(obj, "length", {
    enumerable: true,
    get: () => createExpr<number>(`${self}.length`, true)
  })

  return obj as unknown as Expr<A>
}

/** Lift a literal value into a typed `Expr<A>`. */
export const lit = <A>(value: A): Expr<A> => createExpr<A>(compileLiteral(value), true)

/** Wrap a raw Datastar JS expression with an explicit result type. */
export const raw = <A = unknown>(expr: string): Expr<A> => createExpr<A>(expr, false)

// ---------------------------------------------------------------------------
// `E` tagged template literal
// ---------------------------------------------------------------------------

type TemplateValue = string | number | boolean | ExprLike<string | number | boolean>

/**
 * Tagged template literal compiling interpolated `ExprLike`s into a safe
 * Datastar JS string expression (`+` concatenation with `JSON.stringify` literals).
 *
 * Example: `` E`${$.selection.length} selected` `` -> `$selection.length + " selected"`
 */
export const E = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<TemplateValue>
): Expr<string> => {
  const parts: Array<string> = []
  let hasStringLiteral = false

  for (let i = 0; i < strings.length; i++) {
    const segment = strings[i]!
    if (segment.length > 0) {
      parts.push(JSON.stringify(segment))
      hasStringLiteral = true
    }
    if (i < values.length) {
      parts.push(compileOperand(values[i]))
    }
  }

  if (parts.length === 0) {
    return createExpr<string>('""', true)
  }
  if (parts.length === 1) {
    if (hasStringLiteral) return createExpr<string>(parts[0]!, true)
    return createExpr<string>(`"" + ${parts[0]!}`, false)
  }
  const needsLeadingString =
    !hasStringLiteral || (strings[0]!.length === 0 && (strings.length <= 1 || strings[1]!.length === 0))
  if (needsLeadingString) {
    return createExpr<string>(`"" + ${parts.join(" + ")}`, false)
  }
  return createExpr<string>(parts.join(" + "), false)
}

// ---------------------------------------------------------------------------
// DOM helpers: `el` and `evt`
// ---------------------------------------------------------------------------

export type SettableExpr<A> = Expr<A> & {
  readonly set: (value: A | ExprLike<A>) => Action
}

const makeSettableExpr = <A>(expr: string): SettableExpr<A> => {
  const base = createExpr<A>(expr, true) as unknown as Record<string | symbol, unknown>
  base.set = (value: A | ExprLike<A>): Action => makeAction(`${expr} = ${compileUnwrapped(value)}`)
  return base as unknown as SettableExpr<A>
}

export const el = {
  value: makeSettableExpr<string>("el.value"),
  checked: makeSettableExpr<boolean>("el.checked"),
  indeterminate: makeSettableExpr<boolean>("el.indeterminate"),
  remove: (): Action => makeAction("el.remove()")
} as const

const evtTarget = (() => {
  const base = createExpr<EventTarget>("evt.target", true) as unknown as Record<string | symbol, unknown>
  base.value = createExpr<string>("evt.target.value", true)
  base.checked = createExpr<boolean>("evt.target.checked", true)
  return base as unknown as Expr<EventTarget> & {
    readonly value: Expr<string>
    readonly checked: Expr<boolean>
  }
})()

export const evt = {
  target: evtTarget,
  key: createExpr<string>("evt.key", true),
  preventDefault: (): Action => makeAction("evt.preventDefault()"),
  stopPropagation: (): Action => makeAction("evt.stopPropagation()")
} as const

// ---------------------------------------------------------------------------
// Schema-driven Signal Tree (`Signals.from` / `fromSchema`)
// ---------------------------------------------------------------------------

/** Extract child field schemas from an Effect Schema struct, if it is one. */
const getStructFields = (schema: unknown): Record<string, unknown> | undefined => {
  if ((typeof schema === "object" || typeof schema === "function") && schema !== null && "fields" in schema) {
    const fields = (schema as { readonly fields?: unknown }).fields
    if (typeof fields === "object" && fields !== null) {
      return fields as Record<string, unknown>
    }
  }
  return undefined
}

const BASE_SIGNAL_KEYS = new Set<string>([
  "path",
  "set",
  "toExpr",
  "toString",
  "eq",
  "neq",
  "isNull",
  "isNotNull"
])

const createSignalNode = (pathStr: string, fieldSchema?: unknown): unknown => {
  const ref = `$${pathStr}`
  const path = pathStr as SignalPath
  const expr = createExpr<unknown>(ref, true) as unknown as Record<string | symbol, unknown>
  const structFields = getStructFields(fieldSchema)

  expr.path = path
  expr.set = (value: unknown): Action => makeAction(`${ref} = ${compileUnwrapped(value)}`)

  // Boolean / Array toggle (0 args = boolean toggle, 1-2 args = array toggle)
  expr.toggle = (...args: ReadonlyArray<unknown>): Action => {
    if (args.length === 0) {
      return makeAction(`${ref} = !${ref}`)
    }
    const item = compileUnwrapped(args[0])
    if (args.length >= 2 && args[1] !== undefined) {
      const checked = compileOperand(args[1])
      return makeAction(
        `${ref} = ${checked} ? (${ref}.includes(${item}) ? ${ref} : [...${ref}, ${item}]) : ${ref}.filter((_x) => _x !== ${item})`
      )
    }
    return makeAction(
      `${ref} = ${ref}.includes(${item}) ? ${ref}.filter((_x) => _x !== ${item}) : [...${ref}, ${item}]`
    )
  }

  // Array mutators
  expr.push = (item: unknown): Action =>
    makeAction(`${ref} = [...${ref}, ${compileUnwrapped(item)}]`)
  expr.remove = (item: unknown): Action =>
    makeAction(`${ref} = ${ref}.filter((_x) => _x !== ${compileUnwrapped(item)})`)
  expr.clear = (): Action =>
    makeAction(`${ref} = []`)

  // Number mutators
  expr.inc = (by: unknown = 1): Action =>
    makeAction(`${ref} = ${ref} + ${compileOperand(by)}`)
  expr.dec = (by: unknown = 1): Action =>
    makeAction(`${ref} = ${ref} - ${compileOperand(by)}`)

  const children = new Map<string, unknown>()
  const getChild = (prop: string): unknown => {
    let child = children.get(prop)
    if (child === undefined) {
      child = createSignalNode(`${pathStr}.${prop}`, structFields?.[prop])
      children.set(prop, child)
    }
    return child
  }

  return new Proxy(expr, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver)
      // Known struct fields take precedence over type-specific methods (e.g. `query.filter`)
      if (structFields && prop in structFields && !BASE_SIGNAL_KEYS.has(prop)) {
        return getChild(prop)
      }
      if (prop in target) {
        return Reflect.get(target, prop, receiver)
      }
      return getChild(prop)
    }
  })
}

const wrapNested = (prefix: string | undefined, value: unknown): unknown => {
  if (!prefix) return value
  const segments = prefix.split(".").filter((s) => s.length > 0)
  let out: unknown = value
  for (let i = segments.length - 1; i >= 0; i--) {
    out = { [segments[i]!]: out }
  }
  return out
}

/**
 * Build a typed signal tree from an Effect `Schema` struct.
 *
 * Optionally accepts a dot-separated `prefix` (e.g. `"counter"` or `"sidebar.counter"`)
 * to namespace all signal paths and `init`/`encode` output.
 */
export const fromSchema = <S extends Schema.Codec<any, any, never, never>>(
  schema: S,
  prefix?: string
): SignalTree<S> => {
  const encodeRaw = Schema.encodeSync(schema as any) as (value: S["Type"]) => unknown
  const encode = (value: S["Type"]): unknown => wrapNested(prefix, encodeRaw(value))
  const structFields = getStructFields(schema)
  const children = new Map<string, unknown>()

  const getChild = (prop: string): unknown => {
    let child = children.get(prop)
    if (child === undefined) {
      const fullPath = prefix ? `${prefix}.${prop}` : prop
      child = createSignalNode(fullPath, structFields?.[prop])
      children.set(prop, child)
    }
    return child
  }

  const root: Record<string | symbol, unknown> = {
    schema,
    init: (value: S["Type"]): Attrs => ({ "data-signals": JSON.stringify(encode(value)) }),
    encode,
    path: (p: string): SignalPath => (prefix ? `${prefix}.${p}` : p) as SignalPath
  }

  return new Proxy(root, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver)
      if (prop in target) return Reflect.get(target, prop, receiver)
      return getChild(prop)
    }
  }) as unknown as SignalTree<S>
}

export const Signals = {
  from: fromSchema
} as const
