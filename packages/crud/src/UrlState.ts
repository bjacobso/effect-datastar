/**
 * The list query in the URL, with history: each filter, sort or page change is a
 * history entry, so Back and Forward step through list states.
 *
 * Server -> address bar: every new live stream patches `${ns}._url` (a local
 * signal) with the canonical URL of its query. An effect writes it to the
 * address bar:
 *
 *   - `pushState` for a new state (a select, a sort header, a page button);
 *   - while typing in a text filter, the first change pushes and the rest
 *     replace that entry, so a search is one entry, not one per keystroke.
 *     `_typing` is set on `input` and cleared on `blur`; `_pushed` records that
 *     this typing session already has its entry;
 *   - `replaceState` for the first sync after load (`_nav` starts at "replace"),
 *     which only canonicalizes the URL the page was opened with
 *     (`?page=99` -> `?page=9`).
 *
 * Address bar -> signals: on `popstate`, the page asks the server for the
 * query of the URL it is now on (`GET /users/query?…`, see `Resource`), which
 * answers with a `patchSignals` of `${ns}.query`. The patch wakes the live view
 * like any query change; its stream's `_url` is then already the address, so
 * nothing is pushed. A round-trip rather than parsing in the browser: the
 * server's `Query.fromSearchParams` is the one parser (defaults, per-field
 * schemas, page sizes, invalid params), so the restored query is exactly what
 * a reload of that URL would render.
 *
 * Only one table per page owns the URL (the list page's); embeds don't.
 */
import * as ds from "@effect-datastar/datastar/Attrs.ts"

/** The local signals the effect uses, with their initial values. `url` is the page's canonical URL. */
export const initial = (url: string) => ({ _url: url, _nav: "replace", _typing: false, _pushed: false })

/** For the table's section: keeps the address bar in step with `_url`, and restores the query on Back/Forward. */
export const attrs = (ns: string, restore: ds.Expr): ds.Attrs => {
  const $ = (name: string) => `$${ns}.${name}`
  const here = "location.pathname + location.search"
  return ds.merge(
    ds.effect(
      `${$("_url")} && ${$("_url")} !== ${here} && (` +
        `${$("_nav")} === 'replace' || (${$("_typing")} && ${$("_pushed")})` +
        ` ? history.replaceState(history.state, '', ${$("_url")})` +
        ` : (history.pushState(null, '', ${$("_url")}), ${$("_pushed")} = ${$("_typing")})` +
        `); ${$("_nav")} = 'push'`
    ),
    ds.on("popstate", `${$("_typing")} = false; ${$("_pushed")} = false; ${restore}`, { window: true })
  )
}

/** For a text filter: typing replaces the entry its first change pushed, until the field loses focus. */
export const typing = (ns: string) => ({
  input: `$${ns}._typing = true`,
  blur: `$${ns}._typing = false; $${ns}._pushed = false`
})
