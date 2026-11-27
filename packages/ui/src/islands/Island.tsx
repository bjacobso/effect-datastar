/**
 * React islands inside Datastar pages.
 *
 * The server renders every page with React (`react-dom/server`), without client JS. An
 * island is a component that also runs in the browser. The server renders its host:
 *
 *   <ds-island name="select" props='{"options":[...]}' data-bind="users.draft.teamId">
 *     <div data-island-root data-ignore-morph>…the component, rendered once on the server…</div>
 *     <div data-island-content data-ignore-morph hidden>…optional server-rendered content the
 *       island places itself (the dialog's form)…</div>
 *   </ds-island>
 *
 * and `client.tsx` (the browser entry) defines `<ds-island>`, which loads the island's
 * code on demand (`loaders.ts`) and mounts the component into `[data-island-root]` with
 * `createRoot` (no hydration: the server markup is a placeholder, so the two never have
 * to match).
 *
 * Datastar stays in charge of state. The host is the boundary:
 *
 * - `data-bind` on the host binds its `value` property (Datastar v1 binds `value` on any
 *   custom element that has one, listening for `input`/`change`). The island reads
 *   `host.value` and calls `host.setValue(v)`, which dispatches `change`.
 * - Other inputs are host attributes (e.g. `data-attr:open="$users.dialog"`); the island
 *   re-renders when any host attribute changes, `props` included.
 * - Other outputs are events on the host (`host.emit("close")` for `data-on:close`).
 *
 * Morphs: `[data-island-root]` has `data-ignore-morph`, so morphing an ancestor leaves the
 * React DOM alone while the host's own attributes (`props`) still update. Replacing the
 * host (a `replace` patch) unmounts the old island and mounts a new one.
 *
 * Content: it is live (hidden) markup from the start, not a `<template>`, so Datastar binds
 * it and patches can target what is inside before the island's code has loaded (islands
 * load on demand). The island moves the nodes where it wants them when it mounts.
 */
import * as stylex from "@stylexjs/stylex"
import type { DetailedHTMLProps, HTMLAttributes, ReactNode } from "react"
import type { Attrs } from "@effect-datastar/datastar/Attrs.ts"
import { type DatastarProps, transformProps } from "../jsx-runtime.ts"
import { type Host, TAG } from "./host.ts"

export { type Host, TAG }

export interface Island<P> {
  readonly name: string
  readonly Component: (props: { readonly props: P; readonly host: Host }) => ReactNode
}

/** Defines an island. `P` must survive `JSON.stringify` (it travels in an attribute). */
export const make = <P,>(name: string, Component: Island<P>["Component"]): Island<P> => ({ name, Component })

/** The host the server renders the placeholder with: initial value, no interaction. */
const staticHost = (value: unknown, attrs: Attrs): Host => ({
  value,
  setValue: () => {},
  attr: (name) => attrs[name as keyof Attrs] ?? null,
  emit: () => {},
  content: null
})

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      [TAG]: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        readonly name: string
        readonly props: string
      }
    }
  }
}

/**
 * Server side: an island's host, with the component rendered as its placeholder.
 * Accepts `$`-prefixed Datastar props (`$bind`, `$attr`, `$on`, ...) as well as
 * legacy `attrs` (`ds.bind(...)`, `ds.attr(...)`, ...).
 */
export function Mount<P>({
  island,
  props: islandProps,
  id,
  attrs,
  value,
  content,
  display,
  ...dsProps
}: {
  readonly island: Island<P>
  readonly props: P
  readonly id?: string | undefined
  readonly attrs?: Attrs | undefined
  /** The placeholder's value (what `data-bind` will set on the client). */
  readonly value?: unknown
  /** Server-rendered content the island places itself (`host.content`). */
  readonly content?: ReactNode
  readonly display?: "block" | "contents"
} & DatastarProps) {
  const compiled = transformProps(TAG, dsProps) as Attrs
  const hostAttrs: Attrs = attrs ? { ...attrs, ...compiled } : compiled
  return (
    <ds-island
      name={island.name}
      props={JSON.stringify(islandProps)}
      id={id}
      {...hostAttrs}
      {...stylex.props(display === "contents" ? styles.contents : styles.block)}
    >
      <div data-island-root="" data-ignore-morph="">
        <island.Component props={islandProps} host={staticHost(value ?? "", hostAttrs)} />
      </div>
      {content !== undefined && <div data-island-content="" data-ignore-morph="" hidden>{content}</div>}
    </ds-island>
  )
}

const styles = stylex.create({
  block: { display: "block", minWidth: 0 },
  contents: { display: "contents" }
})
