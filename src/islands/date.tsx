/**
 * DateInput: a ui-sdk DatePicker bound to a string signal holding an ISO date
 * (`YYYY-MM-DD`, "" = no date). Date fields of the CRUD form and the date-range filters.
 */
import { DateField } from "../ui/form-date.tsx"
import * as Island from "./Island.tsx"

export interface DateInputProps {
  /** Accessible name of the input. */
  readonly label: string
  readonly placeholder?: string | undefined
}

export const DateInput = Island.make<DateInputProps>("date", ({ props, host }) => (
  <DateField
    value={typeof host.value === "string" ? host.value : ""}
    onValueChange={(next) => host.setValue(next)}
    aria-label={props.label}
    placeholder={props.placeholder}
    invalid={host.attr("aria-invalid") === "true"}
  />
))
