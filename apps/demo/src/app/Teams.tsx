import { CurrentOrg } from "../auth/Auth.ts"
import * as Resource from "@effect-datastar/crud/Resource.tsx"
import { Layout } from "./Layout.tsx"
import { Team } from "./Team.ts"

export const Teams = Resource.define({
  name: "teams",
  title: "Teams",
  noun: "team",
  model: Team,
  idColumn: "id",
  display: "name",
  query: {
    sortable: ["name", "createdAt"],
    filters: { name: "contains" },
    defaultSort: ["name", "asc"],
    pageSizes: [10, 25, 50]
  },
  messages: {
    unique: { name: "A team with that name already exists" },
    deleteRestricted: "This team still has members. Move them first.",
    bulkDeleteRestricted: (n) => `${n} ${n === 1 ? "has" : "have"} members`
  },
  // Every row belongs to the signed-in account's organization (see `crud/Scope.ts`).
  tenant: { column: "orgId", service: CurrentOrg },
  layout: Layout
})
