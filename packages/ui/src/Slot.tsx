/**
 * React Slot helpers for Datastar `patchElements`.
 *
 * A slot pairs a stable DOM target (`id` or `prefix-key`) with a React component,
 * providing a `<Mount />` component for initial SSR and typed `morph`/`prepend`/`append`/`remove`
 * helpers that emit `Datastar.patchElements` events rendered via `Html.render`.
 */
import { cloneElement, Fragment, isValidElement, type ReactNode } from "react"
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import * as Html from "./Html.ts"

export interface SlotPatchOptions {
  readonly useViewTransition?: boolean | undefined
}

const withId = (node: ReactNode, id: string): ReactNode => {
  if (isValidElement<{ id?: string }>(node) && node.type !== Fragment && node.props.id === undefined) {
    return cloneElement(node, { id })
  }
  return node
}

type EmptyProps = Record<never, never>
type PropsArgs<P> = [keyof P] extends [never]
  ? [props?: P, options?: SlotPatchOptions]
  : [props: P, options?: SlotPatchOptions]

export interface ReactSlot<P extends object> {
  readonly id: string
  readonly selector: string
  readonly Mount: (props: P) => ReactNode
  readonly render: (...args: [keyof P] extends [never] ? [props?: P] : [props: P]) => Datastar.Html
  readonly morph: (...args: PropsArgs<P>) => Datastar.DatastarEvent
  readonly prepend: (...args: PropsArgs<P>) => Datastar.DatastarEvent
  readonly append: (...args: PropsArgs<P>) => Datastar.DatastarEvent
  readonly remove: (options?: SlotPatchOptions) => Datastar.DatastarEvent
}

/**
 * Define a single-target Datastar slot backed by a React component.
 * If the component's root element does not already specify `id`, `Mount` and `morph`
 * attach `id` automatically without adding a wrapper element.
 */
export const reactSlot = <P extends object = EmptyProps>(
  id: string,
  Component: (props: P) => ReactNode
): ReactSlot<P> => {
  const selector = `#${id}`

  const Mount = (props: P): ReactNode => withId(Component(props), id)

  const renderMounted = (props?: P): Datastar.Html => Html.render(Mount((props ?? {}) as P))
  const renderRaw = (props?: P): Datastar.Html => Html.render(Component((props ?? {}) as P))

  return {
    id,
    selector,
    Mount,
    render: (props?: P) => renderMounted(props),
    morph: (props?: P, options?: SlotPatchOptions) =>
      Datastar.patchElements(renderMounted(props), { selector, mode: "outer", ...options }),
    prepend: (props?: P, options?: SlotPatchOptions) =>
      Datastar.patchElements(renderRaw(props), { selector, mode: "prepend", ...options }),
    append: (props?: P, options?: SlotPatchOptions) =>
      Datastar.patchElements(renderRaw(props), { selector, mode: "append", ...options }),
    remove: (options?: SlotPatchOptions) =>
      Datastar.patchElements("", { selector, mode: "remove", ...options })
  }
}

export interface KeyedSlot<P extends object, K extends string | number = string | number> {
  readonly prefix: string
  readonly idForKey: (key: K) => string
  readonly idOf: (props: P) => string
  readonly selectorForKey: (key: K) => string
  readonly selectorOf: (props: P) => string
  readonly Mount: (props: P) => ReactNode
  readonly render: (props: P) => Datastar.Html
  readonly morph: (props: P, options?: SlotPatchOptions) => Datastar.DatastarEvent
  readonly prepend: (containerSelector: string, props: P, options?: SlotPatchOptions) => Datastar.DatastarEvent
  readonly append: (containerSelector: string, props: P, options?: SlotPatchOptions) => Datastar.DatastarEvent
  readonly remove: (keyOrProps: K | P, options?: SlotPatchOptions) => Datastar.DatastarEvent
}

/**
 * Define a keyed Datastar slot (for list rows, cards, etc.) where each item gets
 * DOM id `${prefix}-${keyOf(props)}`.
 */
export const keyedSlot = <P extends object, K extends string | number = string | number>(
  prefix: string,
  keyOf: (props: P) => K,
  Component: (props: P) => ReactNode
): KeyedSlot<P, K> => {
  const idForKey = (key: K): string => `${prefix}-${key}`
  const idOf = (props: P): string => idForKey(keyOf(props))
  const selectorForKey = (key: K): string => `#${idForKey(key)}`
  const selectorOf = (props: P): string => `#${idOf(props)}`

  const Mount = (props: P): ReactNode => withId(Component(props), idOf(props))
  const renderItem = (props: P): Datastar.Html => Html.render(Mount(props))

  return {
    prefix,
    idForKey,
    idOf,
    selectorForKey,
    selectorOf,
    Mount,
    render: renderItem,
    morph: (props: P, options?: SlotPatchOptions) =>
      Datastar.patchElements(renderItem(props), { selector: selectorOf(props), mode: "outer", ...options }),
    prepend: (containerSelector: string, props: P, options?: SlotPatchOptions) =>
      Datastar.patchElements(renderItem(props), { selector: containerSelector, mode: "prepend", ...options }),
    append: (containerSelector: string, props: P, options?: SlotPatchOptions) =>
      Datastar.patchElements(renderItem(props), { selector: containerSelector, mode: "append", ...options }),
    remove: (keyOrProps: K | P, options?: SlotPatchOptions) => {
      const selector = typeof keyOrProps === "string" || typeof keyOrProps === "number"
        ? selectorForKey(keyOrProps)
        : selectorOf(keyOrProps as P)
      return Datastar.patchElements("", { selector, mode: "remove", ...options })
    }
  }
}
