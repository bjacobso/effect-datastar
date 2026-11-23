/**
 * Form styles and controls, from `@dw/ui` (document-workflow-service/packages/ui/src/form.tsx).
 *
 * Adapted: only the parts this app uses. The CRUD form is server-rendered and driven by
 * Datastar, so `crud/components.tsx` builds its fields from these styles with plain
 * elements; the ui-sdk controls here are for React islands, or (TextArea) rendered on the
 * server, where Datastar binds the plain `<textarea>` it renders.
 *
 * Also adapted:
 *   - TextArea: unchanged, except that `autoResize` is left to CSS (`field-sizing: content`,
 *     in `textarea`): server-rendered, it has no script to measure itself.
 *   - The switch styles (`switch`) are for a native `<input type="checkbox" role="switch">`
 *     (the CRUD form binds it with Datastar, no island): the thumb is a background image
 *     that slides on `:checked`, instead of ui-sdk Switch's `SwitchThumb` part.
 *   - New: `chips`, `chip`, `chipRemove`, `chipsInput` and `swatch` for MultiComboField.
 */
import * as stylex from "@stylexjs/stylex"
import { Input } from "@ui-sdk/react/input"
import { Textarea } from "@ui-sdk/react/textarea"
import type { ComponentProps } from "react"
import { color, font, motion, radius, shadow, space } from "./theme/tokens.stylex.ts"
import { shared } from "./shared.ts"

export interface Option {
  readonly value: string
  readonly label: string
}

/** ui-sdk Input with the control box. */
export function TextInput({
  xstyle,
  ...props
}: ComponentProps<typeof Input> & { xstyle?: stylex.StyleXStyles }) {
  return <Input {...props} {...stylex.props(shared.control, xstyle)} />
}

/** ui-sdk Textarea with the control box; grows with its text. */
export function TextArea({
  xstyle,
  ...props
}: ComponentProps<typeof Textarea> & { xstyle?: stylex.StyleXStyles }) {
  return <Textarea {...props} {...stylex.props(shared.control, styles.textarea, xstyle)} />
}

const popIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-4px) scale(0.98)" },
  to: { opacity: 1, transform: "none" }
})

