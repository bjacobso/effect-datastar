/**
 * ui-sdk Dialog, from `@dw/ui` (packages/ui/src/overlay.tsx).
 *
 * Adapted for islands: `keepMounted` (the content stays in the page while closed, hidden,
 * so server-rendered content inside it keeps its state and stays a patch target), and the
 * title can live in that content (`labelledBy`) instead of being a React prop.
 */
import * as stylex from "@stylexjs/stylex"
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle
} from "@ui-sdk/react/dialog"
import type { ReactNode } from "react"
import { Icon } from "./icons.tsx"
import { shared } from "./shared.ts"
import { color, font, motion, radius, shadow, size, space } from "./theme/tokens.stylex.ts"

/** ui-sdk Dialog, controlled by the caller. Escape, the backdrop and the X all call `onClose`. */
export function Modal({
  open,
  title,
  labelledBy,
  description,
  onClose,
  keepMounted,
  children
}: {
  open: boolean
  /** A heading rendered by the dialog, or... */
  title?: string | undefined
  /** ...the id of a heading inside `children`. */
  labelledBy?: string | undefined
  description?: ReactNode
  onClose: () => void
  keepMounted?: boolean
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogBackdrop {...stylex.props(styles.backdrop)} />
      <DialogContent
        keepMounted={keepMounted ?? false}
        {...(labelledBy ? { "aria-labelledby": labelledBy } : {})}
        {...stylex.props(styles.dialog)}
      >
        <DialogClose aria-label="Close" {...stylex.props(styles.close, shared.focusRing)}>
          <Icon name="x" />
        </DialogClose>
        {title !== undefined && <DialogTitle {...stylex.props(styles.dialogTitle)}>{title}</DialogTitle>}
        {description && <DialogDescription {...stylex.props(styles.dialogDescription)}>{description}</DialogDescription>}
        {children}
      </DialogContent>
    </Dialog>
  )
}

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } })
const rise = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(8px) scale(0.98)" },
  to: { opacity: 1, transform: "none" }
})

export const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    backgroundColor: color["--dw-backdrop"],
    animationName: fadeIn,
    animationDuration: motion["--dw-duration-normal"],
    opacity: { default: 1, "[data-ending-style]": 0 },
    transitionProperty: "opacity",
    transitionDuration: motion["--dw-duration-fast"]
  },
  dialog: {
    position: "fixed",
    inset: 0,
    margin: "auto",
    width: "min(520px, calc(100vw - 32px))",
    height: "fit-content",
    maxHeight: "calc(100dvh - 32px)",
    overflowY: "auto",
    padding: space["--dw-space-6"],
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color["--dw-border"],
    borderRadius: radius["--dw-radius-lg"],
    backgroundColor: color["--dw-surface-raised"],
    color: color["--dw-text"],
    boxShadow: shadow["--dw-shadow-lg"],
    display: "flex",
    flexDirection: "column",
    gap: space["--dw-space-4"],
    animationName: rise,
    animationDuration: motion["--dw-duration-normal"],
    animationTimingFunction: motion["--dw-ease-out"],
    opacity: { default: 1, "[data-ending-style]": 0 },
    transform: { default: "none", "[data-ending-style]": "scale(0.98)" },
    transitionProperty: "opacity, transform",
    transitionDuration: motion["--dw-duration-fast"],
    outline: "none"
  },
  /** For a title rendered inside the dialog's children (see `labelledBy`). */
  dialogTitle: {
    fontSize: font["--dw-text-lg"],
    fontWeight: font["--dw-weight-semibold"],
    lineHeight: font["--dw-leading-tight"],
    paddingTop: "4px",
    paddingInlineEnd: size["--dw-control-sm"]
  },
  dialogDescription: { color: color["--dw-text-muted"] },
  close: {
    position: "absolute",
    top: space["--dw-space-5"],
    insetInlineEnd: space["--dw-space-5"],
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: size["--dw-control-sm"],
    height: size["--dw-control-sm"],
    padding: 0,
    borderWidth: 0,
    borderRadius: radius["--dw-radius-md"],
    backgroundColor: {
      default: "transparent",
      ":hover": color["--dw-neutral-soft"]
    },
    color: { default: color["--dw-text-muted"], ":hover": color["--dw-text"] },
    cursor: "pointer"
  }
})
