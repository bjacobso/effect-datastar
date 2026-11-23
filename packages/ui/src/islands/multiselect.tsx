/**
 * MultiSelect: a ui-sdk Combobox in `multiple` mode holding an array of option values
 * (strings). Many-to-many fields of the CRUD form (a user's tags).
 *
 * Not bound with `data-bind`: Datastar binds an array signal element-wise, as a group of
 * checkboxes (`tags.0`, `tags.1`, ...). The value comes in as JSON in an attribute
 * (`data-attr:data-value="JSON.stringify($users.draft.tags)"`) and goes out as the host's
 * `value` on `change` (`data-on:change="$users.draft.tags = [...evt.target.value]"`).
 */
import type { ColorOption } from "../form-combobox.tsx"
import { MultiComboField } from "../form-combobox.tsx"
import * as Island from "./Island.tsx"

/** The host attribute holding the value, as a JSON array. */
export const MultiSelectValue = "data-value"

export interface MultiSelectProps {
  readonly options: ReadonlyArray<ColorOption>
  /** Accessible name of the input. */
  readonly label: string
  readonly placeholder?: string | undefined
}

const values = (json: string | null): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(json ?? "[]")
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export const MultiSelect = Island.make<MultiSelectProps>("multiselect", ({ props, host }) => (
  <MultiComboField
    options={props.options}
    value={values(host.attr(MultiSelectValue))}
    onValueChange={(next) => host.setValue([...next])}
    aria-label={props.label}
    placeholder={props.placeholder ?? `Add ${props.label.toLowerCase()}…`}
    invalid={host.attr("aria-invalid") === "true"}
  />
))
