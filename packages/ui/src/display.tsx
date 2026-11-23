/**
 * Display pieces from `@dw/ui` (packages/ui/src/display.tsx), unchanged except for the
 * dropped `ProblemAlert` (this app reports errors as field errors and toasts).
 */
import * as stylex from "@stylexjs/stylex"
import { useId } from "react"
import type { ReactNode } from "react"
import { color, font, radius, shadow, space } from "./theme/tokens.stylex.ts"
import { IconButton } from "./Button.tsx"
import { Icon } from "./icons.tsx"
import type { IconName } from "./icons.tsx"

/** The color families a status badge, alert or timeline marker can take. */
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "violet"

export const toneStyles = stylex.create({
  neutral: { backgroundColor: color["--dw-neutral-soft"], color: color["--dw-text-muted"] },
  accent: { backgroundColor: color["--dw-accent-soft"], color: color["--dw-accent-text"] },
  success: { backgroundColor: color["--dw-success-soft"], color: color["--dw-success"] },
  warning: { backgroundColor: color["--dw-warning-soft"], color: color["--dw-warning"] },
  danger: { backgroundColor: color["--dw-danger-soft"], color: color["--dw-danger"] },
  violet: { backgroundColor: color["--dw-violet-soft"], color: color["--dw-violet"] },
})

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span {...stylex.props(styles.badge, toneStyles[tone])}>
      <span aria-hidden="true" {...stylex.props(styles.badgeDot)} />
      {children}
    </span>
  )
}

export function Card({
  title,
  description,
  actions,
  children,
  flush,
  as: Tag = "section",
  headingLevel = 2,
  xstyle,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  flush?: boolean
  as?: "section" | "div"
  headingLevel?: 2 | 3
  xstyle?: stylex.StyleXStyles
}) {
  const id = useId()
  const Heading = headingLevel === 3 ? "h3" : "h2"
  return (
    <Tag {...stylex.props(styles.card, xstyle)} aria-labelledby={title && Tag === "section" ? id : undefined}>
      {(title || actions) && (
        <header {...stylex.props(styles.cardHeader)}>
          <div {...stylex.props(styles.cardHeading)}>
            {title && (
              <Heading id={id} {...stylex.props(styles.cardTitle)}>
                {title}
              </Heading>
            )}
            {description && <p {...stylex.props(styles.cardDescription)}>{description}</p>}
          </div>
          {actions && <div {...stylex.props(styles.cardActions)}>{actions}</div>}
        </header>
      )}
      <div {...stylex.props(flush ? styles.cardBodyFlush : styles.cardBody)}>{children}</div>
    </Tag>
  )
}

const alertTone = {
  danger: "danger",
  success: "success",
  warning: "warning",
  info: "accent",
} as const

export function Alert({
  tone = "danger",
  title,
  children,
  onDismiss,
}: {
  tone?: "danger" | "success" | "warning" | "info"
  title?: ReactNode
  children?: ReactNode
  onDismiss?: () => void
}) {
  const icon: IconName = tone === "success" ? "check" : tone === "info" ? "sparkle" : "alert"
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      {...stylex.props(styles.alert, toneStyles[alertTone[tone]], styles[`alert_${tone}`])}
    >
      <Icon name={icon} size={18} {...stylex.props(styles.alertIcon)} />
      <div {...stylex.props(styles.alertBody)}>
        {title && <strong {...stylex.props(styles.alertTitle)}>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {onDismiss && <IconButton icon="x" label="Dismiss" onClick={onDismiss} xstyle={styles.alertDismiss} />}
    </div>
  )
}

export function EmptyState({
  icon = "inbox",
  title,
  children,
  action,
}: {
  icon?: IconName
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div {...stylex.props(styles.empty)}>
      <span {...stylex.props(styles.emptyIcon)}>
        <Icon name={icon} size={22} />
      </span>
      <h3 {...stylex.props(styles.emptyTitle)}>{title}</h3>
      {children && <p {...stylex.props(styles.emptyText)}>{children}</p>}
      {action}
    </div>
  )
}

const widths = ["90%", "73%", "56%", "39%", "22%", "15%"] as const

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div role="status" aria-label="Loading" {...stylex.props(styles.skeleton)}>
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          {...stylex.props(styles.skeletonLine, styles.width(widths[index % widths.length]!))}
        />
      ))}
    </div>
  )
}

export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
}: {
  title: ReactNode
  eyebrow?: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header {...stylex.props(styles.pageHeader)}>
      <div {...stylex.props(styles.pageHeading)}>
        {eyebrow && <div>{eyebrow}</div>}
        <h1 {...stylex.props(styles.pageTitle)}>{title}</h1>
        {description && <div {...stylex.props(styles.pageDescription)}>{description}</div>}
      </div>
      {actions && <div {...stylex.props(styles.pageActions)}>{actions}</div>}
    </header>
  )
}

