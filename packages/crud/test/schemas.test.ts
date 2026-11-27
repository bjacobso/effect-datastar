import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import * as Schemas from "../src/Schemas.ts"

describe("Schemas", () => {
  describe("isIsoDate", () => {
    it("accepts valid calendar dates including leap days", () => {
      expect(Schemas.isIsoDate("2026-01-01")).toBe(true)
      expect(Schemas.isIsoDate("2024-02-29")).toBe(true)
      expect(Schemas.isIsoDate("2026-12-31")).toBe(true)
    })

    it.each([
      "",
      "2026-2-01",
      "2026-02-29",
      "2026-02-30",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-01-00",
      "2026/01/01",
      "2026-01-01T00:00:00Z",
      "not-a-date"
    ])("rejects invalid date %j", (input) => {
      expect(Schemas.isIsoDate(input)).toBe(false)
    })
  })

  describe("nextDay", () => {
    it("advances across normal days, month boundaries, leap years, and year boundaries", () => {
      expect(Schemas.nextDay("2026-01-15")).toBe("2026-01-16")
      expect(Schemas.nextDay("2026-02-28")).toBe("2026-03-01")
      expect(Schemas.nextDay("2024-02-28")).toBe("2024-02-29")
      expect(Schemas.nextDay("2024-02-29")).toBe("2024-03-01")
      expect(Schemas.nextDay("2026-12-31")).toBe("2027-01-01")
    })
  })

  describe("LocalDate", () => {
    const decode = Schema.decodeUnknownExit(Schemas.LocalDate)

    it("decodes valid ISO dates and rejects invalid ones", () => {
      const ok = decode("2026-03-15")
      expect(ok._tag).toBe("Success")
      if (ok._tag === "Success") expect(ok.value).toBe("2026-03-15")

      expect(decode("2026-02-30")._tag).toBe("Failure")
      expect(decode("not-a-date")._tag).toBe("Failure")
      expect(decode(123)._tag).toBe("Failure")
    })
  })

  describe("Color", () => {
    const decode = Schema.decodeUnknownExit(Schemas.Color)

    it("accepts 6-digit hex colors and rejects other formats", () => {
      expect(decode("#1a2b3c")._tag).toBe("Success")
      expect(decode("#AABBCC")._tag).toBe("Success")
      expect(decode("#fff")._tag).toBe("Failure")
      expect(decode("1a2b3c")._tag).toBe("Failure")
      expect(decode("#gggggg")._tag).toBe("Failure")
      expect(decode("")._tag).toBe("Failure")
    })
  })
})