/** Shared with the pickers in form-pickers.tsx and the server-rendered fields. */
export const styles = stylex.create({
  field: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 },
  label: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "6px",
    fontSize: font["--dw-text-md"],
    fontWeight: font["--dw-weight-medium"],
    color: { default: color["--dw-text"], "[data-invalid]": color["--dw-danger"] }
  },
  tag: {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    height: "18px",
    paddingInline: "6px",
    borderRadius: radius["--dw-radius-full"],
    backgroundColor: color["--dw-neutral-soft"],
    color: color["--dw-text-muted"],
    fontSize: "11px",
    fontWeight: font["--dw-weight-medium"]
  },
  requiredTag: { backgroundColor: color["--dw-accent-soft"], color: color["--dw-accent-text"] },
  hint: {
    display: "block",
    fontSize: font["--dw-text-sm"],
    color: color["--dw-text-muted"],
    fontWeight: 400
  },
  error: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: font["--dw-text-sm"],
    fontWeight: font["--dw-weight-medium"],
    color: color["--dw-danger"]
  },
  textarea: { minHeight: "84px", maxHeight: "320px", resize: "vertical", fieldSizing: "content" },
  check: {
    display: "flex",
    alignItems: "flex-start",
    gap: space["--dw-space-3"],
    cursor: { default: "pointer", ":has(:disabled)": "not-allowed" },
    opacity: { default: 1, ":has(:disabled)": 0.6 }
  },
  checkText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  checkbox: {
    appearance: "none",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: "18px",
    height: "18px",
    margin: 0,
    marginTop: "1px",
    padding: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: color["--dw-border-strong"], ":checked": color["--dw-accent"] },
    borderRadius: "5px",
    backgroundColor: { default: color["--dw-surface"], ":checked": color["--dw-accent"] },
    // A check mark drawn with the on-accent color, shown when checked.
    backgroundImage: {
      default: "none",
      ":checked":
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E\")"
    },
    backgroundSize: "12px",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    cursor: "pointer",
    transitionProperty: "background-color, border-color",
    transitionDuration: motion["--dw-duration-fast"]
  },
  trigger: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["--dw-space-2"],
    textAlign: "start",
    cursor: "pointer"
  },
  triggerValue: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: { default: "inherit", "[data-placeholder]": color["--dw-text-subtle"] }
  },
  triggerIcon: { color: color["--dw-text-subtle"] },
  popup: {
    margin: 0,
    padding: space["--dw-space-1"],
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color["--dw-border"],
    borderRadius: radius["--dw-radius-md"],
    backgroundColor: color["--dw-surface-raised"],
    color: color["--dw-text"],
    boxShadow: shadow["--dw-shadow-lg"],
    animationName: popIn,
    animationDuration: motion["--dw-duration-fast"],
    animationTimingFunction: motion["--dw-ease-out"],
    opacity: { default: 1, "[data-ending-style]": 0 },
    transitionProperty: "opacity",
    transitionDuration: motion["--dw-duration-fast"]
  },
  listPopup: {
    minWidth: "var(--anchor-width)",
    maxHeight: "min(320px, var(--available-height))",
    overflowY: "auto"
  },
  option: {
    display: "flex",
    alignItems: "center",
    gap: space["--dw-space-2"],
    minHeight: "32px",
    paddingInline: space["--dw-space-2"],
    borderRadius: radius["--dw-radius-sm"],
    fontSize: font["--dw-text-md"],
    cursor: "pointer",
    outline: "none",
    backgroundColor: { default: "transparent", "[data-highlighted]": color["--dw-neutral-soft"] },
    color: { default: color["--dw-text"], "[data-disabled]": color["--dw-text-subtle"] }
  },
  optionText: { flexGrow: 1, minWidth: 0 },
  optionMuted: { color: color["--dw-text-muted"] },
  optionCheck: { color: color["--dw-accent-text"] },
  empty: {
    display: "block",
    padding: { default: space["--dw-space-2"], ":empty": 0 },
    color: color["--dw-text-muted"]
  },
  inputWithButton: { position: "relative", display: "flex", alignItems: "center", width: "100%" },
  comboInput: { paddingInlineEnd: "40px" },
  inlineButton: {
    position: "absolute",
    insetInlineEnd: "4px",
    display: "grid",
    placeItems: "center",
    width: "28px",
    height: "28px",
    padding: 0,
    borderWidth: 0,
    borderRadius: radius["--dw-radius-sm"],
    backgroundColor: { default: "transparent", ":hover": color["--dw-neutral-soft"] },
    color: color["--dw-text-muted"],
    cursor: "pointer"
  },
  calendar: { padding: space["--dw-space-3"], width: "max-content" },
  calendarHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["--dw-space-2"],
    marginBottom: space["--dw-space-2"]
  },
  calendarHeading: { fontWeight: font["--dw-weight-semibold"], fontSize: font["--dw-text-md"] },
  calendarNav: {
    display: "grid",
    placeItems: "center",
    width: "28px",
    height: "28px",
    padding: 0,
    borderWidth: 0,
    borderRadius: radius["--dw-radius-sm"],
    backgroundColor: { default: "transparent", ":hover": color["--dw-neutral-soft"] },
    color: { default: color["--dw-text-muted"], "[data-disabled]": color["--dw-border-strong"] },
    cursor: "pointer"
  },
  calendarGrid: { borderCollapse: "collapse" },
  weekday: {
    width: "36px",
    height: "28px",
    fontSize: font["--dw-text-xs"],
    fontWeight: font["--dw-weight-medium"],
    color: color["--dw-text-subtle"]
  },
  day: {
    width: "36px",
    height: "34px",
    padding: 0,
    borderWidth: 0,
    borderRadius: radius["--dw-radius-sm"],
    fontSize: font["--dw-text-sm"],
    fontVariantNumeric: "tabular-nums",
    cursor: { default: "pointer", "[data-disabled]": "not-allowed" },
    backgroundColor: {
      default: "transparent",
      ":hover": color["--dw-neutral-soft"],
      "[data-selected]": color["--dw-accent"]
    },
    color: {
      default: color["--dw-text"],
      "[data-outside]": color["--dw-text-subtle"],
      "[data-disabled]": color["--dw-border-strong"],
      "[data-today]": color["--dw-accent-text"],
      "[data-selected]": color["--dw-on-accent"]
    },
    fontWeight: { default: 400, "[data-today]": font["--dw-weight-semibold"] }
  },
  // MultiComboField: the chips and the input share the control box.
  chips: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "4px",
    paddingBlock: "4px",
    paddingInlineStart: "6px",
    paddingInlineEnd: "40px",
    cursor: "text",
    borderColor: {
      default: color["--dw-border-strong"],
      ":hover": color["--dw-text-subtle"],
      ":focus-within": color["--dw-accent"],
      "[data-invalid]": color["--dw-danger"]
    },
    boxShadow: { default: "none", ":focus-within": `0 0 0 3px ${color["--dw-focus-ring"]}` }
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
    height: "24px",
    paddingInlineStart: "8px",
    paddingInlineEnd: "2px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color["--dw-border"],
    borderRadius: radius["--dw-radius-full"],
    backgroundColor: color["--dw-neutral-soft"],
    color: color["--dw-text"],
    fontSize: font["--dw-text-sm"],
    fontWeight: font["--dw-weight-medium"],
    outline: { default: "none", "[data-highlighted]": `2px solid ${color["--dw-accent"]}` }
  },
  chipRemove: {
    display: "grid",
    placeItems: "center",
    width: "18px",
    height: "18px",
    padding: 0,
    borderWidth: 0,
    borderRadius: radius["--dw-radius-full"],
    backgroundColor: { default: "transparent", ":hover": color["--dw-neutral-soft"] },
    color: color["--dw-text-muted"],
    cursor: "pointer"
  },
  chipsInput: {
    flexGrow: 1,
    minWidth: "80px",
    minHeight: "26px",
    padding: 0,
    paddingInlineStart: "4px",
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit"
  },
  swatch: {
    flexShrink: 0,
    width: "10px",
    height: "10px",
    borderRadius: radius["--dw-radius-full"]
  },
  // A native checkbox drawn as ui-sdk Switch: track, plus a white thumb that slides when checked.
  switchRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["--dw-space-4"],
    cursor: "pointer"
  },
  switch: {
    appearance: "none",
    flexShrink: 0,
    width: "36px",
    height: "20px",
    margin: 0,
    borderWidth: 0,
    borderRadius: radius["--dw-radius-full"],
    backgroundColor: { default: color["--dw-border-strong"], ":checked": color["--dw-accent"] },
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='8' fill='white'/%3E%3C/svg%3E\")",
    backgroundRepeat: "no-repeat",
    backgroundSize: "16px 16px",
    backgroundPosition: { default: "2px center", ":checked": "18px center" },
    boxShadow: "inset 0 1px 2px rgb(0 0 0 / 0.12)",
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.55 },
    transitionProperty: "background-color, background-position",
    transitionDuration: motion["--dw-duration-normal"],
    transitionTimingFunction: motion["--dw-ease-out"]
  }
})
