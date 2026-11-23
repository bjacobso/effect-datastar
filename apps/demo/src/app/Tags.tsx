import { CurrentOrg } from "../auth/Auth.ts"
import * as Resource from "@effect-datastar/crud/Resource.ts"
import { Layout } from "./Layout.tsx"
import { Tag } from "./Tag.ts"

export const Tags = Resource.define({
  name: "tags",
  title: "Tags",
  noun: "tag",
  model: Tag,
  idColumn: "id",
  display: "name",
  query: {
    sortable: ["name", "createdAt"],
    filters: { name: "contains" },
    defaultSort: ["name", "asc"],
    pageSizes: [10, 25, 50]
  },
  messages: {
    unique: { name: "A tag with that name already exists" }
  },
  // Every row belongs to the signed-in account's organization (see `crud/Scope.ts`).
  tenant: { column: "orgId", service: CurrentOrg },
  layout: Layout
})
