/**
 * Select: a ui-sdk Select bound to a string signal ("" = nothing chosen). Relation and
 * enum fields of the CRUD form.
 */
import type { Option } from "../form.tsx"
import { SelectField } from "../form-pickers.tsx"
import * as Island from "./Island.tsx"

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
