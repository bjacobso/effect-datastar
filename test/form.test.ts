import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Exit } from "effect"
import * as Form from "../src/crud/Form.ts"
import { User } from "../src/app/User.ts"

const keys = ["name", "email", "role", "teamId", "active"] as const

describe("Form", () => {
  it("derives fields, widgets and labels from the create schema", () => {
    expect(Form.fields(User.jsonCreate).map((f) => [f.key, f.widget, f.label])).toEqual([
      ["name", "text", "Name"],
      ["email", "email", "Email"],
      ["role", "select", "Role"],
      ["teamId", "select", "Team"],
      ["active", "checkbox", "Active"]
    ])
  })

  it("blank drafts use \"\" (never null) and the first enum member", () => {
    expect(Form.blankDraft(User.jsonCreate)).toEqual({ id: "", name: "", email: "", role: "admin", teamId: "", active: false })
  })

  it.effect("decode coerces input strings: \"\" -> null, \"3\" -> 3, and trims", () =>
    Effect.gen(function*() {
      const value = yield* Form.decode(User.jsonCreate, {
        name: "  Ada  ",
        email: "ada@example.com",
        role: "member",
        teamId: "3",
        active: true
      })
      expect(value).toEqual({ name: "Ada", email: "ada@example.com", role: "member", teamId: 3, active: true })
      const noTeam = yield* Form.decode(User.jsonCreate, { ...value, teamId: "" })
      expect(noTeam.teamId).toBeNull()
    }))

  it.effect("decode reports every invalid field", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Form.decode(User.jsonCreate, { name: " ", email: "nope", role: "root", teamId: "x", active: true })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* Effect.flip(
        Form.decode(User.jsonCreate, { name: " ", email: "nope", role: "root", teamId: "x", active: true })
      )
      const errors = Form.errors(keys, error)
      expect(errors.name).toBe("Name is required")
      expect(errors.email).toBe("Enter a valid email")
      expect(errors.role).not.toBe("")
      expect(errors.teamId).not.toBe("")
      expect(errors.active).toBe("")
    }))

  it("toDraft turns null into \"\" and select ids into strings", () => {
    const user = User.make({
      id: 1 as any,
      name: "Ada",
      email: "ada@example.com",
      role: "admin",
      teamId: null,
      active: true,
      createdAt: DateTime.makeUnsafe(0)
    })
    expect(Form.toDraft(User.jsonUpdate, user, user.id)).toEqual({
      id: 1,
      name: "Ada",
      email: "ada@example.com",
      role: "admin",
      teamId: "",
      active: true
    })
    expect(Form.toDraft(User.jsonUpdate, User.make({ ...user, teamId: 4 as any }), 1).teamId).toBe("4")
  })
})
