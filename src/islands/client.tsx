/**
 * The browser bundle (`public/build/islands.js`): defines `<ds-island>` and applies the
 * saved color scheme. Everything else on the page is server-rendered and driven by Datastar.
 *
 * Load order matters: the layout puts this module before `datastar.js`, so `<ds-island>`
 * is defined (and every host upgraded) before Datastar applies `data-bind`. Datastar
 * checks `"value" in el` once, when it binds: an upgraded host binds the `value`
 * property; a not-yet-defined one would bind the `value` attribute instead.
 */
import type { ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { syncTheme } from "../ui/theme/themes.ts"
import { type Host, type Island, TAG } from "./Island.tsx"
import { all } from "./islands.tsx"

const registry = new Map<string, Island<never>>(all.map((island) => [island.name, island]))

class IslandElement extends HTMLElement {
  #value: unknown = ""
  #root: Root | undefined
  #observer: MutationObserver | undefined
  #content: DocumentFragment | null = null

  /** Bound by Datastar's `data-bind`. Setting it from outside re-renders without events. */
  get value(): unknown {
    return this.#value
  }
  set value(next: unknown) {
    if (Object.is(next, this.#value)) return
    this.#value = next
    this.#render()
  }

  connectedCallback() {
    if (this.#root) return // moved within the document: keep the mounted island
    let container = this.querySelector<HTMLElement>(":scope > [data-island-root]")
    if (!container) {
      container = document.createElement("div")
      container.setAttribute("data-island-root", "")
      container.setAttribute("data-ignore-morph", "")
      this.prepend(container)
    }
    // ui-sdk parts keep hidden form inputs and fire their own input/change events. Only
    // the host's `change` (from `setValue`) is for Datastar, so stop theirs at the root.
    for (const type of ["input", "change"]) container.addEventListener(type, (e) => e.stopPropagation())
    const template = this.querySelector<HTMLTemplateElement>(":scope > template")
    this.#content = template ? (template.content.cloneNode(true) as DocumentFragment) : null
    this.#root = createRoot(container)
    this.#observer = new MutationObserver(() => this.#render())
    this.#observer.observe(this, { attributes: true })
    this.#render()
  }

  disconnectedCallback() {
    // Unmount only if it is really gone (not just moved), and outside React's commit.
    queueMicrotask(() => {
      if (this.isConnected) return
      this.#observer?.disconnect()
      this.#root?.unmount()
      this.#root = undefined
    })
  }

  #host(): Host {
    return {
      value: this.#value,
      setValue: (next) => {
        if (Object.is(next, this.#value)) return
        this.#value = next
        this.#render()
        this.dispatchEvent(new Event("change", { bubbles: true }))
      },
      attr: (name) => this.getAttribute(name),
      emit: (type) => this.dispatchEvent(new Event(type)),
      content: this.#content
    }
  }

  #render() {
    if (!this.#root) return
    const name = this.getAttribute("name") ?? ""
    const island = registry.get(name)
    if (!island) {
      console.error(`Unknown island "${name}"`, this)
      return
    }
    let props: unknown
    try {
      props = JSON.parse(this.getAttribute("props") ?? "{}")
    } catch (error) {
      console.error(`Invalid props for island "${name}"`, error)
      return
    }
    const Component = island.Component as (p: { props: unknown; host: Host }) => ReactNode
    this.#root.render(<Component props={props} host={this.#host()} />)
  }
}

syncTheme()
customElements.define(TAG, IslandElement)
