/**
 * Dialog: a ui-sdk Dialog around server-rendered content (the create/edit form).
 */
import * as stylex from "@stylexjs/stylex"
import { useLayoutEffect, useRef } from "react"
import { Modal } from "../ui/overlay.tsx"
import * as Island from "./Island.tsx"

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

const styles = stylex.create({
  contents: { display: "contents" }
})
