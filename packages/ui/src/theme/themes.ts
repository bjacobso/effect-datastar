/**
 * Light and dark themes, from `@dw/ui` (packages/ui/src/theme/themes.ts). The tokens follow
 * `prefers-color-scheme` on their own; these force one scheme when the viewer picks it.
 */
import * as stylex from "@stylexjs/stylex"
import { createColorScheme, createLocalStorage } from "@ui-sdk/core"
import { dark, light } from "./palette.stylex.ts"
import { color, shadow } from "./tokens.stylex.ts"

const colors = (palette: typeof light | typeof dark) => ({
  "--dw-scheme": palette.scheme,
  "--dw-bg": palette.bg,
  "--dw-surface": palette.surface,
  "--dw-surface-raised": palette.surfaceRaised,
  "--dw-surface-muted": palette.surfaceMuted,
  "--dw-surface-sunken": palette.surfaceSunken,
  "--dw-border": palette.border,
  "--dw-border-strong": palette.borderStrong,
  "--dw-text": palette.text,
  "--dw-text-muted": palette.textMuted,
  "--dw-text-subtle": palette.textSubtle,
  "--dw-accent": palette.accent,
  "--dw-accent-hover": palette.accentHover,
  "--dw-on-accent": palette.accentContrast,
  "--dw-accent-soft": palette.accentSoft,
  "--dw-accent-text": palette.accentText,
  "--dw-success": palette.success,
  "--dw-success-soft": palette.successSoft,
  "--dw-warning": palette.warning,
  "--dw-warning-soft": palette.warningSoft,
  "--dw-danger": palette.danger,
  "--dw-danger-hover": palette.dangerHover,
  "--dw-on-danger": palette.accentContrast,
  "--dw-danger-soft": palette.dangerSoft,
  "--dw-violet": palette.violet,
  "--dw-violet-soft": palette.violetSoft,
  "--dw-neutral-soft": palette.neutralSoft,
  "--dw-focus-ring": palette.focusRing,
  "--dw-backdrop": palette.backdrop,
})

export const lightTheme = stylex.createTheme(color, colors(light))
export const darkTheme = stylex.createTheme(color, colors(dark))
export const lightShadows = stylex.createTheme(shadow, {
  "--dw-shadow-sm": light.shadowSm,
  "--dw-shadow-md": light.shadowMd,
  "--dw-shadow-lg": light.shadowLg,
})
export const darkShadows = stylex.createTheme(shadow, {
  "--dw-shadow-sm": dark.shadowSm,
  "--dw-shadow-md": dark.shadowMd,
  "--dw-shadow-lg": dark.shadowLg,
})

const STORAGE_KEY = "dw-color-scheme"

/** The viewer's choice, saved per browser and mirrored to `data-color-scheme` on `<html>`. */
export const colorScheme = createColorScheme({ storage: createLocalStorage(STORAGE_KEY), global: true })

/** The class names that force each scheme on `<html>` ("system" follows the OS). */
export const themeClass = {
  system: "",
  light: stylex.props(lightTheme, lightShadows).className ?? "",
  dark: stylex.props(darkTheme, darkShadows).className ?? "",
} as const

/**
 * Applies the explicit Light or Dark theme class to `<html>`. "System" needs no class: the
 * tokens follow `prefers-color-scheme` on their own. `?theme=dark` forces a scheme for a visit.
 */
export const syncTheme = () => {
  const root = document.documentElement
  const forced = new URLSearchParams(window.location.search).get("theme")
  if (forced === "light" || forced === "dark" || forced === "system") colorScheme.set(forced)
  let applied = ""
  const apply = () => {
    const next = themeClass[colorScheme.get().value]
    for (const name of applied.split(" ").filter(Boolean)) root.classList.remove(name)
    for (const name of next.split(" ").filter(Boolean)) root.classList.add(name)
    applied = next
  }
  apply()
  return colorScheme.subscribe(apply)
}

/**
 * An inline `<head>` script that applies a saved Light or Dark choice before the first
 * paint (the islands bundle, which runs `syncTheme`, loads after it). Added for
 * server-rendered pages; the SPA this comes from applies it from its entry module.
 */
export const themeScript = () =>
  `try{var c=${JSON.stringify(themeClass)}[localStorage.getItem(${JSON.stringify(STORAGE_KEY)})];if(c)document.documentElement.className+=" "+c}catch(e){}`
