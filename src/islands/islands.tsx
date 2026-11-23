/**
 * The islands this app uses. Shared by the server (placeholders) and the browser bundle.
 */
import * as stylex from "@stylexjs/stylex"
import { useLayoutEffect, useRef, useSyncExternalStore } from "react"
import type { Option } from "../ui/form.tsx"
import { SelectField } from "../ui/form-pickers.tsx"
import { ActionMenu } from "../ui/menu.tsx"
import { Modal } from "../ui/overlay.tsx"
import { colorScheme } from "../ui/theme/themes.ts"
import * as Island from "./Island.tsx"

// ---------------------------------------------------------------------------
// Select: a ui-sdk Select bound to a string signal ("" = nothing chosen)
// ---------------------------------------------------------------------------

export interface SelectProps {
  readonly options: ReadonlyArray<Option>
  /** Accessible name of the trigger. */
  readonly label: string
  /** An explicit "nothing" option (for nullable fields), shown first. */
  readonly emptyLabel?: string | undefined
  readonly placeholder?: string | undefined
}

/**
 * `<Island.Mount island={Select} props={...} attrs={ds.bind("users.draft.teamId")} />`.
 * `aria-invalid="true"` on the host (e.g. from `data-attr:aria-invalid`) marks it invalid.
 */
export const Select = Island.make<SelectProps>("select", ({ props, host }) => (
  <SelectField
    options={props.options}
    value={host.value === "" || host.value === null || host.value === undefined ? null : String(host.value)}
    onValueChange={(next) => host.setValue(next ?? "")}
    aria-label={props.label}
    emptyLabel={props.emptyLabel}
    placeholder={props.placeholder ?? "Choose…"}
    invalid={host.attr("aria-invalid") === "true"}
  />
))

// ---------------------------------------------------------------------------
// Dialog: a ui-sdk Dialog around server-rendered content
// ---------------------------------------------------------------------------

export interface DialogProps {
  /** Id of the heading inside the content, which names the dialog. */
  readonly labelledBy: string
}

/**
 * Open while the host has an `open` attribute (`data-attr:open="$users.dialog"`); Escape,
 * the backdrop and the X emit `close` (`data-on:close="$users.dialog = false"`). The
 * content is the host's `<template>`, placed once and kept mounted (hidden while closed),
 * so Datastar binds it like any other markup and patches can always find what is inside.
 */
export const Dialog = Island.make<DialogProps>("dialog", ({ props, host }) => (
  <Modal open={host.attr("open") !== null} labelledBy={props.labelledBy} onClose={() => host.emit("close")} keepMounted>
    <Content fragment={host.content} />
  </Modal>
))

function Content({ fragment }: { readonly fragment: DocumentFragment | null }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // Moves the nodes in once; React never renders children here, so it leaves them alone.
    if (fragment && ref.current) ref.current.append(fragment)
  }, [fragment])
  return <div ref={ref} {...stylex.props(styles.contents)} />
}

// ---------------------------------------------------------------------------
// Theme: Light / Dark / System, saved per browser
// ---------------------------------------------------------------------------

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

/** Every island, by name, for the browser bundle. */
export const all: ReadonlyArray<Island.Island<never>> = [Select, Dialog, Theme]

const styles = stylex.create({
  contents: { display: "contents" }
})
