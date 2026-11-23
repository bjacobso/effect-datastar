import { CurrentOrg } from "../auth/Auth.ts"
import * as Resource from "@effect-datastar/crud/Resource.ts"
import { Layout } from "./Layout.tsx"
import { User } from "./User.ts"

export const Users = Resource.define({
  name: "users",
  title: "Users",
  noun: "user",
  model: User,
  idColumn: "id",
  display: "name",
  query: {
    sortable: ["name", "email", "role", "createdAt", "startDate"],
    filters: {
      name: "contains",
      email: "contains",
      role: "eq",
      teamId: "eq",
      active: "eq",
      tags: "has",
      createdAt: "range"
    },
    defaultSort: ["createdAt", "desc"],
    pageSizes: [10, 25, 50]
  },
  messages: {
    unique: { email: "Email is already taken" },
    invalidReference: { teamId: "That team no longer exists", tags: "That tag no longer exists" }
  },
  // Bulk actions on the selected rows: Delete, plus "Set role…" and "Set team…".
  bulk: { set: ["role", "teamId"] },
  // Every row belongs to the signed-in account's organization (see `crud/Scope.ts`).
  tenant: { column: "orgId", service: CurrentOrg },
  layout: Layout
})
