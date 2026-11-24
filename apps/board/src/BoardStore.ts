/**
 * In-memory Kanban board store backed by Effect `Reactivity`.
 *
 * Every mutation (`create`, `move`, `remove`) invalidates the `"board"`
 * reactivity key so shared live SSE views broadcast updates to all tabs.
 */
import { Context, Data, Effect, Layer, Schema } from "effect"
import { Reactivity } from "effect/reactivity"

export const Column = Schema.Literals(["todo", "doing", "done"])
export type Column = typeof Column.Type
export const COLUMNS: ReadonlyArray<Column> = ["todo", "doing", "done"]

export const Priority = Schema.Literals(["low", "med", "high"])
export type Priority = typeof Priority.Type
export const PRIORITIES: ReadonlyArray<Priority> = ["low", "med", "high"]

export interface Card {
  readonly id: number
  readonly title: string
  readonly column: Column
  readonly priority: Priority
}

export class BoardValidationError extends Data.TaggedError("BoardValidationError")<{
  readonly message: string
}> {}

export const BOARD_KEY = ["board"] as const

export interface BoardStoreService {
  readonly list: Effect.Effect<ReadonlyArray<Card>>
  readonly countIn: (column: Column) => Effect.Effect<number>
  readonly create: (input: {
    readonly title: string
    readonly column: Column
    readonly priority: Priority
  }) => Effect.Effect<Card, BoardValidationError>
  readonly move: (
    id: number,
    to: Column
  ) => Effect.Effect<{ readonly card: Card; readonly from: Column } | undefined>
  readonly remove: (id: number) => Effect.Effect<Card | undefined>
}

export class BoardStore extends Context.Service<BoardStore, BoardStoreService>()(
  "@effect-datastar/board/BoardStore"
) {}

export const DEFAULT_SEED: ReadonlyArray<Omit<Card, "id">> = [
  { title: "Design typed signal AST", column: "done", priority: "high" },
  { title: "Build custom Datastar JSX runtime", column: "doing", priority: "high" },
  { title: "Add Kanban live SSE board", column: "todo", priority: "med" },
  { title: "Document multi-app workspaces", column: "todo", priority: "low" }
]

export const makeBoardStoreLayer = (
  seed: ReadonlyArray<Omit<Card, "id">> = DEFAULT_SEED
): Layer.Layer<BoardStore, never, Reactivity.Reactivity> =>
  Layer.effect(
    BoardStore,
    Effect.gen(function*() {
      const reactivity = yield* Reactivity.Reactivity
      let nextId = 1
      let cards: Array<Card> = seed.map((item) => ({ id: nextId++, ...item }))

      const list: Effect.Effect<ReadonlyArray<Card>> = Effect.sync(() => [...cards])

      const countIn = (column: Column): Effect.Effect<number> =>
        Effect.sync(() => cards.filter((c) => c.column === column).length)

      const create: BoardStoreService["create"] = ({ title, column, priority }) =>
        Effect.gen(function*() {
          const trimmed = title.trim()
          if (trimmed.length === 0) {
            return yield* new BoardValidationError({ message: "Card title is required." })
          }
          const card: Card = { id: nextId++, title: trimmed, column, priority }
          cards = [card, ...cards]
          yield* reactivity.invalidate(BOARD_KEY)
          return card
        })

      const move: BoardStoreService["move"] = (id, to) =>
        Effect.gen(function*() {
          const idx = cards.findIndex((c) => c.id === id)
          if (idx === -1) return undefined
          const existing = cards[idx]!
          const from = existing.column
          if (from === to) return { card: existing, from }
          const updated: Card = { ...existing, column: to }
          cards = [updated, ...cards.filter((c) => c.id !== id)]
          yield* reactivity.invalidate(BOARD_KEY)
          return { card: updated, from }
        })

      const remove: BoardStoreService["remove"] = (id) =>
        Effect.gen(function*() {
          const existing = cards.find((c) => c.id === id)
          if (!existing) return undefined
          cards = cards.filter((c) => c.id !== id)
          yield* reactivity.invalidate(BOARD_KEY)
          return existing
        })

      return { list, countIn, create, move, remove }
    })
  )
