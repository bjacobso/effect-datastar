/**
 * Schema introspection: derive UI/query metadata for each field of a schema
 * from its AST + annotations.
 *
 *   - label      <- `title` annotation, else humanized key
 *   - kind       <- the decoded (Type-side) AST: string / number / boolean / literal union /
 *                   date (`format: "date"`, see `Schemas.LocalDate`) / datetime (`DateTime.Utc`) /
 *                   ids (an array stored in a join table, see `ManyToMany.Ids`) / other
 *   - options    <- literal union members (for selects and `eq` filters)
 *   - widget     <- the `widget` annotation if any, else from the kind: a date is a date
 *                   picker, a boolean a switch, ids a multi-select, a string with a max
 *                   length of 200 or more a textarea
 */
import { Schema, SchemaAST } from "effect"

export type Widget =
  | "text"
  | "email"
  | "textarea"
  | "number"
  | "checkbox"
  | "switch"
  | "select"
  | "multiselect"
  | "date"
  | "color"

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** Override the derived input widget. */
      readonly widget?: Widget | undefined
      /** Where a many-to-many field is stored (see `ManyToMany.Ids`). */
      readonly through?: Through | undefined
    }
  }
}

/** A join table: `table(from, to)`, `from` holding this row's id and `to` the related row's. */
export interface Through {
  readonly table: string
  readonly from: string
  readonly to: string
  /**
   * The join table's tenant column, if it has one: set to the current tenant on
   * every join row, so composite foreign keys (`(userId, orgId)`, `(tagId, orgId)`)
   * let the database check that both rows are in the same tenant.
   */
  readonly tenant?: string | undefined
}

export type Kind = "string" | "number" | "boolean" | "enum" | "date" | "datetime" | "ids" | "other"

export interface FieldInfo {
  readonly key: string
  readonly label: string
  readonly kind: Kind
  readonly widget: Widget | "readonly"
  readonly options: ReadonlyArray<string>
  readonly nullable: boolean
  readonly schema: Schema.Constraint
  /** For `ids`: the element (the related row's id). */
  readonly element?: FieldInfo | undefined
  /** For `ids`: the join table. */
  readonly through?: Through | undefined
}

/** Strings this long (or longer) get a textarea. */
export const TEXTAREA_MIN_LENGTH = 200

const humanize = (key: string) =>
  key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())

const DATE_TIME_UTC = "effect/schema/DateTimeUtc"

/** Annotations of an AST node and its checks (where `.annotate` on a checked schema lands). */
const annotationsOf = (ast: SchemaAST.AST): Readonly<Record<string, unknown>> =>
  Object.assign({}, ast.annotations, ...(ast.checks ?? []).map((c) => c.annotations))

const representationId = (ast: SchemaAST.AST): unknown =>
  (annotationsOf(ast)["representation"] as { readonly id?: unknown } | undefined)?.id

/** The largest `isMaxLength` among the checks, if any. */
const maxLength = (ast: SchemaAST.AST): number | undefined => {
  let max: number | undefined
  for (const check of ast.checks ?? []) {
    const r = check.annotations?.["representation"] as
      | { readonly id?: unknown; readonly payload?: { readonly maxLength?: unknown } }
      | undefined
    if (r?.id === "effect/schema/isMaxLength" && typeof r.payload?.maxLength === "number") {
      max = Math.max(max ?? 0, r.payload.maxLength)
    }
  }
  return max
}

interface Classified {
  readonly kind: Kind
  readonly options: ReadonlyArray<string>
  readonly nullable: boolean
  readonly maxLength?: number | undefined
  readonly element?: SchemaAST.AST | undefined
}

const classify = (ast: SchemaAST.AST): Classified => {
  const t = SchemaAST.toType(ast)
  if (SchemaAST.isUnion(t)) {
    const members = t.types.filter((m) => m._tag !== "Null" && m._tag !== "Undefined")
    const nullable = members.length !== t.types.length
    if (members.length > 0 && members.every(SchemaAST.isLiteral)) {
      return { kind: "enum", options: members.map((m) => String((m as SchemaAST.Literal).literal)), nullable }
    }
    if (members.length === 1) return { ...classify(members[0]!), nullable }
    return { kind: "other", options: [], nullable }
  }
  if (SchemaAST.isLiteral(t)) return { kind: "enum", options: [String(t.literal)], nullable: false }
  switch (t._tag) {
    case "String":
      return annotationsOf(t)["format"] === "date"
        ? { kind: "date", options: [], nullable: false }
        : { kind: "string", options: [], nullable: false, maxLength: maxLength(t) }
    case "Number":
      return { kind: "number", options: [], nullable: false }
    case "Boolean":
      return { kind: "boolean", options: [], nullable: false }
    case "Declaration":
      return representationId(t) === DATE_TIME_UTC
        ? { kind: "datetime", options: [], nullable: false }
        : { kind: "other", options: [], nullable: false }
    case "Arrays":
      // Only arrays stored in a join table are fields of their own (`ManyToMany.Ids`).
      return annotationsOf(t)["through"] !== undefined && t.rest.length === 1 && t.elements.length === 0
        ? { kind: "ids", options: [], nullable: false, element: t.rest[0] }
        : { kind: "other", options: [], nullable: false }
    default:
      return { kind: "other", options: [], nullable: false }
  }
}

const defaultWidget = (c: Classified): FieldInfo["widget"] => {
  switch (c.kind) {
    case "string":
      return (c.maxLength ?? 0) >= TEXTAREA_MIN_LENGTH ? "textarea" : "text"
    case "number":
      return "number"
    case "boolean":
      return "switch"
    case "enum":
      return "select"
    case "date":
      return "date"
    case "ids":
      return "multiselect"
    case "datetime":
    case "other":
      return "readonly"
  }
}

export const info = (key: string, schema: Schema.Constraint): FieldInfo => {
  const annotations = Schema.resolveAnnotations(schema as Schema.Top) as Schema.Annotations.Annotations | undefined
  const c = classify(schema.ast)
  const element = c.element === undefined ? undefined : info(key, Schema.make(c.element))
  const through = c.kind === "ids" ? annotationsOf(SchemaAST.toType(schema.ast))["through"] as Through : undefined
  return {
    key,
    label: typeof annotations?.["title"] === "string" ? annotations["title"] : humanize(key),
    kind: c.kind,
    options: c.options,
    nullable: c.nullable,
    widget: annotations?.widget ?? defaultWidget(c),
    schema,
    ...(element === undefined ? {} : { element }),
    ...(through === undefined ? {} : { through })
  }
}

/** Field infos for every field of a struct, in declaration order. */
export const infos = <F extends Schema.Struct.Fields>(fields: F): { readonly [K in keyof F]: FieldInfo } =>
  Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, info(k, s)])) as { readonly [K in keyof F]: FieldInfo }

/** The fields stored in a join table rather than a column. */
export const links = <F extends Schema.Struct.Fields>(fields: F): ReadonlyArray<FieldInfo & { readonly through: Through }> =>
  Object.values(infos(fields)).filter((f): f is FieldInfo & { readonly through: Through } => f.through !== undefined)
