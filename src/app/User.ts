import { Schema } from "effect"
import { Model } from "effect/schema"
import * as ManyToMany from "../crud/ManyToMany.ts"
import { LocalDate } from "../crud/Schemas.ts"
import { OrgId } from "./Org.ts"
import { TagId } from "./Tag.ts"
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
 * payloads, form fields and widgets, filters, sorting) is derived from this.
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
  createdAt: Model.DateTimeInsert,
  // A date without a time: a date picker in the form, ISO `YYYY-MM-DD` text in SQLite and JSON.
  startDate: Schema.NullOr(LocalDate).annotate({ title: "Start date" }),
  // Many-to-many: tag ids, stored in `user_tags` (with the organization, which its foreign keys check).
  // A multi-select in the form; chips in the table.
  tags: ManyToMany.Ids(TagId, { table: "user_tags", from: "userId", to: "tagId", tenant: "orgId" }).annotate({ title: "Tags" })
}) {}
