import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import * as Field from "../src/Field.ts"
import * as ManyToMany from "../src/ManyToMany.ts"
import * as Schemas from "../src/Schemas.ts"

const ItemId = Schema.Int.pipe(Schema.brand("ItemId"))
const LabelId = Schema.Int.pipe(Schema.brand("LabelId"))

describe("Field", () => {
  it("derives labels from title annotation or humanizes camelCase keys", () => {
    expect(Field.info("firstName", Schema.String).label).toBe("First Name")
    expect(Field.info("orgId", Schema.Int.annotate({ title: "Organization" })).label).toBe("Organization")
  })

  it("classifies primitive, enum, date, datetime, color, long text, and nullable schemas", () => {
    const fields = Field.infos({
      title: Schema.String,
      bio: Schema.String.check(Schema.isMaxLength(Field.TEXTAREA_MIN_LENGTH)),
      shortNote: Schema.String.check(Schema.isMaxLength(Field.TEXTAREA_MIN_LENGTH - 1)),
      email: Schema.String.annotate({ widget: "email" }),
      count: Schema.Int,
      active: Schema.Boolean,
      status: Schema.Literals(["open", "closed"]),
      priority: Schema.NullOr(Schema.Literals(["low", "high"])),
      dueDate: Schema.NullOr(Schemas.LocalDate),
      createdAt: Schema.DateTimeUtc,
      color: Schemas.Color,
      rawList: Schema.Array(Schema.String)
    })

    expect(fields.title).toMatchObject({ kind: "string", widget: "text", nullable: false })
    expect(fields.bio).toMatchObject({ kind: "string", widget: "textarea", nullable: false })
    expect(fields.shortNote).toMatchObject({ kind: "string", widget: "text", nullable: false })
    expect(fields.email).toMatchObject({ kind: "string", widget: "email", nullable: false })
    expect(fields.count).toMatchObject({ kind: "number", widget: "number", nullable: false })
    expect(fields.active).toMatchObject({ kind: "boolean", widget: "switch", nullable: false })
    expect(fields.status).toMatchObject({
      kind: "enum",
      widget: "select",
      options: ["open", "closed"],
      nullable: false
    })
    expect(fields.priority).toMatchObject({
      kind: "enum",
      widget: "select",
      options: ["low", "high"],
      nullable: true
    })
    expect(fields.dueDate).toMatchObject({ kind: "date", widget: "date", nullable: true })
    expect(fields.createdAt).toMatchObject({ kind: "datetime", widget: "readonly", nullable: false })
    expect(fields.color).toMatchObject({ kind: "string", widget: "color", nullable: false })
    // Arrays without a `through` annotation are not many-to-many links.
    expect(fields.rawList).toMatchObject({ kind: "other", widget: "readonly", nullable: false })
  })

  it("classifies ManyToMany.Ids and discovers links via Field.links", () => {
    const through = { table: "item_labels", from: "itemId", to: "labelId", tenant: "orgId" } as const
    const structFields = {
      id: ItemId,
      name: Schema.String,
      labels: ManyToMany.Ids(LabelId, through)
    }

    const info = Field.info("labels", structFields.labels)
    expect(info).toMatchObject({
      key: "labels",
      kind: "ids",
      widget: "multiselect",
      through,
      element: { kind: "number", widget: "number" }
    })

    const links = Field.links(structFields)
    expect(links.map((l) => l.key)).toEqual(["labels"])
    expect(links[0]?.through).toEqual(through)
  })
})
