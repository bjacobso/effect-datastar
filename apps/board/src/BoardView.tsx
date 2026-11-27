/** @jsxImportSource @effect-datastar/ui */
/**
 * Collaborative Kanban Board view built with all 4 layers of the Datastar DSL:
 * - Layer 1: `Expr` (`E`, `Action`, `lit`, typed `$` signal tree)
 * - Layer 2: `$`-prefixed JSX runtime (`@effect-datastar/ui`) + StyleX tokens
 * - Layer 3: Typed `Slot.make` & `Slot.keyed` for incremental card/count patches
 * - Layer 4: `View.make` unifying signals, slots, actions, and jittered `Shared` live SSE
 */
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import { Action, E, lit } from "@effect-datastar/datastar/Expr.ts"
import * as Shared from "@effect-datastar/datastar/Shared.ts"
import { Slot } from "@effect-datastar/datastar/Slot.ts"
import { View } from "@effect-datastar/datastar/View.ts"
import * as Html from "@effect-datastar/ui/Html.ts"
import { color, font, radius, shadow, space } from "@effect-datastar/ui/theme/tokens.stylex.ts"
import * as stylex from "@stylexjs/stylex"
import { Effect, Schema, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import {
  BOARD_KEY,
  BoardStore,
  type Card,
  Column,
  COLUMNS,
  PRIORITIES,
  Priority
} from "./BoardStore.ts"

const COLUMN_LABEL: Record<Column, string> = {
  todo: "Todo",
  doing: "In Progress",
  done: "Done"
}

const NEXT_COLUMNS: Record<Column, ReadonlyArray<Column>> = {
  todo: ["doing", "done"],
  doing: ["todo", "done"],
  done: ["todo", "doing"]
}

export const BoardSignals = Schema.Struct({
  title: Schema.String,
  column: Column,
  priority: Priority,
  filter: Schema.String,
  error: Schema.String,
  _busy: Schema.Boolean
})

const styles = stylex.create({
  page: {
    maxWidth: "1120px",
    margin: "0 auto",
    padding: `${space["--dw-space-6"]} ${space["--dw-space-5"]}`,
    fontFamily: font["--dw-font-sans"],
    color: color["--dw-text"]
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space["--dw-space-4"],
    marginBottom: space["--dw-space-5"],
    flexWrap: "wrap"
  },
  title: {
    margin: 0,
    fontSize: font["--dw-text-xl"],
    fontWeight: font["--dw-weight-semibold"]
  },
  filterBar: {
    display: "flex",
    alignItems: "center",
    gap: space["--dw-space-2"]
  },
  filterInput: {
    padding: `${space["--dw-space-2"]} ${space["--dw-space-3"]}`,
    borderRadius: radius["--dw-radius-md"],
    border: `1px solid ${color["--dw-border"]}`,
    backgroundColor: color["--dw-surface"],
    color: color["--dw-text"],
    fontSize: font["--dw-text-sm"]
  },
  filterBadge: {
    fontSize: font["--dw-text-xs"],
    color: color["--dw-accent-text"],
    backgroundColor: color["--dw-accent-soft"],
    padding: `2px ${space["--dw-space-2"]}`,
    borderRadius: radius["--dw-radius-full"]
  },
  composer: {
    display: "flex",
    gap: space["--dw-space-2"],
    flexWrap: "wrap",
    alignItems: "center",
    padding: space["--dw-space-4"],
    backgroundColor: color["--dw-surface"],
    border: `1px solid ${color["--dw-border"]}`,
    borderRadius: radius["--dw-radius-lg"],
    boxShadow: shadow["--dw-shadow-sm"],
    marginBottom: space["--dw-space-5"]
  },
  input: {
    flex: "1 1 240px",
    padding: `${space["--dw-space-2"]} ${space["--dw-space-3"]}`,
    borderRadius: radius["--dw-radius-md"],
    border: `1px solid ${color["--dw-border"]}`,
    backgroundColor: color["--dw-bg"],
    color: color["--dw-text"],
    fontSize: font["--dw-text-md"]
  },
  select: {
    padding: `${space["--dw-space-2"]} ${space["--dw-space-3"]}`,
    borderRadius: radius["--dw-radius-md"],
    border: `1px solid ${color["--dw-border"]}`,
    backgroundColor: color["--dw-bg"],
    color: color["--dw-text"],
    fontSize: font["--dw-text-sm"]
  },
  submit: {
    padding: `${space["--dw-space-2"]} ${space["--dw-space-4"]}`,
    borderRadius: radius["--dw-radius-md"],
    border: "none",
    backgroundColor: color["--dw-accent"],
    color: color["--dw-on-accent"],
    fontWeight: font["--dw-weight-medium"],
    fontSize: font["--dw-text-sm"],
    cursor: "pointer"
  },
  error: {
    width: "100%",
    margin: 0,
    fontSize: font["--dw-text-sm"],
    color: color["--dw-danger"]
  },
  columns: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: space["--dw-space-4"],
    alignItems: "start"
  },
  column: {
    backgroundColor: color["--dw-surface-muted"],
    border: `1px solid ${color["--dw-border"]}`,
    borderRadius: radius["--dw-radius-lg"],
    padding: space["--dw-space-4"]
  },
  columnHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: space["--dw-space-3"]
  },
  columnTitle: {
    margin: 0,
    fontSize: font["--dw-text-md"],
    fontWeight: font["--dw-weight-semibold"]
  },
  count: {
    fontSize: font["--dw-text-xs"],
    fontWeight: font["--dw-weight-medium"],
    padding: `2px ${space["--dw-space-2"]}`,
    borderRadius: radius["--dw-radius-full"],
    backgroundColor: color["--dw-surface"],
    border: `1px solid ${color["--dw-border"]}`,
    color: color["--dw-text-muted"]
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space["--dw-space-2"],
    minHeight: "48px"
  },
  card: {
    backgroundColor: color["--dw-surface"],
    border: `1px solid ${color["--dw-border"]}`,
    borderRadius: radius["--dw-radius-md"],
    padding: space["--dw-space-3"],
    boxShadow: shadow["--dw-shadow-sm"],
    display: "flex",
    flexDirection: "column",
    gap: space["--dw-space-2"]
  },
  cardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: space["--dw-space-2"]
  },
  cardTitle: {
    fontSize: font["--dw-text-sm"],
    fontWeight: font["--dw-weight-medium"],
    lineHeight: font["--dw-leading-tight"]
  },
  priority: {
    fontSize: font["--dw-text-xs"],
    padding: `1px ${space["--dw-space-2"]}`,
    borderRadius: radius["--dw-radius-full"],
    textTransform: "uppercase"
  },
  priorityLow: {
    backgroundColor: color["--dw-neutral-soft"],
    color: color["--dw-text-muted"]
  },
  priorityMed: {
    backgroundColor: color["--dw-warning-soft"],
    color: color["--dw-warning"]
  },
  priorityHigh: {
    backgroundColor: color["--dw-danger-soft"],
    color: color["--dw-danger"]
  },
  cardActions: {
    display: "flex",
    gap: space["--dw-space-1"],
    flexWrap: "wrap"
  },
  cardBtn: {
    fontSize: font["--dw-text-xs"],
    padding: `2px ${space["--dw-space-2"]}`,
    borderRadius: radius["--dw-radius-sm"],
    border: `1px solid ${color["--dw-border"]}`,
    backgroundColor: color["--dw-surface-raised"],
    color: color["--dw-text-muted"],
    cursor: "pointer"
  },
  deleteBtn: {
    marginLeft: "auto",
    color: color["--dw-danger"]
  }
})

