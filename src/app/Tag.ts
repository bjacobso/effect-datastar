import { Schema } from "effect"
import { Model } from "effect/schema"
import { Color } from "../crud/Schemas.ts"

export const TagId = Schema.Int.pipe(Schema.brand("TagId"))
export type TagId = typeof TagId.Type

export class Tag extends Model.Class<Tag>("Tag")({
  id: Model.Field({ select: TagId, update: TagId, json: TagId }),
  name: Schema.Trim.check(
    Schema.isMinLength(1, { message: "Name is required" }),
    Schema.isMaxLength(30, { message: "Name is too long" })
  ).annotate({ title: "Name" }),
  // A color input in the form; it also colors the tag's chips in the users table (see `Lookup`).
  color: Color.annotate({ title: "Color" }),
  createdAt: Model.DateTimeInsert
}) {}
