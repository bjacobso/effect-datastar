/**
 * Form helpers derived from a schema:
 *   - `fields(schema)`  : field metadata for rendering inputs
 *   - `empty(fields)`   : an all-blank draft for the signals
 *   - `errors(error)`   : SchemaError -> `{ [field]: message }` for patching into signals
 */
import { Effect, Schema, SchemaIssue } from "effect"
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

// ---------------------------------------------------------------------------
// Draft <-> model value
//
// Inputs and selects produce strings, and Datastar signals can't hold `null`
// (merge-patch semantics delete them). So drafts use `""` for "nothing" and
// strings for select values; these two functions translate at the boundary,
// driven by field metadata.
// ---------------------------------------------------------------------------

const fromInput = (field: Field.FieldInfo, value: unknown): unknown => {
  if (typeof value !== "string") return value
  if (value === "" && field.nullable) return null
  if (field.kind === "number" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value)
  return value
}

/** Decode a draft with a create/update schema, coercing input strings per field first. */
export const decode = <S extends Schema.Codec<any, any, never, never> & { readonly fields: Schema.Struct.Fields }>(
  schema: S,
  draft: Record<string, unknown>
): Effect.Effect<S["Type"], Schema.SchemaError> => {
  const coerced = Object.fromEntries(
    fields(schema).map((f) => [f.key, fromInput(f, draft[f.key])])
  )
  return Schema.decodeUnknownEffect(schema)(coerced, { errors: "all" })
}

/** Encode a model value into a draft the form can bind to. */
export const toDraft = <S extends Schema.Codec<any, any, never, never> & { readonly fields: Schema.Struct.Fields }>(
  schema: S,
  value: S["Type"],
  id: unknown
): Record<string, unknown> => {
  const encoded = Schema.encodeSync(schema)(value) as Record<string, unknown>
  const draft: Record<string, unknown> = { id }
  for (const f of fields(schema)) {
    const v = encoded[f.key]
    draft[f.key] = v === null || v === undefined ? "" : f.widget === "select" && typeof v === "number" ? String(v) : v
  }
  return draft
}
