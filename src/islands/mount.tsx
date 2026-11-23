/**
 * Browser only, loaded on demand by `client.tsx`: React's part of an island host.
 */
import type { ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Host } from "./host.ts"
import type { Island } from "./Island.tsx"

export interface Mounted {
  readonly render: (island: Island<never>, props: unknown, host: Host) => void
  readonly unmount: () => void
}

export const mount = (container: HTMLElement): Mounted => {
  const root = createRoot(container)
  let first = true
  return {
    render: (island, props, host) => {
      const Component = island.Component as (p: { props: unknown; host: Host }) => ReactNode
      const element = <Component props={props} host={host} />
      // The first render is synchronous, so the island is on screen (and its content
      // placed) when `mount` returns and the host is marked ready; later ones are batched.
      if (first) {
        first = false
        flushSync(() => root.render(element))
      } else {
        root.render(element)
      }
    },
    unmount: () => root.unmount()
  }
}
