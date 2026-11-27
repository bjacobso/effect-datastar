/**
 * The types of a resource: what `define` takes (`Config`), what relations,
 * embeds and sections are, and what `app` assembles (`Spec`).
 */
import type { Context, Effect, Layer, Schema } from "effect"
import { Data } from "effect"
import type { Reactivity } from "effect/reactivity"
import type { Model } from "effect/schema"
import type { SqlClient } from "effect/sql"
import type { ReactElement, ReactNode } from "react"
import type * as Components from "../components.tsx"
import type * as Lookup from "../Lookup.ts"
import type * as Policy from "../Policy.ts"
import type * as Query from "../Query.ts"
import type * as Scope from "../Scope.ts"

type AnyStruct = { readonly fields: Schema.Struct.Fields }

/** What `Resource.define` needs from a model (any `Model.Class` satisfies it). */
export type ModelLike = Model.Any & Schema.Codec<any, any, never, never> & {
  readonly jsonCreate: AnyStruct & Schema.Codec<any, any, never, never>
  readonly jsonUpdate: AnyStruct & Schema.Codec<any, any, never, never>
}

export type Fields<M extends ModelLike> = keyof M["fields"] & string
export type FormKey<M extends ModelLike> = keyof M["jsonCreate"]["fields"] & string
/** A field that can be the id column: in the model, its rows and its `update` variant. */
export type IdKey<M extends ModelLike> = Fields<M> & keyof M["update"]["Type"] & keyof M["Type"]

/** Service identifiers, distinct per resource so a missing layer is a type error. */
export interface RepoOf<Name extends string> {
  readonly repo: Name
}
export interface LookupOf<Name extends string> {
  readonly lookup: Name
}
/** `RepoOf` and `LookupOf` for each name in a union. */
export type ServicesOf<Name extends string> = Name extends string ? RepoOf<Name> | LookupOf<Name> : never

/** A lookup service tag (e.g. another resource's `Lookup`). Its requirements are tracked by the resource (`~tenant`). */
export type LookupTag = Context.Key<LookupOf<string>, Lookup.Lookup<unknown>>

/**
 * What a relation points at: a resource definition. `href` takes the target's
 * id, so a foreign key whose values aren't the target's ids is a type error.
 */
export interface Target<Id> {
  readonly name: string
  readonly Lookup: LookupTag
  readonly href: (id: Id) => string
  /** The target's table, id and tenant column, for checking references against the current tenant. */
  readonly reference: Scope.ReferenceTarget
  /** Type-level only: the tenant service the target's `Repo` and `Lookup` need. */
  readonly "~tenant"?: unknown
}
export type Relations<M extends ModelLike> = {
  readonly [K in Fields<M>]?: K extends keyof M["Type"] ? Target<NonNullable<M["Type"][K]>> : never
}
/**
 * Many-to-many fields (`ManyToMany.Ids`) -> the resource their ids point at. The field's
 * elements must be the target's ids, and a field that isn't an array is a type error.
 */
export type ManyToManys<M extends ModelLike> = {
  readonly [K in Fields<M>]?: K extends keyof M["Type"]
    ? M["Type"][K] extends ReadonlyArray<infer E> ? Target<E> : never
    : never
}
export type RelationServices<R> = {
  [K in keyof R]: R[K] extends { readonly Lookup: Context.Key<infer I, any> } ? I : never
}[keyof R]
export type RelationNames<R> = { [K in keyof R]: R[K] extends { readonly name: infer N extends string } ? N : never }[keyof R]
export type RelationTenants<R> = {
  [K in keyof R]: R[K] extends { readonly "~tenant"?: infer T } ? Exclude<T, undefined> : never
}[keyof R]

/** Filter keys configured with the `eq` operator (the ones an embed can lock). */
export type EqKeys<Filters> = { [K in keyof Filters & string]: Filters[K] extends "eq" ? K : never }[keyof Filters & string]

/** The page shell. It may read services (e.g. the signed-in account): they join the routes' requirements. */
export interface Layout<R = never> {
  (props: { readonly title: string; readonly active: string; readonly children: ReactNode }):
    | ReactElement
    | Effect.Effect<ReactElement, never, R>
}

export interface Config<
  Name extends string,
  M extends ModelLike,
  Id extends Fields<M>,
  Sortable extends Fields<M>,
  Filters extends Record<string, Query.Operator>,
  TC extends Fields<M> = never,
  T = never,
  L = never,
  A = never
