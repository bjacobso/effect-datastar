// From `@dw/ui` (packages/ui/src/theme/tokens.stylex.ts), unchanged.
import * as stylex from "@stylexjs/stylex"
import { dark, light } from "./palette.stylex.ts"

// Every token is a CSS custom property with a stable `--dw-*` name (StyleX keeps keys that start
// with `--` as written), so a host page can re-skin the app with plain CSS. See docs/theming.md.

const DARK = "@media (prefers-color-scheme: dark)"
const REDUCED = "@media (prefers-reduced-motion: reduce)"

export const color = stylex.defineVars({
  "--dw-scheme": "light dark",
  "--dw-bg": { default: light.bg, [DARK]: dark.bg },
  "--dw-surface": { default: light.surface, [DARK]: dark.surface },
  "--dw-surface-raised": { default: light.surfaceRaised, [DARK]: dark.surfaceRaised },
  "--dw-surface-muted": { default: light.surfaceMuted, [DARK]: dark.surfaceMuted },
  "--dw-surface-sunken": { default: light.surfaceSunken, [DARK]: dark.surfaceSunken },
  "--dw-border": { default: light.border, [DARK]: dark.border },
  "--dw-border-strong": { default: light.borderStrong, [DARK]: dark.borderStrong },
  "--dw-text": { default: light.text, [DARK]: dark.text },
  "--dw-text-muted": { default: light.textMuted, [DARK]: dark.textMuted },
  "--dw-text-subtle": { default: light.textSubtle, [DARK]: dark.textSubtle },
  "--dw-accent": { default: light.accent, [DARK]: dark.accent },
  "--dw-accent-hover": { default: light.accentHover, [DARK]: dark.accentHover },
  "--dw-on-accent": { default: light.accentContrast, [DARK]: dark.accentContrast },
  "--dw-accent-soft": { default: light.accentSoft, [DARK]: dark.accentSoft },
  "--dw-accent-text": { default: light.accentText, [DARK]: dark.accentText },
  "--dw-success": { default: light.success, [DARK]: dark.success },
  "--dw-success-soft": { default: light.successSoft, [DARK]: dark.successSoft },
  "--dw-warning": { default: light.warning, [DARK]: dark.warning },
  "--dw-warning-soft": { default: light.warningSoft, [DARK]: dark.warningSoft },
  "--dw-danger": { default: light.danger, [DARK]: dark.danger },
  "--dw-danger-hover": { default: light.dangerHover, [DARK]: dark.dangerHover },
  "--dw-on-danger": { default: light.accentContrast, [DARK]: dark.accentContrast },
  "--dw-danger-soft": { default: light.dangerSoft, [DARK]: dark.dangerSoft },
  "--dw-violet": { default: light.violet, [DARK]: dark.violet },
  "--dw-violet-soft": { default: light.violetSoft, [DARK]: dark.violetSoft },
  "--dw-neutral-soft": { default: light.neutralSoft, [DARK]: dark.neutralSoft },
  "--dw-focus-ring": { default: light.focusRing, [DARK]: dark.focusRing },
  "--dw-backdrop": { default: light.backdrop, [DARK]: dark.backdrop },
})

export const shadow = stylex.defineVars({
  "--dw-shadow-sm": { default: light.shadowSm, [DARK]: dark.shadowSm },
  "--dw-shadow-md": { default: light.shadowMd, [DARK]: dark.shadowMd },
  "--dw-shadow-lg": { default: light.shadowLg, [DARK]: dark.shadowLg },
})

export const space = stylex.defineVars({
  "--dw-space-1": "4px",
  "--dw-space-2": "8px",
  "--dw-space-3": "12px",
  "--dw-space-4": "16px",
  "--dw-space-5": "20px",
  "--dw-space-6": "24px",
  "--dw-space-8": "32px",
  "--dw-space-10": "40px",
})

export const radius = stylex.defineVars({
  "--dw-radius-sm": "6px",
  "--dw-radius-md": "8px",
  "--dw-radius-lg": "12px",
  "--dw-radius-full": "999px",
})

export const font = stylex.defineVars({
  "--dw-font-sans":
    '"Inter Variable", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "--dw-font-mono": 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
  "--dw-font-signature": '"Allura", "Snell Roundhand", "Segoe Script", cursive',
  "--dw-text-xs": "12px",
  "--dw-text-sm": "13px",
  "--dw-text-md": "14px",
  "--dw-text-lg": "16px",
  "--dw-text-xl": "22px",
  "--dw-text-signature": "40px",
  "--dw-weight-regular": "400",
  "--dw-weight-medium": "500",
  "--dw-weight-semibold": "600",
  "--dw-leading": "1.5",
  "--dw-leading-tight": "1.25",
})

export const motion = stylex.defineVars({
  "--dw-duration-fast": { default: "120ms", [REDUCED]: "0ms" },
  "--dw-duration-normal": { default: "200ms", [REDUCED]: "0ms" },
  "--dw-ease-out": "cubic-bezier(0.16, 1, 0.3, 1)",
})

export const size = stylex.defineVars({
  "--dw-control-sm": "30px",
  "--dw-control-md": "36px",
  "--dw-header-height": "56px",
  "--dw-page-width": "1180px",
  "--dw-party-width": "720px",
})
