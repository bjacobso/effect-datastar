/**
 * Form styles and controls, from `@dw/ui` (document-workflow-service/packages/ui/src/form.tsx).
 *
 * Adapted: only the parts this app uses. The CRUD form is server-rendered and driven by
 * Datastar, so `crud/components.tsx` builds its fields from these styles with plain
 * elements; the ui-sdk controls here are for React islands.
 */
import * as stylex from "@stylexjs/stylex"
import { Input } from "@ui-sdk/react/input"
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
  textarea: { minHeight: "84px", resize: "vertical" },
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
})
