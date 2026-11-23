/**
 * Theme: Light / Dark / System, saved per browser (ui-sdk Menu).
 */
import { useSyncExternalStore } from "react"
import { ActionMenu } from "../ui/menu.tsx"
import { colorScheme } from "../ui/theme/themes.ts"
import * as Island from "./Island.tsx"

const schemes = {
  system: { label: "System", icon: "monitor" },
  light: { label: "Light", icon: "sun" },
  dark: { label: "Dark", icon: "moon" }
} as const

export const Theme = Island.make<{}>("theme", () => {
  const value = useSyncExternalStore(
    (listener) => colorScheme.subscribe(listener),
    () => colorScheme.get().value,
    () => "system" as const
  )
  return (
    <ActionMenu
      label="Theme"
      text={schemes[value].label}
      actions={(Object.keys(schemes) as Array<keyof typeof schemes>).map((key) => ({
        value: key,
        label: schemes[key].label,
        icon: schemes[key].icon,
        onSelect: () => colorScheme.set(key)
      }))}
    />
  )
})
