/**
 * Browser only, loaded on demand by `client.tsx`: React's part of an island host.
 */
import type { ReactNode } from "react"
import { createRoot } from "react-dom/client"
import type { Host } from "./host.ts"
import type { Island } from "./Island.tsx"

export interface Mounted {
  readonly render: (island: Island<never>, props: unknown, host: Host) => void
  readonly unmount: () => void
}

export const mount = (container: HTMLElement): Mounted => {
  const root = createRoot(container)
  return {
    render: (island, props, host) => {
      const Component = island.Component as (p: { props: unknown; host: Host }) => ReactNode
      root.render(<Component props={props} host={host} />)
    },
    unmount: () => root.unmount()
  }
}
