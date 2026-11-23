/**
 * The host side of an island, without React: the custom element's tag and what a
 * component sees of it. Kept apart from `Island.tsx` so the eager browser loader
 * (`client.tsx`) can define `<ds-island>` without pulling in React.
 */

export const TAG = "ds-island"

/** Set on the host once the island has rendered in the browser (until then it is the server's placeholder). */
export const READY = "data-island-ready"

/** What an island component sees of its host element. */
export interface Host {
  /** The value Datastar binds with `data-bind` on the host. */
  readonly value: unknown
  /** Sets the value and tells Datastar (a `change` event on the host). */
  readonly setValue: (value: unknown) => void
  /** An attribute of the host, e.g. one Datastar sets with `data-attr:*`. */
  readonly attr: (name: string) => string | null
  /** Dispatches an event on the host, for `data-on:*`. */
  readonly emit: (type: string) => void
  /**
   * The hidden holder of the host's server-rendered content (`Island.Mount`'s `content`).
   * The island moves its children to where it renders them, in a layout effect: until
   * then they stay in the holder, in the document, so Datastar patches always find them.
   */
  readonly content: Element | null
}
