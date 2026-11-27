/**
 * `define`: a resource from a model and a small typed config, as a pure value
 * with no references to other resources (so definitions can't form a cycle).
 * Relations and detail-page sections are attached with `.with`, and
 * `.embed` makes its table a section of another resource's page; `app`
 * assembles them.
 */
import { Effect } from "effect"
import type { Reactivity } from "effect/reactivity"
import type * as Query from "../Query.ts"
import { build } from "./build.tsx"
import { resolve } from "./context.ts"
import type {
  Config,
  Embed,
  EmbedTargets,
  EqKeys,
  Fields,
  IdKey,
  ManyToManys,
  ModelLike,
  RelationNames,
  Relations,
  RelationServices,
  RelationTenants,
  RepoOf,
  SectionInput,
  SectionRequires,
  Spec,
  Target
} from "./types.ts"

export const define = <
  const Name extends string,
  M extends ModelLike,
  const Id extends IdKey<M>,
  const Sortable extends Fields<M>,
  const Filters extends { readonly [K in Fields<M>]?: Query.Operator },
  const TC extends Fields<M> = never,
  T = never,
  L = never,
  A = never
>(config: Config<Name, M, Id, Sortable, Filters & Record<string, Query.Operator>, TC, T, L, A>) => {
  type FK = Query.Keys<Filters>
  type Row = M["Type"]
  type IdType = M["fields"][Id]["Type"]
  const ctx = resolve<Name, M, Id, Sortable, Filters, TC, T, L, A>(config)
  const tenant = config.tenant
  const layer = ctx.layerWith([])

  /** What a definition and an assembled resource both expose. */
  const base = {
    name: ctx.name,
    title: ctx.title,
    noun: ctx.noun,
    model: ctx.model,
    idColumn: ctx.idColumn,
    query: ctx.query as Query.QueryDef<Sortable, FK>,
    /** Repository service for this resource. */
    Repo: ctx.Repo,
    /** `{ value, label, href }` options of this resource, for other resources' relations. */
    Lookup: ctx.Lookup,
    /** Provides `Repo` and `Lookup`. */
    layer,
    /** Link to a row's detail page. */
    href: ctx.href,
    /** Tenant-scoped: the column the server sets and the current tenant's id (e.g. for `Api.make`). */
    tenant: tenant && {
      column: tenant.column,
      id: Effect.map(Effect.service(tenant.service), (s): M["Type"][TC] => s.id)
    },
    /** Authorization policy, if configured (e.g. for `Api.make`). */
    authorize: ctx.authorize,
    /** What a relation to this resource checks against the current tenant. */
    reference: ctx.reference,
    /** Type-level only: the tenant service this resource's `Repo` and `Lookup` need. */
    "~tenant": undefined as T | undefined
  }

  /**
   * This resource's table as a section of another resource's detail page, with
   * the `eq` filter `lock` fixed to that page's row id:
   *
   *   Teams.with({ sections: [Users.embed({ name: "members", title: "Members", lock: "teamId" })] })
   *
   * The client never sees or sends the locked filter (signals that try to set
   * it are rejected), creates get it from the server, and edits/deletes of rows
   * outside the lock answer "no longer exists". Its query is not synced to the
   * URL: the page's URL belongs to the page.
   */
  const embed = <const Lock extends EqKeys<Filters> & FK & keyof Row>(options: {
    /** Signal namespace, DOM id prefix and `?embed=` value. Must differ from every other table on the page. */
    readonly name: string
    readonly title: string
    readonly lock: Lock
  }): Embed<Name, NonNullable<Row[Lock]>> => ({ _tag: "Embed", target: ctx.name, ...options })

  /**
   * Relations (foreign key -> the resource it references) and detail-page
   * sections (embeds of other resources, or any `(row) => Effect<ReactNode>`).
   */
  const with_ = <
    const R extends Relations<M> = {},
    const S extends ReadonlyArray<SectionInput<Row, IdType>> = readonly [],
    const MM extends ManyToManys<M> = {}
  >(options: {
    readonly relations?: R
    readonly sections?: S
    /**
     * Many-to-many fields -> the resource they point at: `{ tags: Tags }`. The field
     * itself (`ManyToMany.Ids`) says where it is stored; this gives it options, labels
     * (chips) and live updates when the target's rows change. Like a relation, every
     * id written must be a row of the current tenant (`InvalidReference`).
     */
    readonly manyToMany?: MM
  }) => {
    // Many-to-many fields are relations too: lookups, `dependsOn`, selects re-sent on
    // change, and references checked against the tenant.
    const targets = [...Object.entries(options.relations ?? {}), ...Object.entries(options.manyToMany ?? {})]
      .flatMap(([key, target]) => target === undefined ? [] : [[key, target as Target<never>] as const])
    const relations = targets.map(([key, target]) => [key, target.Lookup] as const)
    const references = targets.map(([key, target]) => [key, target.reference] as const)
    const sections: ReadonlyArray<SectionInput<Row, IdType>> = options.sections ?? []
    const spec: Spec<
      Name,
      RelationNames<R> | RelationNames<MM> | EmbedTargets<S[number]>,
      | RepoOf<Name>
      | Reactivity.Reactivity
      | RelationServices<R>
      | RelationServices<MM>
      | SectionRequires<S[number]>
      | T
      | L
      | A
      | RelationTenants<R>
      | RelationTenants<MM>,
      ReturnType<typeof build<Name, M, Id, Sortable, FK, T, L, A, typeof base>>["resource"]
    > = {
      name: ctx.name,
      layer: references.length === 0 ? layer : ctx.layerWith(references),
      embeds: sections.flatMap((s) => (typeof s === "function" ? [] : [s])),
      build: (embeds) => build(ctx, base, relations, sections, embeds)
    }
    return spec
  }

  const definition = { ...base, embed, with: with_ }
  return { ...definition, ...with_({}) }
}
