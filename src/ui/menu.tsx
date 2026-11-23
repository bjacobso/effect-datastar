// From `@dw/ui` (packages/ui/src/menu.tsx); only `destructive` is defaulted for this repo's
// `exactOptionalPropertyTypes`. Used by the theme menu island.
import * as stylex from "@stylexjs/stylex"
import { Menu, MenuContent, MenuItem, MenuItemIcon, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu"
import { color, font, motion, radius, shadow, size, space } from "./theme/tokens.stylex.ts"
import { Icon } from "./icons.tsx"
import type { IconName } from "./icons.tsx"
import { shared } from "./shared.ts"

export interface MenuAction {
  readonly value: string
  readonly label: string
  readonly icon?: IconName
  readonly destructive?: boolean
  readonly separatorBefore?: boolean
  readonly onSelect: () => unknown
}

/** ui-sdk Menu behind a "more" button: arrow keys, typeahead, Escape and focus return built in. */
export function ActionMenu({
  label,
  actions,
  text,
}: {
  label: string
  actions: ReadonlyArray<MenuAction>
  text?: string
}) {
  if (!actions.length) return null
  return (
    <Menu onAction={(value) => actions.find((action) => action.value === value)?.onSelect()}>
      <MenuTrigger
        aria-label={text ? undefined : label}
        title={text ? undefined : label}
        {...stylex.props(text ? menuStyles.textTrigger : menuStyles.iconTrigger, shared.focusRing)}
      >
        {text}
        <Icon name={text ? "chevronDown" : "more"} />
      </MenuTrigger>
      <MenuContent align="end" sideOffset={6} {...stylex.props(menuStyles.content)}>
        {actions.flatMap((action) => [
          ...(action.separatorBefore
            ? [<MenuSeparator key={`${action.value}-sep`} {...stylex.props(menuStyles.separator)} />]
            : []),
          <MenuItem
            key={action.value}
            value={action.value}
            destructive={action.destructive ?? false}
            {...stylex.props(menuStyles.item)}
          >
            {action.icon && (
              <MenuItemIcon {...stylex.props(menuStyles.itemIcon)}>
                <Icon name={action.icon} />
              </MenuItemIcon>
            )}
            {action.label}
          </MenuItem>,
        ])}
      </MenuContent>
    </Menu>
  )
}

const popIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-4px) scale(0.98)" },
  to: { opacity: 1, transform: "none" },
})

/** Menu parts, shared with menus built directly on ui-sdk (the console account menu). */
export const menuStyles = stylex.create({
  iconTrigger: {
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
      ":hover": color["--dw-neutral-soft"],
      "[data-open]": color["--dw-neutral-soft"],
    },
    color: { default: color["--dw-text-muted"], ":hover": color["--dw-text"] },
    cursor: "pointer",
  },
  textTrigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    height: size["--dw-control-sm"],
    paddingInline: "10px",
    borderWidth: 0,
    borderRadius: radius["--dw-radius-md"],
    backgroundColor: {
      default: "transparent",
      ":hover": color["--dw-neutral-soft"],
      "[data-open]": color["--dw-neutral-soft"],
    },
    color: { default: color["--dw-text-muted"], ":hover": color["--dw-text"] },
    fontSize: font["--dw-text-sm"],
    fontWeight: font["--dw-weight-medium"],
    cursor: "pointer",
  },
  content: {
    margin: 0,
    minWidth: "200px",
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
    transitionDuration: motion["--dw-duration-fast"],
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space["--dw-space-2"],
    minHeight: "32px",
    paddingInline: space["--dw-space-2"],
    borderRadius: radius["--dw-radius-sm"],
    fontSize: font["--dw-text-md"],
    cursor: "pointer",
    outline: "none",
    whiteSpace: "nowrap",
    textDecoration: "none",
    backgroundColor: {
      default: "transparent",
      "[data-highlighted]": color["--dw-neutral-soft"],
      "[data-destructive][data-highlighted]": color["--dw-danger-soft"],
    },
    color: {
      default: color["--dw-text"],
      "[data-destructive]": color["--dw-danger"],
      "[data-disabled]": color["--dw-text-subtle"],
    },
  },
  itemIcon: { display: "grid", placeItems: "center", color: "inherit", opacity: 0.8 },
  separator: {
    height: "1px",
    marginBlock: space["--dw-space-1"],
    marginInline: `calc(-1 * ${space["--dw-space-1"]})`,
    backgroundColor: color["--dw-border"],
  },
  groupLabel: {
    paddingInline: space["--dw-space-2"],
    paddingBlock: "6px",
    fontSize: font["--dw-text-xs"],
    fontWeight: font["--dw-weight-medium"],
    color: color["--dw-text-subtle"],
  },
  indicator: { marginInlineStart: "auto", color: color["--dw-accent-text"] },
})
