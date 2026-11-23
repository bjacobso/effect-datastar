/**
 * ui-sdk DatePicker, from `@dw/ui` (packages/ui/src/form-pickers.tsx, `DateField`).
 *
 * Adapted: `invalid`, `placeholder` and an `aria-label` on the calendar button; no `name`
 * or `min` (the value goes through Datastar, not a form post). Its own module (not in
 * form-pickers.tsx) so the islands bundle loads the calendar only on pages with a date.
 *
 * It needs the browser, so it is used from islands; the server renders it once as the
 * island's placeholder.
 */
import * as stylex from "@stylexjs/stylex"
import {
  CalendarDay,
  CalendarGrid,
  CalendarHeading,
  CalendarNext,
  CalendarPrevious,
  CalendarWeekday,
  CalendarWeekdays,
  CalendarWeeks,
  DatePicker,
  DatePickerContent,
  DatePickerInput,
  DatePickerTrigger
} from "@ui-sdk/react/date-picker"
import { styles } from "./form.tsx"
import { Icon } from "./icons.tsx"
import { shared } from "./shared.ts"

/** ui-sdk DatePicker: type a date in the locale's order, or pick one from the calendar. `""` is no date. */
export function DateField({
  value,
  onValueChange,
  disabled,
  invalid,
  placeholder,
  "aria-label": ariaLabel
}: {
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  placeholder?: string | undefined
  "aria-label"?: string | undefined
}) {
  return (
    <DatePicker
      value={value || null}
      onValueChange={(next) => onValueChange(typeof next === "string" ? next : "")}
      disabled={disabled ?? false}
      {...stylex.props(styles.inputWithButton)}
    >
      <DatePickerInput
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        {...stylex.props(shared.control, styles.comboInput)}
      />
      <DatePickerTrigger aria-label="Open calendar" {...stylex.props(styles.inlineButton, shared.focusRing)}>
        <Icon name="calendar" />
      </DatePickerTrigger>
      <DatePickerContent sideOffset={6} align="end" {...stylex.props(styles.popup, styles.calendar)}>
        <div {...stylex.props(styles.calendarHeader)}>
          <CalendarPrevious aria-label="Previous month" {...stylex.props(styles.calendarNav, shared.focusRing)}>
            <Icon name="chevronLeft" />
          </CalendarPrevious>
          <CalendarHeading {...stylex.props(styles.calendarHeading)} />
          <CalendarNext aria-label="Next month" {...stylex.props(styles.calendarNav, shared.focusRing)}>
            <Icon name="chevronRight" />
          </CalendarNext>
        </div>
        <CalendarGrid {...stylex.props(styles.calendarGrid)}>
          <CalendarWeekdays>
            {(index) => <CalendarWeekday index={index} {...stylex.props(styles.weekday)} />}
          </CalendarWeekdays>
          <CalendarWeeks>
            {(cell) => <CalendarDay value={cell.date} {...stylex.props(styles.day, shared.focusRing)} />}
          </CalendarWeeks>
        </CalendarGrid>
      </DatePickerContent>
    </DatePicker>
  )
}
