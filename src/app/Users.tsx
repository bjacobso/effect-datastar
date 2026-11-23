import * as Resource from "../crud/Resource.tsx"
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
    sortable: ["name", "email", "role", "createdAt"],
    filters: { name: "contains", email: "contains", role: "eq", teamId: "eq", active: "eq" },
    defaultSort: ["createdAt", "desc"],
    pageSizes: [10, 25, 50]
  },
  messages: {
    unique: { email: "Email is already taken" },
    invalidReference: { teamId: "That team no longer exists" }
  },
  layout: Layout
})