export function DescriptionList({
  items,
  variant = "side",
}: {
  items: ReadonlyArray<readonly [ReactNode, ReactNode]>
  variant?: "side" | "review" | "nested"
}) {
  return (
    <dl {...stylex.props(styles.dl, variant === "nested" && styles.dlNested)}>
      {items.map(([term, value], index) => (
        <div
          key={index}
          {...stylex.props(
            styles.dlRow,
            variant === "review" && styles.dlRowReview,
            variant === "nested" && styles.dlRowNested,
          )}
        >
          <dt {...stylex.props(styles.dt)}>{term}</dt>
          <dd {...stylex.props(styles.dd)}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A small rounded label, for IDs and references. */
export function Chip({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return <span {...stylex.props(styles.chip, mono && styles.chipMono)}>{children}</span>
}

const shimmer = stylex.keyframes({
  "0%": { opacity: 0.55 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.55 },
})

const MOBILE = "@media (max-width: 640px)"

const styles = stylex.create({
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    height: "22px",
    paddingInline: "8px",
    borderRadius: radius["--dw-radius-full"],
    fontSize: font["--dw-text-xs"],
    fontWeight: font["--dw-weight-medium"],
    whiteSpace: "nowrap",
  },
  badgeDot: {
    width: "6px",
    height: "6px",
    borderRadius: radius["--dw-radius-full"],
    backgroundColor: "currentColor",
  },
  card: {
    backgroundColor: color["--dw-surface"],
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color["--dw-border"],
    borderRadius: radius["--dw-radius-lg"],
    boxShadow: shadow["--dw-shadow-md"],
    minWidth: 0,
  },
  cardHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space["--dw-space-3"],
    paddingTop: space["--dw-space-5"],
    paddingInline: space["--dw-space-5"],
  },
  cardHeading: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  cardTitle: {
    fontSize: font["--dw-text-md"],
    fontWeight: font["--dw-weight-semibold"],
    lineHeight: font["--dw-leading-tight"],
    letterSpacing: "-0.006em",
  },
  cardDescription: { fontSize: font["--dw-text-sm"], color: color["--dw-text-muted"] },
  cardActions: { display: "flex", gap: space["--dw-space-2"], flexShrink: 0 },
  cardBody: {
    padding: space["--dw-space-5"],
    display: "flex",
    flexDirection: "column",
    gap: space["--dw-space-4"],
  },
  cardBodyFlush: { paddingBlock: space["--dw-space-3"], paddingInline: space["--dw-space-5"] },
  alert: {
    display: "flex",
    alignItems: "flex-start",
    gap: space["--dw-space-3"],
    paddingBlock: space["--dw-space-3"],
    paddingInline: space["--dw-space-4"],
    borderRadius: radius["--dw-radius-md"],
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "color-mix(in srgb, currentColor 22%, transparent)",
    fontSize: font["--dw-text-sm"],
  },
  alert_danger: {},
  alert_success: {},
  alert_warning: {},
  alert_info: {},
  alertIcon: { marginTop: "1px" },
  alertBody: {
    flexGrow: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    color: color["--dw-text"],
  },
  alertTitle: { fontWeight: font["--dw-weight-semibold"] },
  alertDismiss: { marginBlock: "-5px", marginInlineEnd: "-8px" },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: space["--dw-space-2"],
    paddingBlock: space["--dw-space-10"],
    paddingInline: space["--dw-space-6"],
  },
  emptyIcon: {
    display: "grid",
    placeItems: "center",
    width: "44px",
    height: "44px",
    marginBottom: space["--dw-space-1"],
    borderRadius: radius["--dw-radius-lg"],
    backgroundColor: color["--dw-neutral-soft"],
    color: color["--dw-text-muted"],
  },
  emptyTitle: { fontSize: font["--dw-text-lg"], fontWeight: font["--dw-weight-semibold"] },
  emptyText: { color: color["--dw-text-muted"], maxWidth: "42ch" },
  skeleton: { display: "flex", flexDirection: "column", gap: space["--dw-space-3"] },
  skeletonLine: {
    display: "block",
    height: "12px",
    borderRadius: radius["--dw-radius-sm"],
    backgroundColor: color["--dw-neutral-soft"],
    animationName: shimmer,
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
  },
  width: (width: string) => ({ width }),
  pageHeader: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space["--dw-space-4"],
    marginBottom: space["--dw-space-6"],
  },
  pageHeading: { display: "flex", flexDirection: "column", gap: space["--dw-space-2"], minWidth: 0 },
  pageTitle: {
    fontSize: font["--dw-text-xl"],
    fontWeight: font["--dw-weight-semibold"],
    letterSpacing: "-0.02em",
    lineHeight: font["--dw-leading-tight"],
  },
  pageDescription: { color: color["--dw-text-muted"] },
  pageActions: { display: "flex", flexWrap: "wrap", gap: space["--dw-space-2"] },
  dl: { display: "flex", flexDirection: "column", gap: space["--dw-space-3"] },
  dlNested: { gap: space["--dw-space-1"] },
  dlRow: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(96px, 2fr) 3fr", [MOBILE]: "minmax(0, 1fr)" },
    gap: { default: space["--dw-space-3"], [MOBILE]: "2px" },
    alignItems: "baseline",
  },
  dlRowReview: {
    gridTemplateColumns: { default: "minmax(160px, 1fr) 1.4fr", [MOBILE]: "minmax(0, 1fr)" },
    paddingBottom: { default: space["--dw-space-3"], ":last-child": 0 },
    borderBottomWidth: { default: "1px", ":last-child": 0 },
    borderBottomStyle: "solid",
    borderBottomColor: color["--dw-border"],
  },
  dlRowNested: { gridTemplateColumns: "minmax(80px, 1fr) 2fr", gap: space["--dw-space-2"] },
  dt: { color: color["--dw-text-muted"], fontSize: font["--dw-text-sm"] },
  dd: { minWidth: 0, overflowWrap: "anywhere" },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    height: "22px",
    paddingInline: "6px",
    borderRadius: radius["--dw-radius-sm"],
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color["--dw-border"],
    backgroundColor: color["--dw-surface"],
    color: color["--dw-text-muted"],
    fontSize: font["--dw-text-xs"],
    whiteSpace: "nowrap",
  },
  chipMono: {
    fontFamily: font["--dw-font-mono"],
    backgroundColor: color["--dw-surface-sunken"],
    borderColor: "transparent",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
})
