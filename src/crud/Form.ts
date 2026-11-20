/**
 * Form helpers derived from a schema:
 *   - `fields(schema)`  : field metadata for rendering inputs
 *   - `empty(fields)`   : an all-blank draft for the signals
 *   - `errors(error)`   : SchemaError -> `{ [field]: message }` for patching into signals
 */
import { Schema, SchemaIssue } from "effect"
import * as Field from "./Field.ts"

export type Errors<K extends string> = { readonly [P in K]: string }

const formatter = SchemaIssue.makeFormatterStandardSchemaV1()

/** Flatten a SchemaError into one message per top-level field. */
export const errors = <K extends string>(keys: ReadonlyArray<K>, error: Schema.SchemaError): Errors<K> => {
  const out = Object.fromEntries(keys.map((k) => [k, ""])) as Record<K, string>
  for (const issue of formatter(error.issue).issues) {
    const head = issue.path?.[0]
    const key = (typeof head === "object" && head !== null ? head.key : head) as K | undefined
    if (key !== undefined && key in out && out[key] === "") out[key] = issue.message
  }
  return out
}

export const noErrors = <K extends string>(keys: ReadonlyArray<K>): Errors<K> =>
  Object.fromEntries(keys.map((k) => [k, ""])) as Errors<K>

/** A blank draft value per field kind (what an empty form binds to). */
export const blank = (field: Field.FieldInfo): string | boolean =>
  field.kind === "boolean" ? false : field.kind === "enum" ? (field.nullable ? "" : field.options[0] ?? "") : ""

export const fields = <F extends Schema.Struct.Fields>(struct: { readonly fields: F }) =>
  Object.values(Field.infos(struct.fields)) as ReadonlyArray<Field.FieldInfo>

/**
 * Signals schema for an editable draft of `struct`: one loosely-typed slot per
 * field (inputs produce strings/booleans; real validation happens when the
 * draft is decoded with the model's `jsonCreate`/`jsonUpdate` schema), plus `id`
 * (`""` while creating).
 */
export const draftSchema = <F extends Schema.Struct.Fields>(struct: { readonly fields: F }) =>
  Schema.Struct({
    // Client-side only (picks create vs update; update takes the id from the URL).
    // Blank is `""`, not `null`: Datastar uses merge-patch semantics (`null` deletes
    // a signal) and re-creates referenced-but-missing signals as `""`.
    id: Schema.optionalKey(Schema.Unknown),
    ...(Object.fromEntries(Object.keys(struct.fields).map((k) => [k, Schema.Unknown])) as {
      readonly [K in keyof F]: Schema.Unknown
    })
  })

/** Signals schema holding one error message per field. */
export const errorsSchema = <F extends Schema.Struct.Fields>(struct: { readonly fields: F }) =>
  Schema.Struct(
    Object.fromEntries(Object.keys(struct.fields).map((k) => [k, Schema.String])) as {
      readonly [K in keyof F]: Schema.String
    }
  )

/** Blank draft for every field of `struct`. */
export const blankDraft = <F extends Schema.Struct.Fields>(struct: { readonly fields: F }) => ({
  id: "" as unknown,
  ...(Object.fromEntries(fields(struct).map((f) => [f.key, blank(f)])) as { readonly [K in keyof F]: unknown })
})
