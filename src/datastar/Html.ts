/**
 * React elements -> HTML strings, for Datastar patches and pages.
 *
 * `renderToStaticMarkup`, not `renderToString`: nothing server-rendered is hydrated (islands
 * mount fresh, see `islands/Island.tsx`), so the `<!-- -->` text separators that hydration
 * needs (`Page <!-- -->2<!-- --> of <!-- -->9`) would only be noise for Datastar's morph.
 *
 * React escapes text and attribute values (`'` -> `&#x27;`, `>` -> `&gt;`); the browser
 * decodes attributes before Datastar reads them, so expressions in `data-*` survive.
 */
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { timeRender } from "../metrics/Metrics.ts"

/** HTML for a fragment (a patch). */
export const render = (node: ReactNode): string => timeRender(() => renderToStaticMarkup(node))

/** HTML for a whole page: `<!doctype html>` + the `<html>` element. */
export const document = (node: ReactNode): string => `<!doctype html>${renderToStaticMarkup(node)}`
