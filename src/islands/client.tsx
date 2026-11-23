/**
 * The browser entry (`public/build/islands.js`): defines `<ds-island>` and applies the
 * saved color scheme. Everything else on the page is server-rendered and driven by Datastar.
 *
 * This module is small and has no React: the element is defined eagerly, and each host
 * loads React (`mount.tsx`) and its island's code (`loaders.ts`) when it connects. The
 * build splits those into chunks, so a page fetches only the islands it uses.
 *
 * Load order matters: the layout puts this module before `datastar.js`, so `<ds-island>`
 * is defined (and every host upgraded) before Datastar applies `data-bind`. Datastar
 * checks `"value" in el` once, when it binds: an upgraded host binds the `value`
 * property; a not-yet-defined one would bind the `value` attribute instead. The `value`
 * property works before the island's code arrives; the island renders it once loaded.
 */
import { syncTheme } from "../ui/theme/themes.ts"
import { type Host, TAG } from "./host.ts"
import type { Island } from "./Island.tsx"
import { loaders } from "./loaders.ts"
import type { Mounted } from "./mount.tsx"

let react: Promise<typeof import("./mount.tsx")> | undefined
const loadReact = () => (react ??= import("./mount.tsx"))

class IslandElement extends HTMLElement {
  #value: unknown = ""
  #mounted: Mounted | undefined
  #island: Island<never> | undefined
  #loading = false
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
    if (this.#mounted || this.#loading) return // moved within the document: keep the island
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
    this.#observer = new MutationObserver(() => this.#render())
    this.#observer.observe(this, { attributes: true })

    const name = this.getAttribute("name") ?? ""
    const load = loaders[name]
    if (!load) {
      console.error(`Unknown island "${name}"`, this)
      return
    }
    this.#loading = true
    const target = container
    Promise.all([loadReact(), load()]).then(([{ mount }, island]) => {
      this.#loading = false
      if (!this.isConnected) {
        this.#observer?.disconnect() // removed while loading; a reconnect starts over
        return
      }
      this.#island = island
      // The server-rendered content (already bound by Datastar), handed over to the island.
      const holder = this.querySelector(":scope > [data-island-content]")
      if (holder && !this.#content) {
        this.#content = document.createDocumentFragment()
        this.#content.append(...holder.childNodes)
      }
      this.#mounted = mount(target)
      this.#render()
    }, (error: unknown) => {
      this.#loading = false
      console.error(`Could not load island "${name}"`, error)
    })
  }

  disconnectedCallback() {
    // Unmount only if it is really gone (not just moved), and outside React's commit.
    queueMicrotask(() => {
      if (this.isConnected) return
      this.#observer?.disconnect()
      this.#mounted?.unmount()
      this.#mounted = undefined
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
    if (!this.#mounted || !this.#island) return
    let props: unknown
    try {
      props = JSON.parse(this.getAttribute("props") ?? "{}")
    } catch (error) {
      console.error(`Invalid props for island "${this.#island.name}"`, error)
      return
    }
    this.#mounted.render(this.#island, props, this.#host())
  }
}

syncTheme()
customElements.define(TAG, IslandElement)
