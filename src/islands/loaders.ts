/**
 * Browser only: each island's code, by name, as a dynamic import. esbuild splits every
 * one into its own chunk (shared code, React included, goes into common chunks), so a
 * page downloads only the islands it renders.
 */
import type { Island } from "./Island.tsx"

export const loaders: Readonly<Record<string, () => Promise<Island<never>>>> = {
  select: () => import("./select.tsx").then((m) => m.Select as Island<never>),
  dialog: () => import("./dialog.tsx").then((m) => m.Dialog as Island<never>),
  theme: () => import("./theme.tsx").then((m) => m.Theme as Island<never>)
}
