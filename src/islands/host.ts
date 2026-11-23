/**
 * The host side of an island, without React: the custom element's tag and what a
 * component sees of it. Kept apart from `Island.tsx` so the eager browser loader
 * (`client.tsx`) can define `<ds-island>` without pulling in React.
 */

export const TAG = "ds-island"

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
  /** The host's server-rendered content (`Island.Mount`'s `content`), moved out of its hidden holder on mount. */
  readonly content: DocumentFragment | null
}
