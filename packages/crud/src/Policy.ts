/**
 * Declarative Role-Based Access Control (RBAC) for CRUD resources.
 *
 * A `Policy<R>` decides whether the current request may perform a `CrudAction`
 * (`read`, `create`, `update`, `delete`, `bulk`). Policies may read request-level
 * services `R` (e.g. `CurrentUser`), which flow into `Resources.routes` and
 * `Api` handler requirements just like `tenant.service`.
 *
 * When a resource omits `authorize`, it defaults to allow-all (`R = never`).
 */
import { type Context, Effect, Schema } from "effect"

/** The actions a CRUD resource guards. */
export type CrudAction = "read" | "create" | "update" | "delete" | "bulk"

/**
 * A resource authorization policy: given an action, returns whether the
 * current request is allowed to perform it.
 */
export type Policy<R = never> = (action: CrudAction) => Effect.Effect<boolean, never, R>

/** 403: the signed-in principal is not allowed to perform this action. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String
}, { httpApiStatus: 403 }) {}

/** Evaluated permissions for the current request, used to render only allowed controls. */
export interface Capabilities {
  readonly read: boolean
  readonly create: boolean
  readonly update: boolean
  readonly delete: boolean
  readonly bulk: boolean
}

export const allCapabilities: Capabilities = {
  read: true,
  create: true,
  update: true,
  delete: true,
  bulk: true
}

/** Compact cache key for `Shared` live views so different capability sets never share rendered HTML. */
export const capabilitiesKey = (caps: Capabilities): string =>
  `${caps.read ? 1 : 0}${caps.create ? 1 : 0}${caps.update ? 1 : 0}${caps.delete ? 1 : 0}${caps.bulk ? 1 : 0}`

// ---------------------------------------------------------------------------
// Policy constructors & combinators
// ---------------------------------------------------------------------------

/** Allows every action. */
export const allowAll: Policy<never> = () => Effect.succeed(true)

/** Denies every action. */
export const denyAll: Policy<never> = () => Effect.succeed(false)

/** Allows only `"read"`. */
export const readOnly: Policy<never> = (action) => Effect.succeed(action === "read")

/** Allows only the listed actions. */
export const allow = (...actions: ReadonlyArray<CrudAction>): Policy<never> => {
  const allowed = new Set<CrudAction>(actions)
  return (action) => Effect.succeed(allowed.has(action))
}

/** Policy derived from a request-level service (e.g. `CurrentUser`). */
export const fromService = <I, S>(
  service: Context.Key<I, S>,
  check: (value: S, action: CrudAction) => boolean
): Policy<I> =>
  (action) => Effect.map(Effect.service(service), (value) => check(value, action))

/**
 * Role-based policy reading a role from `service`. Each role maps to `"*"`
 * (every action) or the list of allowed actions.
 */
export const byRole = <I, S, Role extends string>(
  service: Context.Key<I, S>,
  getRole: (value: S) => Role,
  rules: Readonly<Record<Role, ReadonlyArray<CrudAction> | "*">>
): Policy<I> => {
  const sets = new Map<Role, ReadonlySet<CrudAction> | "*">(
    (Object.entries(rules) as Array<[Role, ReadonlyArray<CrudAction> | "*"]>).map(([role, spec]) => [
      role,
      spec === "*" ? "*" : new Set(spec)
    ])
  )
  return fromService(service, (value, action) => {
    const rule = sets.get(getRole(value))
    return rule === "*" || (rule !== undefined && rule.has(action))
  })
}

/** Both policies must allow the action. */
export const and = <R1, R2>(a: Policy<R1>, b: Policy<R2>): Policy<R1 | R2> =>
  (action) => Effect.flatMap(a(action), (ok) => (ok ? b(action) : Effect.succeed(false)))

/** Either policy may allow the action. */
export const or = <R1, R2>(a: Policy<R1>, b: Policy<R2>): Policy<R1 | R2> =>
  (action) => Effect.flatMap(a(action), (ok) => (ok ? Effect.succeed(true) : b(action)))

// ---------------------------------------------------------------------------
// Evaluation & enforcement
// ---------------------------------------------------------------------------

/** Evaluate all CRUD capabilities for the current request (`allCapabilities` when no policy is set). */
export const capabilities = <R>(policy: Policy<R> | undefined): Effect.Effect<Capabilities, never, R> => {
  if (policy === undefined) return Effect.succeed(allCapabilities)
  return Effect.all({
    read: policy("read"),
    create: policy("create"),
    update: policy("update"),
    delete: policy("delete"),
    bulk: policy("bulk")
  })
}

/** Require `action` under `policy`, failing with `Forbidden` if denied. */
export const require = <R>(
  policy: Policy<R> | undefined,
  action: CrudAction,
  message?: string
): Effect.Effect<void, Forbidden, R> => {
  if (policy === undefined) return Effect.void
  return Effect.flatMap(policy(action), (allowed) =>
    allowed
      ? Effect.void
      : Effect.fail(new Forbidden({ message: message ?? `Not allowed to ${action}` }))
  )
}
