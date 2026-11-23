/** Shared UI feedback patches for CRUD handlers. */
import { Effect } from "effect"
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import { render } from "@effect-datastar/ui/Html.ts"
import { Toast } from "./components.tsx"

/** Replace (not morph) so the fade-out animation restarts for every toast. */
export const toast = (message: string, kind: "ok" | "error" = "ok") =>
  Datastar.patchElements(render(<Toast message={message} kind={kind} />), { selector: "#toast", mode: "replace" })

/** Log an unexpected failure and show a generic error toast. */
export const unexpected = (error: { readonly _tag: string }) =>
  Effect.logError("unexpected failure", error).pipe(
    Effect.as(toast(`Something went wrong (${error._tag})`, "error"))
  )
