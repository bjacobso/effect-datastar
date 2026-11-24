/** @jsxImportSource @effect-datastar/ui */
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import * as stylex from "@stylexjs/stylex"
import { Effect, Schema } from "effect"
import * as Attrs from "@effect-datastar/datastar/Attrs.ts"
import * as Datastar from "@effect-datastar/datastar/Datastar.ts"
import {
  type ActionLike,
  type ExprLike,
  type SignalLike,
  transformProps
} from "@effect-datastar/ui/jsx-runtime"
import { keyedSlot, reactSlot } from "@effect-datastar/ui/Slot.tsx"

// ---------------------------------------------------------------------------
// Test helpers mimicking @effect-datastar/datastar's Expr/Signal/Action DSL
// ---------------------------------------------------------------------------

const FormSchema = Schema.Struct({
  email: Schema.String,
  count: Schema.Number,
  active: Schema.Boolean,
  loading: Schema.Boolean,
  tags: Schema.Array(Schema.String)
})

const formSignals = Attrs.make(FormSchema)

const makeExpr = <A,>(expr: string): ExprLike<A> => ({ toExpr: () => expr })
const makeSignal = <A,>(path: Attrs.SignalPath): SignalLike<A> => ({
  path,
  toExpr: () => `$${path}`
})
const makeAction = (expr: string): ActionLike => ({ toExpr: () => expr })

const $email = makeSignal<string>(formSignals.path("email"))
const $count = makeSignal<number>(formSignals.path("count"))
const $active = makeSignal<boolean>(formSignals.path("active"))
const $loading = makeSignal<boolean>(formSignals.path("loading"))
const $tags = makeSignal<ReadonlyArray<string>>(formSignals.path("tags"))

const styles = stylex.create({
  input: {
    padding: "8px",
    borderRadius: "4px"
  }
})

// ---------------------------------------------------------------------------
// Custom JSX runtime tests
// ---------------------------------------------------------------------------

