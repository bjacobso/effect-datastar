import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import * as ManyToMany from "../src/ManyToMany.ts"
import * as Query from "../src/Query.ts"
import * as Schemas from "../src/Schemas.ts"

const CategoryId = Schema.Int.pipe(Schema.brand("CategoryId"))
const LabelId = Schema.Int.pipe(Schema.brand("LabelId"))

const ItemModel = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  status: Schema.Literals(["draft", "published"]),
  categoryId: Schema.NullOr(CategoryId).annotate({ title: "Category" }),
  featured: Schema.Boolean,
  publishDate: Schema.NullOr(Schemas.LocalDate),
  createdAt: Schema.DateTimeUtc,
  labels: ManyToMany.Ids(LabelId, { table: "item_labels", from: "itemId", to: "labelId" })
})

const ItemQuery = Query.make(ItemModel, {
  sortable: ["name", "status", "createdAt"],
  filters: {
    name: "contains",
    status: "eq",
    categoryId: "eq",
    featured: "eq",
    createdAt: "range",
    labels: "has"
  },
  defaultSort: ["createdAt", "desc"],
  pageSizes: [10, 25, 50]
})

const decode = Schema.decodeUnknownExit(ItemQuery.schema)
const makeQuery = (overrides: Record<string, unknown> = {}, filters: Record<string, string> = {}) => ({
  ...ItemQuery.initial,
  ...overrides,
  filters: { ...ItemQuery.initial.filters, ...filters }
})

describe("Query", () => {
  it("derives initial query, filter metadata, and range keys", () => {
    expect(Query.rangeKeys("createdAt")).toEqual(["createdAtFrom", "createdAtTo"])
    expect(ItemQuery.initial).toEqual({
      page: 1,
      pageSize: 10,
      sort: "createdAt",
      dir: "desc",
      filters: {
        name: "",
        status: "",
        categoryId: "",
        featured: "",
        createdAtFrom: "",
        createdAtTo: "",
        labels: ""
      }
    })
    expect(ItemQuery.filters.find((f) => f.key === "createdAt")?.params).toEqual(["createdAtFrom", "createdAtTo"])
  })

  it("validates query signals strictly", () => {
    expect(decode(ItemQuery.initial)._tag).toBe("Success")
    expect(
      decode(
        makeQuery(
          { page: 2, pageSize: 25, sort: "name", dir: "asc" },
          {
            name: "widget",
            status: "published",
            categoryId: Query.NULL,
            featured: "true",
            createdAtFrom: "2026-01-01",
            createdAtTo: "2026-01-31",
            labels: "7"
          }
        )
      )._tag
    ).toBe("Success")

    expect(decode(makeQuery({ page: 0 }))._tag).toBe("Failure")
    expect(decode(makeQuery({ pageSize: 15 }))._tag).toBe("Failure")
    expect(decode(makeQuery({ sort: "unknown" }))._tag).toBe("Failure")
    expect(decode(makeQuery({ dir: "up" }))._tag).toBe("Failure")
    expect(decode(makeQuery({}, { status: "archived" }))._tag).toBe("Failure")
    expect(decode(makeQuery({}, { categoryId: "1.5" }))._tag).toBe("Failure")
    expect(decode(makeQuery({}, { featured: "yes" }))._tag).toBe("Failure")
    expect(decode(makeQuery({}, { createdAtFrom: "2026-02-30" }))._tag).toBe("Failure")
    expect(decode(makeQuery({}, { labels: "abc" }))._tag).toBe("Failure")
  })

  it("round-trips through URLSearchParams, omitting defaults and ignoring invalid params", () => {
    expect(ItemQuery.toSearchParams(ItemQuery.initial).toString()).toBe("")

    const q = makeQuery(
      { page: 3, pageSize: 25, sort: "name", dir: "asc" },
      { status: "published", createdAtFrom: "2026-01-01", labels: "5" }
    )
    const params = ItemQuery.toSearchParams(q)
    expect(params.toString()).toBe("status=published&createdAtFrom=2026-01-01&labels=5&sort=name&dir=asc&pageSize=25&page=3")
    expect(ItemQuery.fromSearchParams(params)).toEqual(q)

    const invalid = new URLSearchParams("page=0&pageSize=99&sort=nope&dir=sideways&status=bad&categoryId=1.5&createdAtFrom=2026-02-30")
    expect(ItemQuery.fromSearchParams(invalid)).toEqual(ItemQuery.initial)
  })

  it("decodes flat API params strictly and fills defaults via fromParams", () => {
    const ok = Schema.decodeUnknownExit(ItemQuery.params)({ sort: "name", status: "draft", labels: "2" })
    expect(ok._tag).toBe("Success")
    if (ok._tag === "Success") {
      expect(ItemQuery.fromParams(ok.value)).toEqual(
        makeQuery({ sort: "name" }, { status: "draft", labels: "2" })
      )
    }
    expect(Schema.decodeUnknownExit(ItemQuery.params)({ status: "bogus" })._tag).toBe("Failure")
  })

  it("computes active query columns for reactivity planning", () => {
    expect(ItemQuery.columns(ItemQuery.initial)).toEqual(["createdAt"])
    expect(
      ItemQuery.columns(makeQuery({ sort: "name" }, { status: "draft", createdAtFrom: "2026-01-01", labels: "2" }))
    ).toEqual(["name", "status", "createdAt", "labels"])
  })

  it("supports locking an eq filter and rejects signals setting the locked key", () => {
    const locked = ItemQuery.lock("categoryId")
    expect(locked.key).toBe("categoryId")
    expect(locked.filters.map((f) => f.key)).not.toContain("categoryId")
    expect(locked.parse("4")).toBe("4")
    expect(locked.parse("")).toBeUndefined()
    expect(locked.parse(Query.NULL)).toBeUndefined()
    expect(locked.parse("1.5")).toBeUndefined()

    const decodeLocked = Schema.decodeUnknownExit(locked.schema)
    expect(decodeLocked(locked.initial)._tag).toBe("Success")
    expect(
      decodeLocked({
        ...locked.initial,
        filters: { ...locked.initial.filters, categoryId: "4" }
      })._tag
    ).toBe("Failure")

    expect(locked.apply(locked.initial, "4").filters.categoryId).toBe("4")
    expect(() => ItemQuery.lock("name")).toThrow()
  })

  it("rejects mismatched filter operators at definition time", () => {
    expect(() =>
      Query.make(ItemModel, {
        sortable: ["name"],
        filters: { name: "range" },
        defaultSort: ["name", "asc"],
        pageSizes: [10]
      })
    ).toThrow()

    expect(() =>
      Query.make(ItemModel, {
        sortable: ["name"],
        filters: { name: "has" },
        defaultSort: ["name", "asc"],
        pageSizes: [10]
      })
    ).toThrow()

    expect(() =>
      Query.make(ItemModel, {
        sortable: ["name"],
        filters: { labels: "eq" },
        defaultSort: ["name", "asc"],
        pageSizes: [10]
      })
    ).toThrow()
  })
})
