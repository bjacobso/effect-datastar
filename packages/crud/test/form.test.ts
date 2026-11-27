import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import * as Form from "../src/Form.ts"
import * as ManyToMany from "../src/ManyToMany.ts"
import * as Schemas from "../src/Schemas.ts"

const CategoryId = Schema.Int.pipe(Schema.brand("CategoryId"))
const LabelId = Schema.Int.pipe(Schema.brand("LabelId"))

const ItemCreate = Schema.Struct({
  name: Schema.Trim.check(Schema.isNonEmpty({ message: "Name is required" })),
  status: Schema.Literals(["draft", "published"]),
  categoryId: Schema.NullOr(CategoryId).annotate({ title: "Category", widget: "select" }),
  featured: Schema.Boolean,
  publishDate: Schema.NullOr(Schemas.LocalDate),
  color: Schemas.Color,
  labels: ManyToMany.Ids(LabelId, { table: "item_labels", from: "itemId", to: "labelId" })
})

const keys = ["name", "status", "categoryId", "featured", "publishDate", "color", "labels"] as const

describe("Form", () => {
  it("produces blank drafts with empty strings, first enum option, false booleans, and empty arrays", () => {
    expect(Form.blankDraft(ItemCreate)).toEqual({
      id: "",
      name: "",
      status: "draft",
      categoryId: "",
      featured: false,
      publishDate: "",
      color: "",
      labels: []
    })
  })

  it("builds empty error maps and draft/errors schemas", () => {
    expect(Form.noErrors(keys)).toEqual({
      name: "",
      status: "",
      categoryId: "",
      featured: "",
      publishDate: "",
      color: "",
      labels: ""
    })
    expect(Schema.decodeUnknownExit(Form.draftSchema(ItemCreate))(Form.blankDraft(ItemCreate))._tag).toBe("Success")
    expect(Schema.decodeUnknownExit(Form.errorsSchema(ItemCreate))(Form.noErrors(keys))._tag).toBe("Success")
  })

  it.effect("coerces string inputs on decode and round-trips via toDraft", () =>
    Effect.gen(function*() {
      const decoded = yield* Form.decode(ItemCreate, {
        name: "  Widget  ",
        status: "published",
        categoryId: "42",
        featured: true,
        publishDate: "2026-05-01",
        color: "#112233",
        labels: ["1", "3"]
      })

      expect(decoded).toEqual({
        name: "Widget",
        status: "published",
        categoryId: 42,
        featured: true,
        publishDate: "2026-05-01",
        color: "#112233",
        labels: [1, 3]
      })

      expect(Form.toDraft(ItemCreate, decoded, 9)).toEqual({
        id: 9,
        name: "Widget",
        status: "published",
        categoryId: "42",
        featured: true,
        publishDate: "2026-05-01",
        color: "#112233",
        labels: ["1", "3"]
      })
    }))

  it.effect("maps blank strings to null for nullable fields and back to empty strings in toDraft", () =>
    Effect.gen(function*() {
      const decoded = yield* Form.decode(ItemCreate, {
        name: "Plain",
        status: "draft",
        categoryId: "",
        featured: false,
        publishDate: "",
        color: "#abcdef",
        labels: []
      })

      expect(decoded.categoryId).toBeNull()
      expect(decoded.publishDate).toBeNull()
      expect(Form.toDraft(ItemCreate, decoded, "")).toMatchObject({
        id: "",
        categoryId: "",
        publishDate: ""
      })
    }))

  it.effect("flattens validation failures into per-field error messages", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Form.decode(ItemCreate, {
          name: "   ",
          status: "published",
          categoryId: "not-a-number",
          featured: true,
          publishDate: "2026-02-30",
          color: "red",
          labels: []
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
        expect(failure?._tag).toBe("Fail")
        if (failure?._tag === "Fail") {
          const errs = Form.errors(keys, failure.error)
          expect(errs.name).toBe("Name is required")
          expect(errs.categoryId).not.toBe("")
          expect(errs.publishDate).toBe("Enter a valid date")
          expect(errs.color).toBe("Pick a color")
          expect(errs.status).toBe("")
          expect(errs.featured).toBe("")
        }
      }
    }))
})