describe("@effect-datastar/ui jsx-runtime", () => {
  it("compiles $bind, $show, $text, $effect, $init, $indicator, $ignoreMorph with DSL objects", () => {
    const html = renderToStaticMarkup(
      <div
        $show={makeExpr<boolean>("$active && $count > 0")}
        $effect={makeAction("console.log($count)")}
        $init={makeAction("@get('/init')")}
        $indicator={$loading}
        $ignoreMorph
      >
        <input $bind={$email} />
        <span $text={$count} />
      </div>
    )

    expect(html).toContain(`data-show="$active &amp;&amp; $count &gt; 0"`)
    expect(html).toContain(`data-effect="console.log($count)"`)
    expect(html).toContain(`data-init="@get(&#x27;/init&#x27;)"`)
    expect(html).toContain(`data-indicator="loading"`)
    expect(html).toContain(`data-ignore-morph=""`)
    expect(html).toContain(`data-bind="email"`)
    expect(html).toContain(`data-text="$count"`)
    expect(html).not.toContain("$bind")
    expect(html).not.toContain("$show")
    expect(html).not.toContain("$ignoreMorph")
  })

  it("omits data-ignore-morph when $ignoreMorph is false", () => {
    const html = renderToStaticMarkup(<div $ignoreMorph={false}>hello</div>)
    expect(html).toBe("<div>hello</div>")
  })

  it("compiles $bind, $show, $text, $effect, $init, $indicator with raw strings and SignalPath", () => {
    const html = renderToStaticMarkup(
      <div
        $show="$active"
        $text="$email"
        $effect="el.focus()"
        $init="@get('/boot')"
        $indicator={formSignals.path("loading")}
      >
        <input $bind={formSignals.path("email")} />
      </div>
    )

    expect(html).toContain(`data-show="$active"`)
    expect(html).toContain(`data-text="$email"`)
    expect(html).toContain(`data-effect="el.focus()"`)
    expect(html).toContain(`data-init="@get(&#x27;/boot&#x27;)"`)
    expect(html).toContain(`data-indicator="loading"`)
    expect(html).toContain(`data-bind="email"`)
  })

  it("compiles $signals from both plain objects and Signals.init() Attrs", () => {
    const fromPlain = renderToStaticMarkup(
      <div $signals={{ email: "a@b.com", count: 1 }} />
    )
    expect(fromPlain).toBe(
      `<div data-signals="{&quot;email&quot;:&quot;a@b.com&quot;,&quot;count&quot;:1}"></div>`
    )

    const fromInit = renderToStaticMarkup(
      <div $signals={formSignals.init({ email: "x@y.com", count: 2, active: true, loading: false, tags: [] })} />
    )
    expect(fromInit).toBe(
      `<div data-signals="{&quot;email&quot;:&quot;x@y.com&quot;,&quot;count&quot;:2,&quot;active&quot;:true,&quot;loading&quot;:false,&quot;tags&quot;:[]}"></div>`
    )
  })

  it("compiles $on events with modifiers and direct handlers", () => {
    const html = renderToStaticMarkup(
      <form
        $on={{
          submit: { run: makeAction("@post('/save')"), prevent: true },
          keydown: { run: "$open = false", window: true, stop: true, once: true }
        }}
      >
        <input
          $on={{
            input: { run: makeAction("@get('/search')"), debounce: "250ms" },
            scroll: { run: "onScroll()", throttle: "100ms" },
            click: makeAction("$count++"),
            blur: "$touched = true"
          }}
        />
      </form>
    )

    expect(html).toContain(`data-on:submit__prevent="@post(&#x27;/save&#x27;)"`)
    expect(html).toContain(`data-on:keydown__stop__window__once="$open = false"`)
    expect(html).toContain(`data-on:input__debounce.250ms="@get(&#x27;/search&#x27;)"`)
    expect(html).toContain(`data-on:scroll__throttle.100ms="onScroll()"`)
    expect(html).toContain(`data-on:click="$count++"`)
    expect(html).toContain(`data-on:blur="$touched = true"`)
  })

  it("compiles $onSignalPatch with filter regex and modifiers", () => {
    const html = renderToStaticMarkup(
      <div
        $onSignalPatch={{
          include: [$email, formSignals.path("count")],
          run: makeAction("@get('/sync')"),
          debounce: "200ms"
        }}
      />
    )

    expect(html).toContain(`data-on-signal-patch__debounce.200ms="@get(&#x27;/sync&#x27;)"`)
    expect(html).toContain(`data-on-signal-patch-filter="{include: /^(email|count)(\\.|$)/}"`)
  })

  it("compiles $attr and $class maps", () => {
    const html = renderToStaticMarkup(
      <button
        $attr={{
          "aria-invalid": makeExpr<boolean>("!$email"),
          "aria-busy": "$loading"
        }}
        $class={{
          active: $active,
          muted: "!$active"
        }}
      >
        Save
      </button>
    )

    expect(html).toContain(`data-attr:aria-invalid="!$email"`)
    expect(html).toContain(`data-attr:aria-busy="$loading"`)
    expect(html).toContain(`data-class:active="$active"`)
    expect(html).toContain(`data-class:muted="!$active"`)
  })

  it("renders regular HTML elements identically and fast-paths props with no $ keys", () => {
    const html = renderToStaticMarkup(
      <section id="plain" className="box" data-custom="ok">
        <h1>Title</h1>
        <p>Body</p>
      </section>
    )
    expect(html).toBe(`<section id="plain" class="box" data-custom="ok"><h1>Title</h1><p>Body</p></section>`)

    const plainProps = { id: "plain", className: "box", children: "hi" }
    expect(transformProps("div", plainProps)).toBe(plainProps)

    const Custom = ({ $show }: { readonly $show: string }) => <span>{$show}</span>
    const componentProps = { $show: "not-compiled" }
    expect(transformProps(Custom, componentProps)).toBe(componentProps)
    expect(renderToStaticMarkup(<Custom $show="kept" />)).toBe("<span>kept</span>")
  })

  it("coexists cleanly with StyleX {...stylex.props(...)}", () => {
    const html = renderToStaticMarkup(
      <input
        {...stylex.props(styles.input)}
        type="email"
        $bind={$email}
        $attr={{ "aria-invalid": makeExpr<boolean>("!$email") }}
      />
    )

    expect(html).toContain(`class="`)
    expect(html).toContain(`type="email"`)
    expect(html).toContain(`data-bind="email"`)
    expect(html).toContain(`data-attr:aria-invalid="!$email"`)
  })

  it("enforces type safety on $ props", () => {
    // Valid usages
    const _ok = (
      <>
        <input $bind={$email} />
        <input $bind={$count} />
        <input $bind={$active} />
        <div $show={$active} />
        <span $text={$count} />
        <div $indicator={$loading} />
        <div $class={{ active: $active }} />
      </>
    )
    expect(_ok).toBeDefined()

    // Invalid $bind: array signal is not string | number | boolean
    // @ts-expect-error ReadonlyArray<string> is not bindable
    const _badBindArr = <input $bind={$tags} />

    // Invalid $bind: raw unbranded string is not a SignalPath
    // @ts-expect-error raw string is not a SignalPath
    const _badBindRaw = <input $bind="email" />

    // Invalid $show: number expr is not boolean
    // @ts-expect-error ExprLike<number> is not assignable to ExprLike<boolean> | string
    const _badShow = <div $show={$count} />

    // Invalid $indicator: string signal is not boolean
    // @ts-expect-error SignalLike<string> is not assignable to SignalLike<boolean> | SignalPath
    const _badIndicator = <div $indicator={$email} />

    // Invalid $class: number expr is not boolean
    // @ts-expect-error ExprLike<number> is not assignable to ExprLike<boolean> | string
    const _badClass = <div $class={{ active: $count }} />

    // Invalid $text: array signal is not string | number | boolean
    // @ts-expect-error SignalLike<ReadonlyArray<string>> is not assignable to ExprLike<string | number | boolean> | string
    const _badText = <span $text={$tags} />

    expect([_badBindArr, _badBindRaw, _badShow, _badIndicator, _badClass, _badText]).toHaveLength(6)
  })
})

