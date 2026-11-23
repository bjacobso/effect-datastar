/**
 * Live views shared by every tab that shows the same thing.
 *
 * A live view (a table for one query in one organization, a record) is a
 * stream of Datastar events. Every tab with an identical view would compute
 * identical events: the same page query, the same COUNT, the same render.
 * `subscribe` runs that work once per *key* (the caller's: e.g. tenant + query)
 * and fans the events out to every subscriber:
 *
 * - The first subscriber starts the shared *source*; the last one to leave
 *   stops it. A later subscriber joins the running source.
 * - A source keeps a *snapshot*: the events that bring a tab from nothing to
 *   the current state (the whole table, its selects, the page's ids). Every
 *   subscriber starts with it, so a late joiner needs no query at all.
 * - After that, a subscriber gets the source's *deltas* (a re-rendered table,
 *   row patches) as they come.
 * - Slow consumers: a subscriber whose socket is not draining stops pulling,
 *   and its pending deltas pile up. Past `maxPending` events they are dropped
 *   and the subscriber is marked stale: its next pull gets the snapshot
 *   instead, which supersedes every delta it missed (patches are idempotent:
 *   the table replaces the table). So a stuck tab holds at most `maxPending`
 *   references to events the others got too, and never slows them down.
 *
 * The key must include everything the events depend on. In particular a
 * tenant-scoped view's key must include the tenant: sharing never crosses
 * organizations because their keys differ, and the source runs with the
 * tenant of the subscriber that started it.
 */
import { Cause, Effect, Fiber, Latch, Stream } from "effect"
import { counters } from "../metrics/Metrics.ts"
import type { DatastarEvent } from "./Datastar.ts"

/** What a shared view computes once for all its subscribers. */
export interface Source {
  /** Events for subscribers that are up to date. Runs until the last subscriber leaves (or it ends). */
  readonly deltas: Stream.Stream<ReadonlyArray<DatastarEvent>>
  /**
   * Events that bring a tab to the current state; `undefined` until there is one.
   * `first`: the tab's first events (e.g. with a signal only a new tab needs).
   */
  readonly snapshot: (first: boolean) => ReadonlyArray<DatastarEvent> | undefined
}

interface Subscriber {
  pending: Array<DatastarEvent>
  /** Needs the snapshot (new, or dropped deltas). */
  stale: boolean
  readonly wake: Latch.Latch
}

interface Hub {
  readonly subscribers: Set<Subscriber>
  source: Source | undefined
  fiber: Fiber.Fiber<void> | undefined
  /** The source ended (failed or completed): subscribers drain and end. */
  ended: boolean
}

/** Shared views by key (one registry per kind of view). */
export type Registry = Map<string, Hub>
export const registry = (): Registry => new Map()

/** Pending deltas a subscriber may hold before it is switched to the snapshot. */
export const MAX_PENDING = 16

/** Registry statistics, for tests and metrics. */
export const stats = (hubs: Registry) => ({
  views: hubs.size,
  subscribers: [...hubs.values()].reduce((n, hub) => n + hub.subscribers.size, 0)
})

const wakeAll = (hub: Hub) => {
  for (const s of hub.subscribers) s.wake.openUnsafe()
}

const publish = (hub: Hub, events: ReadonlyArray<DatastarEvent>, maxPending: number) => {
  if (events.length === 0) return
  for (const s of hub.subscribers) {
    if (s.stale) continue
    s.pending.push(...events)
    if (s.pending.length > maxPending) {
      s.pending = []
      s.stale = true
    }
    s.wake.openUnsafe()
  }
}

/**
 * The shared view for `key`: started with `make` if it isn't running, joined
 * otherwise. Emits the snapshot first, then deltas. `make` must need no
 * services: provide them (e.g. the tenant) before, so the source doesn't
 * depend on the request that started it.
 */
export const subscribe = (
  hubs: Registry,
  key: string,
  make: Effect.Effect<Source>,
  options?: { readonly maxPending?: number | undefined }
): Stream.Stream<ReadonlyArray<DatastarEvent>> =>
  Stream.unwrap(Effect.gen(function*() {
    const maxPending = options?.maxPending ?? MAX_PENDING
    const self: Subscriber = { pending: [], stale: true, wake: Latch.makeUnsafe(false) }
    return yield* Effect.acquireRelease(
      Effect.sync(() => {
        let hub = hubs.get(key)
        if (hub === undefined || hub.ended) {
          const created: Hub = { subscribers: new Set(), source: undefined, fiber: undefined, ended: false }
          hub = created
          hubs.set(key, created)
          counters.sharedViews++
          created.fiber = Effect.runFork(
            Effect.flatMap(make, (source) => {
              created.source = source
              return Stream.runForEach(source.deltas, (events) => Effect.sync(() => publish(created, events, maxPending)))
            }).pipe(
              Effect.ensuring(Effect.sync(() => {
                counters.sharedViews--
                created.ended = true
                if (hubs.get(key) === created) hubs.delete(key)
                wakeAll(created)
              }))
            )
          )
        }
        hub.subscribers.add(self)
        return hub
      }),
      (hub) =>
        Effect.suspend(() => {
          hub.subscribers.delete(self)
          if (hub.subscribers.size > 0 || hub.fiber === undefined) return Effect.void
          if (hubs.get(key) === hub) hubs.delete(key)
          hub.ended = true
          return Fiber.interrupt(hub.fiber)
        })
    ).pipe(Effect.map((hub) => {
      let first = true
      /** The next batch for this subscriber, waiting for one; ends once the source has. */
      const pull: Effect.Effect<ReadonlyArray<DatastarEvent>, Cause.Done> = Effect.suspend(() => {
        if (self.stale) {
          const snapshot = hub.source?.snapshot(first)
          if (snapshot !== undefined) {
            self.stale = false
            self.pending = []
            first = false
            return Effect.succeed(snapshot)
          }
        } else if (self.pending.length > 0) {
          const events = self.pending
          self.pending = []
          return Effect.succeed(events)
        }
        if (hub.ended) return Cause.done()
        self.wake.closeUnsafe()
        return Effect.andThen(self.wake.await, pull)
      })
      return Stream.fromEffectRepeat(pull)
    }))
  }))
