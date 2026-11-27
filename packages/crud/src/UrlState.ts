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
import { Schema } from "effect"
import { Action, type ActionLike, raw, Signals } from "@effect-datastar/datastar/Expr.ts"

const urlSignals = (ns: string) =>
  Signals.from(
    Schema.Struct({
      _url: Schema.String,
      _nav: Schema.String,
      _typing: Schema.Boolean,
      _pushed: Schema.Boolean
    }),
    ns
  )

/** The local signals the effect uses, with their initial values. `url` is the page's canonical URL. */
export const initial = (url: string) => ({ _url: url, _nav: "replace", _typing: false, _pushed: false })

/** Effect for the table's section: keeps the address bar in step with `_url`. */
export const effect = (ns: string): Action => {
  const $ = urlSignals(ns)
  const here = raw<string>("location.pathname + location.search")
  const replace = Action.raw(`history.replaceState(history.state, '', ${$._url.toExpr()})`)
  const push = Action.seq(
    Action.raw(`history.pushState(null, '', ${$._url.toExpr()})`),
    $._pushed.set($._typing)
  )
  return Action.seq(
    Action.when(
      $._url.isNotNull().and($._url.neq("")).and($._url.neq(here)),
      Action.raw(
        `if (${$._nav.eq("replace").or($._typing.and($._pushed)).toExpr()}) { ${replace.toExpr()} } else { ${push.toExpr()} }`
      )
    ),
    $._nav.set("push")
  )
}

/** Handler for `window` `popstate`: clears typing flags and restores the query from the URL. */
export const popstate = (ns: string, restore: ActionLike | string): Action => {
  const $ = urlSignals(ns)
  return Action.seq($._typing.set(false), $._pushed.set(false), restore)
}

/** For a text filter: typing replaces the entry its first change pushed, until the field loses focus. */
export const typing = (ns: string): { readonly input: Action; readonly blur: Action } => {
  const $ = urlSignals(ns)
  return {
    input: $._typing.set(true),
    blur: Action.seq($._typing.set(false), $._pushed.set(false))
  }
}
