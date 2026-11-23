/**
 * The islands this app uses, one module each. The server imports them from here (to
 * render placeholders); the browser bundle loads each module only when a page has a host
 * with its name (`loaders` in `registry.ts`), so a page without a date field never
 * downloads the calendar.
 */
export { DateInput, type DateInputProps } from "./date.tsx"
export { Dialog, type DialogProps } from "./dialog.tsx"
export { MultiSelect, type MultiSelectProps, MultiSelectValue } from "./multiselect.tsx"
export { Select, type SelectProps } from "./select.tsx"
export { Theme } from "./theme.tsx"