const priorityStyle = (priority: Priority) =>
  priority === "high" ? styles.priorityHigh
    : priority === "med" ? styles.priorityMed
      : styles.priorityLow

export const makeBoardView = () => {
  const hubs = Shared.registry()

  // Late-bound actions reference so card renderers can invoke `move` / `remove`.
  let moveCall: (params: { readonly id: number; readonly column: Column }) => Action = () => Action.raw("")
  let removeCall: (params: { readonly id: number }) => Action = () => Action.raw("")
  let filterExpr = lit("")

  const CardItem = ({ card, id }: { readonly card: Card; readonly id: string }) => {
    const matchFilter = filterExpr.trim().empty().or(lit(card.title.toLowerCase()).includes(filterExpr.trim()))
    return (
      <article id={id} {...stylex.props(styles.card)} $show={matchFilter}>
        <div {...stylex.props(styles.cardTop)}>
          <span {...stylex.props(styles.cardTitle)}>{card.title}</span>
          <span {...stylex.props(styles.priority, priorityStyle(card.priority))}>{card.priority}</span>
        </div>
        <div {...stylex.props(styles.cardActions)}>
          {NEXT_COLUMNS[card.column].map((target) => (
            <button
              key={target}
              type="button"
              {...stylex.props(styles.cardBtn)}
              $on={{ click: moveCall({ id: card.id, column: target }) }}
            >
              {`-> ${COLUMN_LABEL[target]}`}
            </button>
          ))}
          <button
            type="button"
            {...stylex.props(styles.cardBtn, styles.deleteBtn)}
            $on={{ click: Action.confirm(`Delete "${card.title}"?`, removeCall({ id: card.id })) }}
          >
            Delete
          </button>
        </div>
      </article>
    )
  }

  const renderCard = (card: Card, itemId: string) => Html.render(<CardItem card={card} id={itemId} />)
  const renderCount = (count: number, id: string) =>
    Html.render(<span id={id} {...stylex.props(styles.count)}>{count}</span>)

  const todoSlot = Slot.keyed("todo", (c: Card) => c.id, renderCard)
  const doingSlot = Slot.keyed("doing", (c: Card) => c.id, renderCard)
  const doneSlot = Slot.keyed("done", (c: Card) => c.id, renderCard)

  const todoCount = Slot.make("todo-count", renderCount)
  const doingCount = Slot.make("doing-count", renderCount)
  const doneCount = Slot.make("done-count", renderCount)

  // Full columns grid slot for live-view SSE broadcasts across tabs.
  const columnsSlot = Slot.make("columns", (cards: ReadonlyArray<Card>, id: string) => {
    const byCol = (col: Column) => cards.filter((c) => c.column === col)
    return Html.render(
      <section id={id} {...stylex.props(styles.columns)}>
        {COLUMNS.map((col) => {
          const list = byCol(col)
          const listSlot = view.slots[col]
          const countSlot = col === "todo" ? view.slots.todoCount
            : col === "doing" ? view.slots.doingCount
              : view.slots.doneCount
          return (
            <div key={col} {...stylex.props(styles.column)}>
              <div {...stylex.props(styles.columnHeader)}>
                <h2 {...stylex.props(styles.columnTitle)}>{COLUMN_LABEL[col]}</h2>
                <span id={countSlot.id} {...stylex.props(styles.count)}>{list.length}</span>
              </div>
              <div id={listSlot.containerId} {...stylex.props(styles.list)}>
                {list.map((card) => (
                  <CardItem key={card.id} card={card} id={listSlot.itemId(card.id)} />
                ))}
              </div>
            </div>
          )
        })}
      </section>
    )
  })

  const view = View.make("board", {
    signals: BoardSignals,
    slots: {
      todo: todoSlot,
      doing: doingSlot,
      done: doneSlot,
      todoCount,
      doingCount,
      doneCount,
      columns: columnsSlot
    },
    actions: ({ action, slots, patchSignals }) => {
      const countSlotFor = (col: Column) =>
        col === "todo" ? slots.todoCount : col === "doing" ? slots.doingCount : slots.doneCount

      return {
        create: action("POST", "/board/cards", {
          signals: ["title", "column", "priority"] as const,
          handle: ({ signals }) =>
            Effect.gen(function*() {
              const store = yield* BoardStore
              const created = yield* store.create(signals).pipe(Effect.result)
              if (created._tag === "Failure") {
                return [patchSignals({ error: created.failure.message })]
              }
              const card = created.success
              const count = yield* store.countIn(card.column)
              return [
                patchSignals({ title: "", error: "" }),
                slots[card.column].removeItem(card.id),
                slots[card.column].prepend(card),
                countSlotFor(card.column).morph(count)
              ]
            })
        }),

        move: action("POST", "/board/cards/:id/move/:column", {
          handle: ({ params }) =>
            Effect.gen(function*() {
              const id = Number(params.id)
              const to = params.column
              if (!Number.isInteger(id) || !Schema.is(Column)(to)) return []
              const store = yield* BoardStore
              const moved = yield* store.move(id, to)
              if (!moved || moved.from === to) return []
              const fromCount = yield* store.countIn(moved.from)
              const toCount = yield* store.countIn(to)
              return [
                slots[moved.from].removeItem(id),
                slots[to].removeItem(id),
                slots[to].prepend(moved.card),
                countSlotFor(moved.from).morph(fromCount),
                countSlotFor(to).morph(toCount)
              ]
            })
        }),

        remove: action("DELETE", "/board/cards/:id", {
          handle: ({ params }) =>
            Effect.gen(function*() {
              const id = Number(params.id)
              if (!Number.isInteger(id)) return []
              const store = yield* BoardStore
              const removed = yield* store.remove(id)
              if (!removed) return []
              const count = yield* store.countIn(removed.column)
              return [
                slots[removed.column].removeItem(id),
                countSlotFor(removed.column).morph(count)
              ]
            })
        })
      }
    },
    live: ({ live, slots }) =>
      live(
        "/board/live",
        () =>
          Stream.unwrap(
            Effect.gen(function*() {
              const store = yield* BoardStore
              const reactivity = yield* Reactivity.Reactivity
              return Shared.subscribe(
                hubs,
                "board",
                Effect.sync(() => {
                  let latest: ReadonlyArray<Datastar.DatastarEvent> | undefined = undefined
                  const deltas = reactivity.stream(BOARD_KEY, store.list).pipe(
                    Stream.map((cards) => {
                      const events: ReadonlyArray<Datastar.DatastarEvent> = [slots.columns.morph(cards)]
                      latest = events
                      return events
                    })
                  )
                  return {
                    deltas,
                    snapshot: () => latest
                  }
                })
              )
            })
          ),
        { jitter: { min: 1000, max: 2000 } }
      ),
    onSignalsError: () => [Datastar.patchSignals({ board: { error: "Invalid board input." } })]
  })

  // Wire late-bound action/expression helpers for SSR & slot renders.
  moveCall = (params) => view.actions.move.call(params)
  removeCall = (params) => view.actions.remove.call(params)
  filterExpr = view.$.filter

  const renderPage = (cards: ReadonlyArray<Card>): string => {
    const $ = view.$
    const initial = $.init({
      title: "",
      column: "todo",
      priority: "med",
      filter: "",
      error: "",
      _busy: false
    })

    const byCol = (col: Column) => cards.filter((c) => c.column === col)

    const doc = (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Kanban Board — Effect + Datastar</title>
          <link rel="stylesheet" href="/build/app.css" />
          <script type="module" src="/datastar.js" />
        </head>
        <body>
          <main
            {...stylex.props(styles.page)}
            $signals={initial}
            $init={view.live.call()}
          >
            <header {...stylex.props(styles.header)}>
              <h1 {...stylex.props(styles.title)}>Task Board</h1>
              <div {...stylex.props(styles.filterBar)}>
                <input
                  type="search"
                  placeholder="Filter cards..."
                  aria-label="Filter cards"
                  {...stylex.props(styles.filterInput)}
                  $bind={$.filter}
                  $class={{ active: $.filter.nonEmpty() }}
                />
                <span
                  {...stylex.props(styles.filterBadge)}
                  $show={$.filter.trim().nonEmpty()}
                  $text={E`Filter: ${$.filter.trim()}`}
                />
              </div>
            </header>

            <form
              {...stylex.props(styles.composer)}
              $on={{ submit: { run: view.actions.create.call(), prevent: true } }}
              $indicator={$._busy}
            >
              <input
                type="text"
                placeholder="New task title..."
                aria-label="Task title"
                {...stylex.props(styles.input)}
                $bind={$.title}
                $attr={{ "aria-invalid": $.error.nonEmpty() }}
              />
              <select aria-label="Column" {...stylex.props(styles.select)} $bind={$.column}>
                {COLUMNS.map((col) => (
                  <option key={col} value={col}>{COLUMN_LABEL[col]}</option>
                ))}
              </select>
              <select aria-label="Priority" {...stylex.props(styles.select)} $bind={$.priority}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <button
                type="submit"
                {...stylex.props(styles.submit)}
                $attr={{ disabled: $._busy.or($.title.trim().empty()) }}
              >
                Add Card
              </button>
              <p
                role="alert"
                {...stylex.props(styles.error)}
                $show={$.error.nonEmpty()}
                $text={$.error}
              />
            </form>

            <section id={view.slots.columns.id} {...stylex.props(styles.columns)}>
              {COLUMNS.map((col) => {
                const list = byCol(col)
                const listSlot = view.slots[col]
                const countSlot = col === "todo" ? view.slots.todoCount
                  : col === "doing" ? view.slots.doingCount
                    : view.slots.doneCount
                return (
                  <div key={col} {...stylex.props(styles.column)}>
                    <div {...stylex.props(styles.columnHeader)}>
                      <h2 {...stylex.props(styles.columnTitle)}>{COLUMN_LABEL[col]}</h2>
                      <span id={countSlot.id} {...stylex.props(styles.count)}>{list.length}</span>
                    </div>
                    <div id={listSlot.containerId} {...stylex.props(styles.list)}>
                      {list.map((card) => (
                        <CardItem key={card.id} card={card} id={listSlot.itemId(card.id)} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </section>
          </main>
        </body>
      </html>
    )

    return `<!doctype html>${Html.render(doc)}`
  }

  return { view, renderPage, hubs }
}
