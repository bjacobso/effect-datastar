import { Context, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import * as Policy from "../src/Policy.ts"

class TestUser extends Context.Service<TestUser, {
  readonly role: "admin" | "member" | "viewer"
  readonly active: boolean
}>()("test/User") {}

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("Policy", () => {
  it("evaluates static policies (allowAll, denyAll, readOnly, allow)", async () => {
    expect(await run(Policy.capabilities(undefined))).toEqual({
      read: true,
      create: true,
      update: true,
      delete: true,
      bulk: true
    })
    expect(await run(Policy.capabilities(Policy.allowAll))).toEqual({
      read: true,
      create: true,
      update: true,
      delete: true,
      bulk: true
    })
    expect(await run(Policy.capabilities(Policy.denyAll))).toEqual({
      read: false,
      create: false,
      update: false,
      delete: false,
      bulk: false
    })
    expect(await run(Policy.capabilities(Policy.readOnly))).toEqual({
      read: true,
      create: false,
      update: false,
      delete: false,
      bulk: false
    })
    expect(await run(Policy.capabilities(Policy.allow("read", "create", "update")))).toEqual({
      read: true,
      create: true,
      update: true,
      delete: false,
      bulk: false
    })
  })

  it("evaluates role-based policies from a service", async () => {
    const policy = Policy.byRole(TestUser, (u) => u.role, {
      admin: "*",
      member: ["read", "create", "update"],
      viewer: ["read"]
    })

    const asRole = (role: "admin" | "member" | "viewer") =>
      run(Policy.capabilities(policy).pipe(Effect.provideService(TestUser, { role, active: true })))

    expect(await asRole("admin")).toEqual({
      read: true,
      create: true,
      update: true,
      delete: true,
      bulk: true
    })
    expect(await asRole("member")).toEqual({
      read: true,
      create: true,
      update: true,
      delete: false,
      bulk: false
    })
    expect(await asRole("viewer")).toEqual({
      read: true,
      create: false,
      update: false,
      delete: false,
      bulk: false
    })
  })

  it("composes policies with and / or", async () => {
    const rolePolicy = Policy.byRole(TestUser, (u) => u.role, {
      admin: "*",
      member: ["read", "create"],
      viewer: ["read"]
    })
    const activeOnly = Policy.fromService(TestUser, (u) => u.active)
    const combined = Policy.and(rolePolicy, activeOnly)

    expect(
      await run(Policy.capabilities(combined).pipe(Effect.provideService(TestUser, { role: "admin", active: false })))
    ).toEqual({
      read: false,
      create: false,
      update: false,
      delete: false,
      bulk: false
    })
    expect(
      await run(Policy.capabilities(combined).pipe(Effect.provideService(TestUser, { role: "member", active: true })))
    ).toEqual({
      read: true,
      create: true,
      update: false,
      delete: false,
      bulk: false
    })

    const either = Policy.or(Policy.readOnly, Policy.allow("delete"))
    expect(await run(Policy.capabilities(either))).toEqual({
      read: true,
      create: false,
      update: false,
      delete: true,
      bulk: false
    })
  })

  it("enforces actions with require, failing with Forbidden when denied", async () => {
    const policy = Policy.allow("read", "create")

    expect(await run(Effect.exit(Policy.require(undefined, "delete")))).toEqual(Exit.void)
    expect(await run(Effect.exit(Policy.require(policy, "create")))).toEqual(Exit.void)

    const denied = await run(Effect.flip(Policy.require(policy, "delete", "Not allowed to delete users")))
    expect(denied).toBeInstanceOf(Policy.Forbidden)
    expect(denied._tag).toBe("Forbidden")
    expect(denied.message).toBe("Not allowed to delete users")
  })

  it("produces distinct capabilitiesKey values for distinct capability sets", () => {
    const admin = Policy.capabilitiesKey(Policy.allCapabilities)
    const member = Policy.capabilitiesKey({ read: true, create: true, update: true, delete: false, bulk: false })
    const viewer = Policy.capabilitiesKey({ read: true, create: false, update: false, delete: false, bulk: false })
    expect(new Set([admin, member, viewer]).size).toBe(3)
  })
})
