/**
 * Row scoping: a column whose value the server takes from a request-level
 * service, never from the client. It is the tenant-wide counterpart of an
 * embed's `lock` (which takes its value from `?scope=` in the URL).
 *
 *   Resource.define({ ..., tenant: { column: "orgId", service: CurrentOrg } })
 *
 * With a tenant, the resource's `Repo` and `Lookup` read the current value from
 * `service` (`{ id }`) on every call, so the service shows up in their
 * requirements and in the routes' requirements:
 *
 *   - `list`, `live`, `findById`, the lookup's options: `WHERE orgId = :current`
 *   - `insert`, `update`: the column is set to the current value (whatever was sent)
 *   - `update`, `delete`: a row of another tenant doesn't exist (`NoSuchElementError`)
 *   - references to another tenant-scoped resource must point at a row of the
 *     same tenant (`InvalidReference`)
 *   - reactivity keys are per tenant (`users[orgId=1]`), unless `isolateKeys: false`
 *
 * The column is hidden from forms, filters and columns, like an embed's lock,
 * and both compose: an embed of a tenant-scoped resource is bounded by both.
 */
import type { Context, Effect } from "effect"

/** `Resource.define`'s `tenant` option. */
export interface Tenant<Column extends string, I, V> {
  /** The column that holds the tenant (e.g. `"orgId"`). */
  readonly column: Column
  /** The request-level service whose `id` is the current tenant (e.g. `CurrentOrg`). */
  readonly service: Context.Key<I, { readonly id: V }>
  /**
   * Per-tenant reactivity keys (default `true`): changes in one tenant don't
   * wake another tenant's live views at all. With `false`, they wake them but
   * those views only ever re-query their own tenant's rows.
   */
  readonly isolateKeys?: boolean | undefined
}

/** The current tenant: its id as the model holds it, and encoded for the database. */
export interface Current {
  readonly id: unknown
  readonly encoded: string | number
}

/** A tenant, resolved for `Repo` and `Lookup`. */
export interface Scope<R> {
  readonly column: string
  readonly value: Effect.Effect<Current, never, R>
  readonly isolateKeys: boolean
}

/** The reactivity key of `table`'s rows in one tenant, e.g. `users[orgId=1]`. */
export const key = (table: string, column: string, value: string | number) => `${table}[${column}=${value}]`

/** A reference from a column to another resource's ids, checked against the current tenant. */
export interface ReferenceTarget {
  readonly table: string
  readonly idColumn: string
  /** The target's tenant column, if it is tenant-scoped (otherwise nothing to check). */
  readonly tenantColumn: string | undefined
}
