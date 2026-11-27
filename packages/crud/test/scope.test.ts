import { describe, expect, it } from "@effect/vitest"
import * as Scope from "../src/Scope.ts"

describe("Scope", () => {
  it("formats per-tenant reactivity keys", () => {
    expect(Scope.key("users", "orgId", 1)).toBe("users[orgId=1]")
    expect(Scope.key("projects", "tenantId", "acme")).toBe("projects[tenantId=acme]")
  })
})
