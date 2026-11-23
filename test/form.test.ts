import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Exit, Schema } from "effect"
import * as Field from "../src/crud/Field.ts"
import * as Form from "../src/crud/Form.ts"
import { Tag } from "../src/app/Tag.ts"
import { Team } from "../src/app/Team.ts"
import { User } from "../src/app/User.ts"

const keys = ["name", "email", "role", "teamId", "active", "startDate", "tags"] as const

const valid = {
  name: "Ada",
  email: "ada@example.com",
  role: "member",
  teamId: "",
  active: true,
  startDate: "",
  tags: [],
  orgId: "1"
}

describe("Form", () => {
  it("derives fields, widgets and labels from the create schema", () => {
    expect(Form.fields(User.jsonCreate).map((f) => [f.key, f.widget, f.label])).toEqual([
      ["name", "text", "Name"],
      ["email", "email", "Email"],
      ["role", "select", "Role"],
      ["teamId", "select", "Team"],
      ["active", "switch", "Active"],
      // The tenant: in the model, but `Resource` leaves it out of every form (see `crud/Scope.ts`).
      ["orgId", "number", "Organization"],
      ["startDate", "date", "Start date"],
      ["tags", "multiselect", "Tags"]
    ])
  })

  it("derives widgets from the schema, not per-field config", () => {
    const widgets = (fields: Schema.Struct.Fields) => Object.values(Field.infos(fields)).map((f) => [f.key, f.kind, f.widget])
    // A max length of 200 or more is long text.
    expect(widgets(Team.jsonCreate.fields)).toEqual([
      ["name", "string", "text"],
      ["orgId", "number", "number"],
      ["description", "string", "textarea"]
    ])
    // `Schemas.Color` carries its widget.
    expect(widgets(Tag.jsonCreate.fields)).toEqual([
      ["name", "string", "text"],
      ["color", "string", "color"],
      ["orgId", "number", "number"]
    ])
    // `DateTime.Utc` is a datetime (read-only in forms), `LocalDate` a date, `ManyToMany.Ids` ids.
    const user = Field.infos(User.fields)
    expect([user.createdAt.kind, user.createdAt.widget]).toEqual(["datetime", "readonly"])
    expect([user.startDate.kind, user.startDate.nullable]).toEqual(["date", true])
    expect(user.tags).toMatchObject({
      kind: "ids",
      through: { table: "user_tags", from: "userId", to: "tagId", tenant: "orgId" },
      element: { kind: "number" }
    })
    // An explicit annotation still wins.
    expect(Field.info("x", Schema.String.annotate({ widget: "textarea" })).widget).toBe("textarea")
    expect(Field.links(User.fields).map((l) => l.key)).toEqual(["tags"])
  })

  it("blank drafts use \"\" (never null), the first enum member and [] for ids", () => {
    expect(Form.blankDraft(User.jsonCreate)).toEqual({
      id: "",
      name: "",
      email: "",
      role: "admin",
      teamId: "",
      active: false,
      orgId: "",
      startDate: "",
      tags: []
    })
  })

  it.effect("decode coerces input strings: \"\" -> null, \"3\" -> 3, [\"1\"] -> [1], and trims", () =>
    Effect.gen(function*() {
      const value = yield* Form.decode(User.jsonCreate, {
        ...valid,
        name: "  Ada  ",
        teamId: "3",
        startDate: "2026-03-01",
        tags: ["2", "1"]
      })
      expect(value).toEqual({
        name: "Ada",
        email: "ada@example.com",
        role: "member",
        teamId: 3,
        active: true,
        orgId: 1,
        startDate: "2026-03-01",
        tags: [2, 1]
      })
      const noTeam = yield* Form.decode(User.jsonCreate, { ...valid, teamId: "", startDate: "" })
      expect(noTeam.teamId).toBeNull()
      expect(noTeam.startDate).toBeNull()
    }))

  it.effect("decode reports every invalid field", () =>
    Effect.gen(function*() {
      const bad = { name: " ", email: "nope", role: "root", teamId: "x", active: true, startDate: "2026-02-30", tags: ["x"] }
      const exit = yield* Effect.exit(Form.decode(User.jsonCreate, bad))
      expect(Exit.isFailure(exit)).toBe(true)
      const errors = Form.errors(keys, yield* Effect.flip(Form.decode(User.jsonCreate, bad)))
      expect(errors.name).toBe("Name is required")
      expect(errors.email).toBe("Enter a valid email")
      expect(errors.role).not.toBe("")
      expect(errors.teamId).not.toBe("")
      expect(errors.active).toBe("")
      expect(errors.startDate).toBe("Enter a valid date")
      expect(errors.tags).not.toBe("")
    }))

  it("toDraft turns null into \"\" and select ids into strings", () => {
    const user = User.make({
      id: 1 as never,
      name: "Ada",
      email: "ada@example.com",
      role: "admin",
      teamId: null,
      active: true,
      orgId: 1 as never,
      createdAt: DateTime.makeUnsafe(0),
      startDate: null,
      tags: [3, 1] as never
    })
    expect(Form.toDraft(User.jsonUpdate, user, user.id)).toEqual({
      id: 1,
      name: "Ada",
      email: "ada@example.com",
      role: "admin",
      teamId: "",
      active: true,
      orgId: 1,
      startDate: "",
      tags: ["3", "1"]
    })
    const later = User.make({ ...user, teamId: 4 as never, startDate: "2026-03-01" as never })
    expect(Form.toDraft(User.jsonUpdate, later, 1)).toMatchObject({ teamId: "4", startDate: "2026-03-01" })
  })
})
