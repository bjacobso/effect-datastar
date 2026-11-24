/**
 * Layer 3 — Renderer-agnostic Typed Patch Slots.
 *
 * A `Slot` pairs a DOM element ID with a typed HTML renderer so server handlers
 * produce type-safe `Datastar.PatchElements` without repeating selectors or modes.
 */
import * as Datastar from "./Datastar.ts"

export interface Slot<P> {
  readonly id: string
  readonly selector: string
  readonly render: (props: P) => string
  readonly morph: (props: P) => Datastar.PatchElements
  readonly inner: (props: P) => Datastar.PatchElements
  readonly remove: () => Datastar.PatchElements
  readonly scope: (prefix: string) => Slot<P>
}

export interface KeyedSlot<P, K extends string | number> {
  readonly containerId: string
  readonly containerSelector: string
  readonly itemId: (key: K) => string
  readonly render: (props: P) => string
  readonly morphItem: (props: P) => Datastar.PatchElements
  readonly prepend: (props: P) => Datastar.PatchElements
  readonly append: (props: P) => Datastar.PatchElements
  readonly removeItem: (key: K) => Datastar.PatchElements
  readonly scope: (prefix: string) => KeyedSlot<P, K>
}

export type AnySlot = Slot<any> | KeyedSlot<any, any>

export const make = <P>(
  id: string,
  renderHtml: (props: P, id: string) => string
): Slot<P> => {
  const selector = `#${id}`
  const render = (props: P): string => renderHtml(props, id)
  return {
    id,
    selector,
    render,
    morph: (props: P) =>
      new Datastar.PatchElements({ elements: render(props), selector, mode: "outer" }),
    inner: (props: P) =>
      new Datastar.PatchElements({ elements: render(props), selector, mode: "inner" }),
    remove: () =>
      new Datastar.PatchElements({ elements: "", selector, mode: "remove" }),
    scope: (prefix: string) => make<P>(`${prefix}-${id}`, renderHtml)
  }
}

export const keyed = <P, K extends string | number>(
  prefix: string,
  keyOf: (props: P) => K,
  renderHtml: (props: P, itemId: string) => string
): KeyedSlot<P, K> => {
  const containerId = prefix
  const containerSelector = `#${containerId}`
  const itemId = (key: K): string => `${containerId}-${key}`
  const render = (props: P): string => renderHtml(props, itemId(keyOf(props)))
  return {
    containerId,
    containerSelector,
    itemId,
    render,
    morphItem: (props: P) =>
      new Datastar.PatchElements({
        elements: render(props),
        selector: `#${itemId(keyOf(props))}`,
        mode: "outer"
      }),
    prepend: (props: P) =>
      new Datastar.PatchElements({
        elements: render(props),
        selector: containerSelector,
        mode: "prepend"
      }),
    append: (props: P) =>
      new Datastar.PatchElements({
        elements: render(props),
        selector: containerSelector,
        mode: "append"
      }),
    removeItem: (key: K) =>
      new Datastar.PatchElements({
        elements: "",
        selector: `#${itemId(key)}`,
        mode: "remove"
      }),
    scope: (ns: string) => keyed<P, K>(`${ns}-${prefix}`, keyOf, renderHtml)
  }
}

export const Slot = {
  make,
  keyed
} as const
