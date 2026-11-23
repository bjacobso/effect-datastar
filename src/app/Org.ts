import { Schema } from "effect"
import { Model } from "effect/schema"

export const OrgId = Schema.Int.pipe(Schema.brand("OrgId"))
export type OrgId = typeof OrgId.Type

/**
 * An organization (tenant). Teams and users belong to one; a signed-in account
 * only ever sees its own organization's rows (`tenant: { column: "orgId", ... }`).
 */
export class Org extends Model.Class<Org>("Org")({
  id: Model.Field({ select: OrgId, update: OrgId, json: OrgId }),
  name: Schema.Trim.check(Schema.isMinLength(1, { message: "Name is required" })).annotate({ title: "Name" }),
  createdAt: Model.DateTimeInsert
}) {}
