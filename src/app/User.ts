import { Schema } from "effect"
import { Model } from "effect/schema"
import { OrgId } from "./Org.ts"
import { TeamId } from "./Team.ts"

export const UserId = Schema.Int.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const Role = Schema.Literals(["admin", "member", "guest"])

const Name = Schema.Trim.check(
  Schema.isMinLength(1, { message: "Name is required" }),
  Schema.isMaxLength(80, { message: "Name is too long" })
).annotate({ title: "Name" })

const Email = Schema.Trim.check(
  Schema.isPattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, { message: "Enter a valid email" })
).annotate({ title: "Email", widget: "email" })

/**
 * The single source of truth. Everything else (DB variants, JSON create/update
 * payloads, form fields, filters, sorting) is derived from this.
 */
export class User extends Model.Class<User>("User")({
  // DB-generated, but needed in `update` (it is the WHERE key) and read variants.
  id: Model.Field({ select: UserId, update: UserId, json: UserId }),
  name: Name,
  email: Email,
  role: Role.annotate({ title: "Role" }),
  // Relation: nullable foreign key to `teams`. Options come from a lookup at render time.
  teamId: Schema.NullOr(TeamId).annotate({ title: "Team", widget: "select" }),
  active: Model.BooleanSqlite,
  // The tenant: set by the server from the signed-in account, never shown or sent by forms.
  orgId: OrgId.annotate({ title: "Organization" }),
  createdAt: Model.DateTimeInsert
}) {}
