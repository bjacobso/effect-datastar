/**
 * ui-sdk Combobox in `multiple` mode, from `@dw/ui` (packages/ui/src/form-pickers.tsx,
 * `ComboField`).
 *
 * Adapted: `multiple`, with the values as chips (tinted with the option's `color`, when it
 * has one) inside the control box; `invalid` and `aria-label`; options may carry a color,
 * shown as a dot in the list. Its own module (not in form-pickers.tsx) so the islands
 * bundle can load it only on pages that have a many-to-many field.
 *
 * It needs the browser, so it is used from islands; the server renders it once as the
 * island's placeholder.
 */
import * as stylex from "@stylexjs/stylex"
import {
  Combobox,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue
} from "@ui-sdk/react/combobox"
import type { Option } from "./form.tsx"
import { styles } from "./form.tsx"
import { Icon } from "./icons.tsx"
import { shared } from "./shared.ts"

/** An option that may carry a color (a tag's), shown as a dot in the list and a tinted chip. */
export interface ColorOption extends Option {
  readonly color?: string | undefined
}

/** A chip's colors from an option color: a soft tint of it with a darker border. */
const chipColors = (color: string | undefined) =>
  color === undefined
    ? undefined
    : {
      backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
      borderColor: `color-mix(in srgb, ${color} 55%, transparent)`
    }

/**
 * ui-sdk Combobox with `multiple`: type to filter, choose several. The chosen values are
 * chips inside the control; a chip's X or Backspace in the empty input removes one.
 */
export function MultiComboField({
  options,
  value,
  onValueChange,
  disabled,
  invalid,
  placeholder = "Search…",
  "aria-label": ariaLabel
}: {
  options: ReadonlyArray<ColorOption>
  value: ReadonlyArray<string>
  onValueChange: (value: ReadonlyArray<string>) => void
  disabled?: boolean
  invalid?: boolean
  placeholder?: string
  "aria-label"?: string | undefined
}) {
  const byValue = new Map(options.map((o) => [o.value, o]))
  return (
    <Combobox
      multiple
      items={options as Array<ColorOption>}
      value={value as Array<string>}
      onValueChange={(next) => onValueChange((next as Array<string> | null) ?? [])}
      itemToLabel={(v: string) => byValue.get(v)?.label ?? v}
      disabled={disabled ?? false}
    >
      <div {...stylex.props(styles.inputWithButton)}>
        <ComboboxChips
          data-invalid={invalid || undefined}
          {...stylex.props(shared.control, styles.chips)}
        >
          <ComboboxValue>
            {(state) =>
              (state.value as Array<string>).map((v, index) => (
                <ComboboxChip key={v} value={v} {...stylex.props(styles.chip)} style={chipColors(byValue.get(v)?.color) ?? {}}>
                  {state.labels[index]}
                  <ComboboxChipRemove aria-label={`Remove ${state.labels[index]}`} {...stylex.props(styles.chipRemove)}>
                    <Icon name="x" size={12} />
                  </ComboboxChipRemove>
                </ComboboxChip>
              ))}
          </ComboboxValue>
          <ComboboxInput
            placeholder={value.length === 0 ? placeholder : ""}
            aria-label={ariaLabel}
            aria-invalid={invalid || undefined}
            {...stylex.props(styles.chipsInput)}
          />
        </ComboboxChips>
        <ComboboxTrigger aria-label="Show options" {...stylex.props(styles.inlineButton, shared.focusRing)}>
          <Icon name="chevronDown" />
        </ComboboxTrigger>
      </div>
      <ComboboxContent sideOffset={6} {...stylex.props(styles.popup, styles.listPopup)}>
        <ComboboxEmpty {...stylex.props(styles.empty)}>No matches</ComboboxEmpty>
        <ComboboxList>
          {options.map((option) => (
            <ComboboxItem key={option.value} value={option.value} label={option.label} {...stylex.props(styles.option)}>
              {option.color !== undefined && (
                <span aria-hidden="true" {...stylex.props(styles.swatch)} style={{ backgroundColor: option.color }} />
              )}
              <span {...stylex.props(styles.optionText)}>{option.label}</span>
              <ComboboxItemIndicator {...stylex.props(styles.optionCheck)}>
                <Icon name="check" size={14} />
              </ComboboxItemIndicator>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

