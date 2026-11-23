// From `@dw/ui` (packages/ui/src/shared.ts), unchanged.
import * as stylex from "@stylexjs/stylex"
import { color, font, motion, radius, size, space } from "./theme/tokens.stylex.ts"

/** Styles shared by several components: focus rings, the text-control box, small text. */
export const shared = stylex.create({
  focusRing: {
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: "2px",
    outlineColor: color["--dw-accent"],
    outlineOffset: "2px",
  },
  control: {
    display: "block",
    width: "100%",
    minHeight: size["--dw-control-md"],
    paddingBlock: "7px",
    paddingInline: space["--dw-space-3"],
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: {
      default: color["--dw-border-strong"],
      ":hover": color["--dw-text-subtle"],
      ":focus": color["--dw-accent"],
      "[aria-invalid=true]": color["--dw-danger"],
      "[data-invalid]": color["--dw-danger"],
      ":disabled": color["--dw-border"],
      "[data-disabled]": color["--dw-border"],
    },
    borderRadius: radius["--dw-radius-md"],
    backgroundColor: {
      default: color["--dw-surface"],
      ":disabled": color["--dw-surface-sunken"],
      "[data-disabled]": color["--dw-surface-sunken"],
      "[readonly]": color["--dw-surface-muted"],
    },
    color: {
      default: color["--dw-text"],
      ":disabled": color["--dw-text-muted"],
      "[data-disabled]": color["--dw-text-muted"],
    },
    fontSize: font["--dw-text-md"],
    lineHeight: "20px",
    outline: "none",
    boxShadow: {
      default: "none",
      ":focus": `0 0 0 3px ${color["--dw-focus-ring"]}`,
    },
    transitionProperty: "border-color, box-shadow",
    transitionDuration: motion["--dw-duration-fast"],
    "::placeholder": { color: color["--dw-text-subtle"] },
  },
  muted: { color: color["--dw-text-muted"] },
  subtle: { color: color["--dw-text-subtle"] },
  small: { fontSize: font["--dw-text-sm"] },
  xsmall: { fontSize: font["--dw-text-xs"] },
  mono: { fontFamily: font["--dw-font-mono"], fontSize: font["--dw-text-xs"] },
  stack: { display: "flex", flexDirection: "column", gap: space["--dw-space-4"] },
  stackSm: { display: "flex", flexDirection: "column", gap: space["--dw-space-2"] },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space["--dw-space-2"] },
  rowSpread: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["--dw-space-2"],
  },
  inlineIcon: { display: "inline-flex", alignItems: "center", gap: space["--dw-space-1"] },
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
})