> {
  /** Table name, URL prefix, signal namespace and DOM id prefix. */
  readonly name: Name
  readonly title: string
  readonly noun: string
  readonly model: M
  readonly idColumn: Id
  /** Field used as the row's label: toasts, confirms, links, and this resource's `Lookup`. */
  readonly display: Fields<M>
  readonly query: Query.Config<Sortable, Filters>
  readonly messages?: {
    /** Field errors for unique constraints (matched by column name in the DB error). */
    readonly unique?: { readonly [K in FormKey<M>]?: string }
    /** Field errors for foreign key violations. Defaults to "<Label> no longer exists" for relations. */
    readonly invalidReference?: { readonly [K in FormKey<M>]?: string }
    /** Toast when a delete is rejected because other rows still reference this one. */
    readonly deleteRestricted?: string
    /** For a bulk delete's toast: `n` rows the database kept ("2 deleted, 1 has members"). */
    readonly bulkDeleteRestricted?: (n: number) => string
  }
  /**
   * Bulk actions on the selected rows. Delete is always there; `set` adds a
   * "Set <field>…" control per form field (e.g. `["role", "teamId"]`).
   */
  readonly bulk?: { readonly set?: ReadonlyArray<FormKey<M>> }
  /** Custom table cells. */
  readonly columns?: { readonly [K in Fields<M>]?: (row: M["Type"], lookups: Components.Lookups) => ReactNode }
  /** Columns not shown in the table (default: the id). */
  readonly hidden?: ReadonlyArray<Fields<M>>
  readonly layout: Layout<L>
  /**
   * Every row belongs to a tenant: `column` is filtered and set from `service`'s
   * `id` on every read and write, and hidden like an embed's lock (see `Scope.ts`).
   */
  readonly tenant?: Scope.Tenant<TC, T, M["Type"][TC]> | undefined
  /**
   * Declarative authorization policy for this resource (see `Policy.ts`).
   * Defaults to allow-all when omitted, requiring no extra services.
   */
  readonly authorize?: Policy.Policy<A> | undefined
}

/** A resource's constraint-violation messages, resolved (see `Config["messages"]`). */
export interface Messages {
  /** Field -> message for unique constraints. */
  readonly unique: Readonly<Partial<Record<string, string>>>
  /** Field -> message for foreign key violations (relations get a default). */
  readonly invalidReference: Readonly<Partial<Record<string, string>>>
  readonly deleteRestricted: string | undefined
  /** `n` rows a bulk delete couldn't remove because they are still referenced. */
  readonly bulkDeleteRestricted: (n: number) => string
}

/** A server-rendered section of the detail page. Failures must be handled (rendered) first. */
export type Section<R> = Effect.Effect<ReactNode, never, R>

/**
 * A resource's table to show on another resource's detail page, with one `eq`
 * filter locked to that page's row id (see `embed` in `definition.ts`). `V` is the
 * lock column's value type: the parent's id type must be assignable to it.
 */
export interface Embed<Target extends string, V> {
  readonly _tag: "Embed"
  /** The embedded resource. */
  readonly target: Target
  /** Signal namespace, DOM id prefix and `?embed=` value. */
  readonly name: string
  readonly title: string
  readonly lock: string
  readonly "~value"?: ((value: V) => void) | undefined
}
export type AnyEmbed = Embed<string, never>
/** A detail-page section: an embed of another resource's table, or any rendering of the row. */
export type SectionInput<Row, Id> = Embed<string, Id> | ((row: Row) => Section<unknown>)
export type SectionRequires<S> = S extends (row: never) => Effect.Effect<unknown, unknown, infer R> ? R : never
export type EmbedTargets<S> = S extends Embed<infer T, never> ? T : never

/** The `?embed=&scope=` of a request did not name an embed, or its scope is not a valid lock value. */
export class ScopeError extends Data.TaggedError("ScopeError")<{ readonly embed: string | null; readonly raw: string | null }> {}

/** Renders an embed's table for a parent row's id. */
export type SectionOf = (embed: AnyEmbed) => (value: unknown) => Section<unknown>

/** What `build` hands to `app`: the resource, its embeds as sections, and its routes. */
export interface Built<Res> {
  readonly resource: Res
  readonly section: SectionOf
  readonly routes: (sectionOf: SectionOf) => Layer.Layer<never>
}

/**
 * A resource ready for `app`: a definition (`Users`) or a definition with
 * relations and sections (`Users.with({...})`).
 */
export interface Spec<Name extends string, Needs extends string, Requires, Res> {
  readonly name: Name
  readonly layer: Layer.Layer<RepoOf<Name> | LookupOf<Name>, never, SqlClient.SqlClient | Reactivity.Reactivity>
  readonly embeds: ReadonlyArray<AnyEmbed>
  readonly build: (embeds: ReadonlyArray<AnyEmbed>) => Built<Res>
  /** Type-level only: the resources this one needs in the app (relation targets, embedded resources). */
  readonly "~needs"?: Needs | undefined
  /** Type-level only: what its routes require. */
  readonly "~requires"?: Requires | undefined
}

export interface AnySpec {
  readonly name: string
  readonly layer: Layer.Layer<never, never, SqlClient.SqlClient | Reactivity.Reactivity>
  readonly embeds: ReadonlyArray<AnyEmbed>
  readonly build: (embeds: ReadonlyArray<AnyEmbed>) => Built<unknown>
  readonly "~needs"?: string | undefined
  readonly "~requires"?: unknown
}
