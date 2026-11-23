/**
 * The islands this app uses, one module each, so the browser loads only the ones a
 * page has (see `loaders.ts`). The server imports them from here for placeholders.
 */
import type * as Island from "./Island.tsx"
import { DateInput } from "./date.tsx"
import { Dialog } from "./dialog.tsx"
import { MultiSelect } from "./multiselect.tsx"
import { Select } from "./select.tsx"
import { Theme } from "./theme.tsx"

export { DateInput, type DateInputProps } from "./date.tsx"
export { Dialog, type DialogProps } from "./dialog.tsx"
export { MultiSelect, type MultiSelectProps, MultiSelectValue } from "./multiselect.tsx"
export { Select, type SelectProps } from "./select.tsx"
export { Theme } from "./theme.tsx"

/** Every island. `loaders.ts` must have a loader for each name (checked in a test). */
export const all: ReadonlyArray<Island.Island<never>> = [Select, Dialog, Theme, DateInput, MultiSelect]
