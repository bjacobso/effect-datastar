// From `@dw/ui` (packages/ui/src/Button.tsx); only `disabled` is coerced for this repo's
// `exactOptionalPropertyTypes`. ui-sdk Button renders a native
// <button> on the server too, so server-rendered pages use it without hydrating it.
import * as stylex from "@stylexjs/stylex"
import { Button as ButtonPart } from "@ui-sdk/react/button"
import type { ComponentProps, ReactNode } from "react"
import { color, font, motion, radius, shadow, size, space } from "./theme/tokens.stylex.ts"
import { Icon } from "./icons.tsx"
import type { IconName } from "./icons.tsx"
import { shared } from "./shared.ts"

type ButtonProps = Omit<ComponentProps<typeof ButtonPart>, "className" | "style" | "children"> & {
  children?: ReactNode
  variant?: "primary" | "secondary" | "ghost" | "danger"
  size?: "sm" | "md"
  icon?: IconName
  /** Shows a spinner and blocks presses while work started elsewhere runs. */
  busy?: boolean
  block?: boolean
  xstyle?: stylex.StyleXStyles
}

/**
 * ui-sdk Button: a native button with a pending state. Returning a Promise from `onClick` marks it
 * pending (`data-pending`) on its own; `busy` covers work the caller tracks itself.
 */
export function Button({
  variant = "secondary",
  size: buttonSize = "md",
  icon,
  busy,
  block,
  children,
  disabled,
  xstyle,
  ...props
}: ButtonProps) {
  return (
    <ButtonPart
      {...props}
      disabled={Boolean(disabled || busy)}
      aria-busy={busy || undefined}
      data-busy={busy ? "" : undefined}
      {...stylex.props(
        stylex.defaultMarker(),
        styles.base,
        shared.focusRing,
        styles[variant],
        buttonSize === "sm" && styles.sm,
        block && styles.block,
        xstyle,
      )}
    >
      {icon && <Icon name={icon} size={buttonSize === "sm" ? 14 : 16} {...stylex.props(styles.idle)} />}
      <Spinner xstyle={styles.pendingOnly} />
      {children}
    </ButtonPart>
  )
}

/** A square icon-only button. `label` is its accessible name. */
export function IconButton({
  icon,
  label,
  xstyle,
  ...props
}: Omit<ButtonProps, "children" | "icon" | "variant"> & { icon: IconName; label: string }) {
  return (
    <ButtonPart
      {...props}
      aria-label={label}
      title={label}
      {...stylex.props(styles.base, shared.focusRing, styles.ghost, styles.iconOnly, xstyle)}
    >
      <Icon name={icon} />
    </ButtonPart>
  )
}

export function Spinner({ label, xstyle }: { label?: string; xstyle?: stylex.StyleXStyles }) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...stylex.props(styles.spinner, xstyle)}
    />
  )
}

const spin = stylex.keyframes({ to: { transform: "rotate(360deg)" } })

const styles = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space["--dw-space-2"],
    flexShrink: 0,
    height: size["--dw-control-md"],
    paddingInline: "14px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radius["--dw-radius-md"],
    fontFamily: "inherit",
    fontSize: font["--dw-text-md"],
    fontWeight: font["--dw-weight-medium"],
    lineHeight: 1,
    whiteSpace: "nowrap",
    textDecoration: "none",
    cursor: { default: "pointer", ":disabled": "not-allowed", "[data-pending]": "progress" },
    opacity: { default: 1, ":disabled": 0.55, "[data-busy]": 1, "[data-pending]": 1 },
    userSelect: "none",
    transitionProperty: "background-color, border-color, color, box-shadow",
    transitionDuration: motion["--dw-duration-fast"],
  },
  primary: {
    backgroundColor: {
      default: color["--dw-accent"],
      ":hover": color["--dw-accent-hover"],
    },
    color: color["--dw-on-accent"],
    boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.12), 0 1px 2px rgb(16 16 24 / 0.12)",
  },
  secondary: {
    backgroundColor: {
      default: color["--dw-surface"],
      ":hover": color["--dw-surface-muted"],
    },
    borderColor: { default: color["--dw-border-strong"], ":hover": color["--dw-text-subtle"] },
    color: color["--dw-text"],
    boxShadow: shadow["--dw-shadow-sm"],
  },
  ghost: {
    backgroundColor: { default: "transparent", ":hover": color["--dw-neutral-soft"] },
    color: { default: color["--dw-text-muted"], ":hover": color["--dw-text"] },
  },
  danger: {
    backgroundColor: { default: color["--dw-danger"], ":hover": color["--dw-danger-hover"] },
    color: color["--dw-on-danger"],
  },
  sm: {
    height: size["--dw-control-sm"],
    paddingInline: "10px",
    fontSize: font["--dw-text-sm"],
    gap: "6px",
  },
  block: { width: "100%" },
  iconOnly: { width: size["--dw-control-sm"], height: size["--dw-control-sm"], paddingInline: 0 },
  idle: {
    display: {
      default: "block",
      [stylex.when.ancestor("[data-busy]")]: "none",
      [stylex.when.ancestor("[data-pending]")]: "none",
    },
  },
  pendingOnly: {
    display: {
      default: "none",
      [stylex.when.ancestor("[data-busy]")]: "inline-block",
      [stylex.when.ancestor("[data-pending]")]: "inline-block",
    },
  },
  spinner: {
    display: "inline-block",
    width: "14px",
    height: "14px",
    flexShrink: 0,
    borderRadius: radius["--dw-radius-full"],
    borderWidth: "2px",
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRightColor: "transparent",
    opacity: 0.8,
    animationName: spin,
    animationDuration: "0.7s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
})
