/**
 * Schema introspection: derive UI/query metadata for each field of a schema
 * from its AST + annotations.
 *
 *   - label      <- `title` annotation, else humanized key
 *   - kind       <- the decoded (Type-side) AST: string / number / boolean / literal union / other
 *   - options    <- literal union members (for selects and `eq` filters)
 *   - widget     <- optional `widget` annotation to override the input type
 */
import { Schema, SchemaAST } from "effect"

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** Override the derived input widget. */
      readonly widget?: "text" | "email" | "textarea" | "number" | "checkbox" | "select" | undefined
    }
  }
}

export type Kind = "string" | "number" | "boolean" | "enum" | "other"

export interface FieldInfo {
  readonly key: string
  readonly label: string
  readonly kind: Kind
  readonly widget: "text" | "email" | "textarea" | "number" | "checkbox" | "select" | "readonly"
  readonly options: ReadonlyArray<string>
  readonly nullable: boolean
  readonly schema: Schema.Constraint
}

const humanize = (key: string) =>
  key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())

const classify = (ast: SchemaAST.AST): { kind: Kind; options: ReadonlyArray<string>; nullable: boolean } => {
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
      return { kind: "string", options: [], nullable: false }
    case "Number":
      return { kind: "number", options: [], nullable: false }
    case "Boolean":
      return { kind: "boolean", options: [], nullable: false }
    default:
      return { kind: "other", options: [], nullable: false }
  }
}

const defaultWidget = (kind: Kind): FieldInfo["widget"] => {
  switch (kind) {
    case "string":
      return "text"
    case "number":
      return "number"
    case "boolean":
      return "checkbox"
    case "enum":
      return "select"
    case "other":
      return "readonly"
  }
}

export const info = (key: string, schema: Schema.Constraint): FieldInfo => {
  const annotations = Schema.resolveAnnotations(schema as any) as Schema.Annotations.Annotations | undefined
  const c = classify(schema.ast)
  return {
    key,
    label: typeof annotations?.["title"] === "string" ? annotations["title"] : humanize(key),
    kind: c.kind,
    options: c.options,
    nullable: c.nullable,
    widget: annotations?.widget ?? defaultWidget(c.kind),
    schema
  }
}

/** Field infos for every field of a struct, in declaration order. */
export const infos = <F extends Schema.Struct.Fields>(fields: F): { readonly [K in keyof F]: FieldInfo } =>
  Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, info(k, s)])) as any
