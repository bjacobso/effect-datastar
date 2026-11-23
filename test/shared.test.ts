/**
 * Shared live views (`src/datastar/Shared.ts`): identical views in one
 * organization run one query and one render per change, whatever the number
 * of tabs; views of different organizations never share; a late tab starts
 * from the current state; a tab that stops reading is switched to snapshots
 * instead of buffering.
 */
import { Effect, Queue, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Datastar from "../src/datastar/Datastar.ts"
import * as Shared from "../src/datastar/Shared.ts"
import { counters } from "../src/metrics/Metrics.ts"
import { type Event, GLOBEX, makeApp, rowNames, userDraft, usersQuery } from "./support.ts"

const app = makeApp()
const globex = app.as(GLOBEX)

type Patch = Extract<Event, { type: "patch-elements" }>
const tableOf = (events: Array<Event>) =>
  events.filter((e): e is Patch => e.type === "patch-elements").find((e) => e.elements.includes(`id="users-table"`))?.elements
const hasTable = (events: Array<Event>) => tableOf(events) !== undefined
const settle = () => new Promise((r) => setTimeout(r, 100))

describe("shared live tables", () => {
  it("runs one query per change for identical views, and every tab gets it", async () => {
    const tabs = await Promise.all(Array.from({ length: 5 }, () => app.stream("/users/view", usersQuery())))
    await Promise.all(tabs.map((t) => t.until(hasTable)))
    await settle()
    expect(counters.sharedViews).toBe(1)

    const before = counters.requeries
    await app.action("POST", "/users", userDraft({ name: "Shared Sam", email: "shared.sam@example.com" }))
    const tables = await Promise.all(tabs.map((t) => t.until((e) => tableOf(e)?.includes("Shared Sam") === true)))
    // One page query (and COUNT) for the five tabs.
    expect(counters.requeries - before).toBe(1)
    for (const events of tables) expect(rowNames(tableOf(events)!)[0]).toBe("Shared Sam")

    await Promise.all(tabs.map((t) => t.close()))
    await settle()
    expect(counters.sharedViews).toBe(0)
  })

  it("never shares across organizations, even for the same query", async () => {
    const acme = await app.stream("/users/view", usersQuery())
    const other = await globex.stream("/users/view", usersQuery())
    const [acmeFirst, otherFirst] = await Promise.all([acme.until(hasTable), other.until(hasTable)])
    await settle()
    expect(counters.sharedViews).toBe(2)
    expect(rowNames(tableOf(acmeFirst)!)).not.toEqual(rowNames(tableOf(otherFirst)!))

    // A Globex insert reaches the Globex tab only.
    await globex.action("POST", "/users", userDraft({ name: "Globex Gil", email: "globex.gil@example.com" }))
    const next = await other.until((e) => tableOf(e)?.includes("Globex Gil") === true)
    expect(rowNames(tableOf(next)!)[0]).toBe("Globex Gil")
    expect(await acme.collect(200)).toEqual([])

    // An Acme insert reaches the Acme tab only.
    await app.action("POST", "/users", userDraft({ name: "Acme Ann", email: "acme.ann@example.com" }))
    const acmeNext = await acme.until((e) => tableOf(e)?.includes("Acme Ann") === true)
    expect(tableOf(acmeNext)).not.toContain("Globex Gil")
    expect(await other.collect(200)).toEqual([])

    await Promise.all([acme.close(), other.close()])
  })

  it("starts a late tab from the current state (row patches included) without a query", async () => {
    const first = await app.stream("/users/view", usersQuery({ sort: "name", dir: "desc" }))
    const initial = tableOf(await first.until(hasTable))!
    const top = rowNames(initial)[0]!
    // A change to a column the view doesn't sort or filter on: a row patch.
    const id = Number(/<tr id="users-(\d+)"/.exec(initial)![1])
    const { events } = await app.action("GET", `/users/${id}/edit`)
    const draft = (events[0] as { signals: { users: { draft: Record<string, unknown> } } }).signals.users.draft
    await app.action("PUT", `/users/${id}`, userDraft({ ...draft, email: "patched@example.com" }))
    await first.until((e) => e.some((x) => x.type === "patch-elements" && x.elements.includes("patched@example.com")))

    const before = counters.requeries
    const late = await app.stream("/users/view", usersQuery({ sort: "name", dir: "desc" }))
    const table = tableOf(await late.until(hasTable))!
    expect(counters.requeries).toBe(before)
    expect(rowNames(table)[0]).toBe(top)
    expect(table).toContain("patched@example.com")
    await Promise.all([first.close(), late.close()])
  })

  it("a new tab still gets the canonical URL; a joined one too", async () => {
    const a = await app.stream("/users/view", usersQuery({ sort: "email", dir: "asc" }))
    const b = await app.stream("/users/view", usersQuery({ sort: "email", dir: "asc" }))
    for (const s of [a, b]) {
      const events = await s.until(hasTable)
      const url = events.flatMap((e) => (e.type === "patch-signals" ? [e.signals.users?._url] : [])).find((u) => u)
      expect(url).toBe("/users?sort=email&dir=asc")
    }
    await Promise.all([a.close(), b.close()])
  })
})

describe("Shared.subscribe", () => {
  /** A source whose state is a counter: each delta is the new value, the snapshot the current one. */
  const counterSource = Effect.gen(function*() {
    const queue = yield* Queue.unbounded<number>()
    let value = 0
    const event = (n: number) => Datastar.patchSignals({ n })
    const source: Shared.Source = {
      deltas: Stream.fromQueue(queue).pipe(Stream.map((n) => {
        value = n
        return [event(n)]
      })),
      snapshot: () => [event(value)]
    }
    return { queue, source }
  })
  // A pull is a chunk of batches.
  const values = (chunk: ReadonlyArray<ReadonlyArray<Datastar.DatastarEvent>>) =>
    chunk.flat().map((e) => (e as Datastar.PatchSignals).signals as { n: number }).map((s) => s.n)

  it("switches a subscriber that doesn't read to the snapshot instead of buffering", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const { queue, source } = yield* counterSource
      const hubs = Shared.registry()
      const pull = yield* Stream.toPull(Shared.subscribe(hubs, "k", Effect.succeed(source), { maxPending: 3 }))
      expect(values(yield* pull)).toEqual([0])
      // Up to date: deltas one by one.
      yield* Queue.offer(queue, 1)
      expect(values(yield* pull)).toEqual([1])
      // Falls behind by more than `maxPending`: its deltas are dropped, and it gets the state.
      for (let n = 2; n <= 10; n++) yield* Queue.offer(queue, n)
      yield* Effect.sleep("20 millis")
      expect(values(yield* pull)).toEqual([10])
      // Behind by fewer: the deltas, in order.
      yield* Queue.offer(queue, 11)
      yield* Queue.offer(queue, 12)
      yield* Effect.sleep("20 millis")
      expect(values(yield* pull)).toEqual([11, 12])
    }))))

  it("starts the source once per key and stops it with its last subscriber", () =>
    Effect.runPromise(Effect.gen(function*() {
      const hubs = Shared.registry()
      let started = 0
      const make = Effect.map(counterSource, ({ source }) => {
        started++
        return source
      })
      yield* Effect.scoped(Effect.gen(function*() {
        const a = yield* Stream.toPull(Shared.subscribe(hubs, "k", make))
        const b = yield* Stream.toPull(Shared.subscribe(hubs, "k", make))
        const c = yield* Stream.toPull(Shared.subscribe(hubs, "other", make))
        yield* a
        yield* b
        yield* c
        expect(started).toBe(2)
        expect(Shared.stats(hubs)).toEqual({ views: 2, subscribers: 3 })
      }))
      expect(Shared.stats(hubs)).toEqual({ views: 0, subscribers: 0 })
    })))
})
