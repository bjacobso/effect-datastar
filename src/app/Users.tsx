import * as Resource from "../crud/Resource.tsx"
import { Layout } from "./Layout.tsx"
import { Teams } from "./Teams.tsx"
import { User } from "./User.ts"

export const Users = Resource.make({
  name: "users",
  title: "Users",
  noun: "user",
  model: User,
  idColumn: "id",
  display: "name",
  query: {
    sortable: ["name", "email", "role", "createdAt"],
    filters: { name: "contains", email: "contains", role: "eq", teamId: "eq", active: "eq" },
    defaultSort: ["createdAt", "desc"],
    pageSizes: [10, 25, 50]
  },
  // Options, table labels and live invalidation for `teamId` come from the teams resource.
  relations: { teamId: Teams.Lookup },
  messages: {
    unique: { email: "Email is already taken" },
    invalidReference: { teamId: "That team no longer exists" }
  },
  layout: Layout
})
