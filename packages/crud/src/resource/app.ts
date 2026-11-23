/**
 * `app`: assemble resources. Each route is registered once, embeds are wired
 * to the resources they embed, and every `Repo` and `Lookup` is in one layer.
 * A relation or embed naming a resource that isn't in the app is a type error.
 */
import { Layer } from "effect"
import type { HttpRouter } from "effect/http"
import type { Reactivity } from "effect/reactivity"
import type { SqlClient } from "effect/sql"
import type { AnyEmbed, AnySpec, Built, ServicesOf } from "./types.ts"

type Needs<S> = S extends { readonly "~needs"?: infer N } ? Exclude<N, undefined> : never
type Requires<S> = S extends { readonly "~requires"?: infer R } ? Exclude<R, undefined> : never
type ResourceOf<S> = S extends { readonly build: (embeds: never) => Built<infer Res> } ? Res : never
/** A compile error naming the resources that relations or embeds need but the app lacks. */
type Complete<Specs extends ReadonlyArray<AnySpec>> = [Exclude<Needs<Specs[number]>, Specs[number]["name"]>] extends [never]
  ? unknown
  : { readonly "missing resources": Exclude<Needs<Specs[number]>, Specs[number]["name"]> }

export const app = <const Specs extends readonly [AnySpec, ...Array<AnySpec>]>(...specs: Specs & Complete<Specs>) => {
  const names = specs.map((s) => s.name)
  const duplicate = names.find((n, i) => names.indexOf(n) !== i)
  if (duplicate !== undefined) throw new Error(`Resource.app: "${duplicate}" is given twice`)
  const embeds = specs.flatMap((s) => s.embeds)
  for (const e of embeds) {
    if (!names.includes(e.target)) throw new Error(`Resource.app: embed "${e.name}" needs resource "${e.target}"`)
    // Its signals and DOM ids would clash with a resource's dialog or table.
    if (names.includes(e.name)) throw new Error(`Resource.app: embed "${e.name}" has a resource's name`)
  }
  const built = new Map(specs.map((s) => [s.name, s.build(embeds.filter((e) => e.target === s.name))]))
  const sectionOf = (e: AnyEmbed) => built.get(e.target)!.section(e)
  const [first, ...rest] = [...built.values()].map((b) => b.routes(sectionOf))
  const [firstLayer, ...restLayers] = specs.map((s) => s.layer)
  type Names = Specs[number]["name"]
  return {
    /** Every resource's routes. */
    routes: Layer.mergeAll(first!, ...rest) as unknown as Layer.Layer<
      never,
      never,
      HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", Requires<Specs[number]>>
    >,
    /** Every resource's `Repo` and `Lookup`. */
    layer: Layer.mergeAll(firstLayer!, ...restLayers) as unknown as Layer.Layer<
      ServicesOf<Names>,
      never,
      SqlClient.SqlClient | Reactivity.Reactivity
    >,
    resources: Object.fromEntries([...built].map(([n, b]) => [n, b.resource])) as {
      readonly [S in Specs[number] as S["name"]]: ResourceOf<S>
    }
  }
}