// ---------------------------------------------------------------------------
// Slot.tsx tests
// ---------------------------------------------------------------------------

describe("@effect-datastar/ui Slot", () => {
  it("reactSlot renders <Mount /> with auto-attached id and emits patchElements", async () => {
    const Counter = reactSlot("counter", ({ count }: { readonly count: number }) => (
      <div $text="$count">Count: {count}</div>
    ))

    expect(Counter.id).toBe("counter")
    expect(Counter.selector).toBe("#counter")
    expect(renderToStaticMarkup(<Counter.Mount count={3} />)).toBe(
      `<div data-text="$count" id="counter">Count: 3</div>`
    )

    const morphEvent = Counter.morph({ count: 4 })
    const morphSse = await Effect.runPromise(Datastar.encodeEvent(morphEvent))
    expect(morphSse).toContain("event: datastar-patch-elements\n")
    expect(morphSse).toContain("data: selector #counter\n")
    expect(morphSse).toContain(`data: elements <div data-text="$count" id="counter">Count: 4</div>\n`)

    const prependEvent = Counter.prepend({ count: 5 })
    const prependSse = await Effect.runPromise(Datastar.encodeEvent(prependEvent))
    expect(prependSse).toContain("data: selector #counter\n")
    expect(prependSse).toContain("data: mode prepend\n")
    expect(prependSse).toContain(`data: elements <div data-text="$count">Count: 5</div>\n`)

    const appendEvent = Counter.append({ count: 6 }, { useViewTransition: true })
    const appendSse = await Effect.runPromise(Datastar.encodeEvent(appendEvent))
    expect(appendSse).toContain("data: selector #counter\n")
    expect(appendSse).toContain("data: mode append\n")
    expect(appendSse).toContain("data: useViewTransition true\n")

    const removeEvent = Counter.remove()
    const removeSse = await Effect.runPromise(Datastar.encodeEvent(removeEvent))
    expect(removeSse).toContain("data: selector #counter\n")
    expect(removeSse).toContain("data: mode remove\n")
    expect(removeSse).not.toContain("data: elements")
  })

  it("reactSlot supports zero-prop components and preserves explicit root id", () => {
    const Empty = reactSlot("empty-state", () => <p id="empty-state">Nothing here</p>)
    expect(renderToStaticMarkup(<Empty.Mount />)).toBe(`<p id="empty-state">Nothing here</p>`)
    const ev = Empty.morph()
    expect(ev._tag).toBe("PatchElements")
    if (ev._tag === "PatchElements") {
      expect(ev.elements).toBe(`<p id="empty-state">Nothing here</p>`)
      expect(ev.selector).toBe("#empty-state")
    }
  })

  it("keyedSlot renders keyed items and supports morph, prepend, append, and remove by key or props", async () => {
    interface Todo {
      readonly id: number
      readonly title: string
    }

    const TodoRow = keyedSlot(
      "todo",
      ({ todo }: { readonly todo: Todo }) => todo.id,
      ({ todo }: { readonly todo: Todo }) => <li>{todo.title}</li>
    )

    const item: Todo = { id: 42, title: "Ship JSX runtime" }

    expect(TodoRow.idForKey(42)).toBe("todo-42")
    expect(TodoRow.idOf({ todo: item })).toBe("todo-42")
    expect(TodoRow.selectorForKey(42)).toBe("#todo-42")
    expect(TodoRow.selectorOf({ todo: item })).toBe("#todo-42")
    expect(renderToStaticMarkup(<TodoRow.Mount todo={item} />)).toBe(
      `<li id="todo-42">Ship JSX runtime</li>`
    )

    const morphSse = await Effect.runPromise(Datastar.encodeEvent(TodoRow.morph({ todo: item })))
    expect(morphSse).toContain("data: selector #todo-42\n")
    expect(morphSse).toContain("data: elements <li id=\"todo-42\">Ship JSX runtime</li>\n")

    const appendSse = await Effect.runPromise(
      Datastar.encodeEvent(TodoRow.append("#todo-list", { todo: item }))
    )
    expect(appendSse).toContain("data: selector #todo-list\n")
    expect(appendSse).toContain("data: mode append\n")
    expect(appendSse).toContain("data: elements <li id=\"todo-42\">Ship JSX runtime</li>\n")

    const prependSse = await Effect.runPromise(
      Datastar.encodeEvent(TodoRow.prepend("#todo-list", { todo: item }))
    )
    expect(prependSse).toContain("data: selector #todo-list\n")
    expect(prependSse).toContain("data: mode prepend\n")

    const removeByKey = await Effect.runPromise(Datastar.encodeEvent(TodoRow.remove(42)))
    expect(removeByKey).toContain("data: selector #todo-42\n")
    expect(removeByKey).toContain("data: mode remove\n")

    const removeByProps = await Effect.runPromise(Datastar.encodeEvent(TodoRow.remove({ todo: item })))
    expect(removeByProps).toContain("data: selector #todo-42\n")
    expect(removeByProps).toContain("data: mode remove\n")
  })
})
