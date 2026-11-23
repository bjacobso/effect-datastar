/**
 * Field schemas the CRUD layer recognizes, so the form widget, filter and SQL
 * encoding follow from the schema instead of per-field config:
 *
 *   startDate: Schema.NullOr(LocalDate)   // a date picker; ISO `YYYY-MM-DD` text in SQLite and JSON
 *   color: Color                          // a color input; `#rrggbb`
 *
 * `Model.DateTimeInsert` and other `DateTime.Utc` fields are recognized too (kind
 * `datetime`): read-only in forms, filterable by date range.
 */
import { Schema } from "effect"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Whether `s` is a real calendar date in `YYYY-MM-DD` form (so not `2026-02-30`). */
export const isIsoDate = (s: string): boolean => {
  if (!ISO_DATE.test(s)) return false
  const [y, m, d] = s.split("-").map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** The day after an ISO date (`2026-02-28` -> `2026-03-01`). */
export const nextDay = (s: string): string => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/**
 * A calendar date without a time or zone, as an ISO `YYYY-MM-DD` string. It
 * is stored as that text in SQLite, so it sorts and compares as a date. The
 * `format: "date"` annotation makes it a date picker in forms and a `format:
 * date` string in the OpenAPI document.
 */
export const LocalDate = Schema.String.check(
  Schema.makeFilter((s: string) => isIsoDate(s), { message: "Enter a valid date" })
).pipe(Schema.brand("LocalDate")).annotate({ format: "date", expected: "a date (YYYY-MM-DD)" })
export type LocalDate = typeof LocalDate.Type

/** A `#rrggbb` color, edited with a color input. */
export const Color = Schema.String.check(
  Schema.isPattern(/^#[0-9a-fA-F]{6}$/, { message: "Pick a color" })
).annotate({ widget: "color", expected: "a #rrggbb color" })
