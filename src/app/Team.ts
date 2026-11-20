import { Schema } from "effect"
import { Model } from "effect/schema"

export const TeamId = Schema.Int.pipe(Schema.brand("TeamId"))
export type TeamId = typeof TeamId.Type

export class Team extends Model.Class<Team>("Team")({
  id: Model.Field({ select: TeamId, update: TeamId, json: TeamId }),
  name: Schema.Trim.check(
    Schema.isMinLength(1, { message: "Name is required" }),
    Schema.isMaxLength(40, { message: "Name is too long" })
  ).annotate({ title: "Name" }),
  createdAt: Model.DateTimeInsert
}) {}
