/**
 * Island modules by name, for the browser bundle.
 *
 * `Dialog` is in the bundle itself: the create/edit form is its server-rendered content,
 * placed when the island mounts, and live views patch the selects inside that form from
 * their first response. Were the dialog loaded on demand, such a patch could arrive before
 * the form is in the document.
 *
 * Every other island is a dynamic import, so esbuild splits it (and the ui-sdk parts only
 * it uses) into its own chunk, loaded the first time a `<ds-island name="...">` needs it:
 * a page without a date field never downloads the calendar. React and what islands share
 * go in shared chunks.
 */
import { Dialog } from "./dialog.tsx"
import type { Island } from "./Island.tsx"

export const eager: ReadonlyArray<Island<never>> = [Dialog as Island<never>]

export const loaders: Readonly<Record<string, () => Promise<Island<never>>>> = {
  select: () => import("./select.tsx").then((m) => m.Select as Island<never>),
  theme: () => import("./theme.tsx").then((m) => m.Theme as Island<never>),
  date: () => import("./date.tsx").then((m) => m.DateInput as Island<never>),
  multiselect: () => import("./multiselect.tsx").then((m) => m.MultiSelect as Island<never>)
}
