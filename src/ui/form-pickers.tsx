/**
 * ui-sdk Select, from `@dw/ui` (packages/ui/src/form-pickers.tsx).
 *
 * Adapted: `invalid` (danger border), `emptyLabel` for an explicit "nothing" option, and no
 * lazy wrappers in form.tsx: the islands bundle loads each island's module on demand
 * instead (islands/registry.ts). The other pickers are copied into modules of their own,
 * so a page loads only the ones it uses: `MultiComboField` (form-combobox.tsx, from
 * `ComboField`) and `DateField` (form-date.tsx). Not copied: `SuggestInput`,
 * `DateTimeField`.
 *
 * It needs the browser, so it is used from islands; the server renders it once as the
 * island's placeholder.
 */
import * as stylex from "@stylexjs/stylex"
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from "@ui-sdk/react/select"
import type { Option } from "./form.tsx"
import { styles } from "./form.tsx"
import { Icon } from "./icons.tsx"
import { shared } from "./shared.ts"

/** The value of the "nothing chosen" option (`emptyLabel`). ui-sdk reserves `null` for "no value". */
const EMPTY = "\u0000empty"

/**
 * ui-sdk Select: a button that opens a listbox popup. `null` is "nothing chosen"; with
 * `emptyLabel` that is also an option the user can pick again.
 */
export function SelectField({
  options,
  value,
  onValueChange,
  placeholder = "Choose…",
  emptyLabel,
  disabled,
  invalid,
  id,
  "aria-label": ariaLabel,
  xstyle
}: {
  options: ReadonlyArray<Option>
  value: string | null
  onValueChange: (value: string | null) => void
  placeholder?: string
  emptyLabel?: string | undefined
  disabled?: boolean
  invalid?: boolean
  id?: string | undefined
  "aria-label"?: string | undefined
  xstyle?: stylex.StyleXStyles
}) {
  const all = emptyLabel === undefined ? options : [{ value: EMPTY, label: emptyLabel }, ...options]
  return (
    <Select
      items={all as Array<Option>}
      value={value === null && emptyLabel !== undefined ? EMPTY : value}
      onValueChange={(next) => onValueChange(next === EMPTY ? null : ((next as string | null) ?? null))}
      disabled={disabled ?? false}
      placeholder={placeholder}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        {...stylex.props(shared.control, styles.trigger, xstyle)}
      >
        <SelectValue {...stylex.props(styles.triggerValue)} />
        <Icon name="chevronDown" {...stylex.props(styles.triggerIcon)} />
      </SelectTrigger>
      <SelectContent sideOffset={6} {...stylex.props(styles.popup, styles.listPopup)}>
        {all.map((option) => (
          <SelectItem key={option.value} value={option.value} label={option.label} {...stylex.props(styles.option)}>
            <span {...stylex.props(styles.optionText, option.value === EMPTY && styles.optionMuted)}>
              {option.label}
            </span>
            <SelectItemIndicator {...stylex.props(styles.optionCheck)}>
              <Icon name="check" size={14} />
            </SelectItemIndicator>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

