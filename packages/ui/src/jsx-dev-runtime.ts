/**
 * Development JSX runtime wrapping `react/jsx-dev-runtime` with typed `$`-prefixed
 * Datastar props.
 */
import type * as React from "react"
import { Fragment, jsxDEV as reactJsxDEV, type JSXSource } from "react/jsx-dev-runtime"
import { transformProps } from "./jsx-runtime.ts"

export { Fragment }
export type {
  ActionLike,
  DatastarProps,
  EventHandlerSpec,
  ExprLike,
  JSX,
  OnSignalPatchSpec,
  SignalLike
} from "./jsx-runtime.ts"
export type { JSXSource }

export function jsxDEV(
  type: React.ElementType,
  props: unknown,
  key: React.Key | undefined,
  isStatic: boolean,
  source?: JSXSource,
  self?: unknown
): React.ReactElement {
  return reactJsxDEV(type, transformProps(type, props), key, isStatic, source, self)
}
