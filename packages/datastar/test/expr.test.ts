import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as Endpoint from "../src/Endpoint.ts"
import {
  Action,
  type ActionLike,
  E,
  el,
  evt,
  type ExprLike,
  fromSchema,
  lit,
  raw,
  type SignalLike,
  Signals
} from "../src/Expr.ts"

const UserId = Schema.Number.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

const AppSignals = Schema.Struct({
  login: Schema.Struct({
    email: Schema.String,
    remember: Schema.Boolean
  }),
  query: Schema.Struct({
    page: Schema.Number,
    filter: Schema.String
  }),
  selection: Schema.Array(UserId),
  note: Schema.NullOr(Schema.String),
  matrix: Schema.Array(Schema.Array(Schema.Number))
})

const $ = Signals.from(AppSignals)

describe("Signals.from / fromSchema", () => {
  it("builds a typed signal tree with paths, refs, init, encode, and schema", () => {
    expect($.schema).toBe(AppSignals)
    expect($.login.email.path).toBe("login.email")
    expect($.login.email.toExpr()).toBe("$login.email")
    expect($.login.email.toString()).toBe("$login.email")
    expect($.login.path).toBe("login")
    expect($.selection.path).toBe("selection")
    expect($.path("login.email")).toBe("login.email")

    // Struct fields named like array/string methods (e.g. `filter`) resolve to child signals
    expect($.query.filter.path).toBe("query.filter")
    expect($.query.filter.toExpr()).toBe("$query.filter")
    expect($.query.filter.nonEmpty().toExpr()).toBe("$query.filter.length > 0")

    const initial = {
      login: { email: "ada@acme.test", remember: true },
      query: { page: 1, filter: "" },
      selection: [1 as UserId, 2 as UserId],
      note: null,
      matrix: [[1, 2]]
    }
    expect($.encode(initial)).toEqual(initial)
    expect($.init(initial)).toEqual({ "data-signals": JSON.stringify(initial) })
  })

  it("supports namespaced prefixes via fromSchema", () => {
    const prefixed = fromSchema(Schema.Struct({ count: Schema.Number }), "sidebar.counter")
    expect(prefixed.count.path).toBe("sidebar.counter.count")
    expect(prefixed.count.toExpr()).toBe("$sidebar.counter.count")
    expect(prefixed.encode({ count: 3 })).toEqual({ sidebar: { counter: { count: 3 } } })
    expect(prefixed.init({ count: 3 })).toEqual({
      "data-signals": '{"sidebar":{"counter":{"count":3}}}'
    })
  })

  it("satisfies structural ExprLike, SignalLike, and ActionLike interfaces", () => {
    const exprLike: ExprLike<string> = $.login.email
    const unknownExpr: ExprLike = $.login.email
    const sigLike: SignalLike<string> = $.login.email
    const unknownSig: SignalLike = $.selection
    const actLike: ActionLike = $.login.remember.toggle()

    expect(exprLike.toExpr()).toBe("$login.email")
    expect(unknownExpr.toExpr()).toBe("$login.email")
    expect(sigLike.path).toBe("login.email")
    expect(unknownSig.path).toBe("selection")
    expect(actLike.toExpr()).toBe("$login.remember = !$login.remember")
  })
})

describe("Expr combinators", () => {
  it("compiles universal combinators with safe escaping", () => {
    expect($.login.email.eq('a"b\\c\n').toExpr()).toBe('$login.email === "a\\"b\\\\c\\n"')
    expect($.query.page.neq(1).toExpr()).toBe("$query.page !== 1")
    expect($.note.isNull().toExpr()).toBe("$note == null")
    expect($.note.isNotNull().toExpr()).toBe("$note != null")
  })

  it("compiles boolean combinators with safe parenthesizing", () => {
    expect($.login.remember.not().toExpr()).toBe("!$login.remember")
    expect($.login.remember.and($.query.page.gt(1)).toExpr()).toBe(
      "$login.remember && ($query.page > 1)"
    )
    expect($.login.remember.or(false).not().toExpr()).toBe("!($login.remember || false)")
    expect($.login.remember.ternary("yes", "no").toExpr()).toBe('$login.remember ? "yes" : "no"')
    expect($.query.page.gt(1).ternary($.query.page.sub(1), 1).toExpr()).toBe(
      "($query.page > 1) ? ($query.page - 1) : 1"
    )
  })

  it("compiles number combinators", () => {
    expect($.query.page.gt(0).toExpr()).toBe("$query.page > 0")
    expect($.query.page.gte(1).toExpr()).toBe("$query.page >= 1")
    expect($.query.page.lt(10).toExpr()).toBe("$query.page < 10")
    expect($.query.page.lte(10).toExpr()).toBe("$query.page <= 10")
    expect($.query.page.add(1).toExpr()).toBe("$query.page + 1")
    expect($.query.page.sub(1).toExpr()).toBe("$query.page - 1")
    expect($.query.page.add(1).sub(2).toExpr()).toBe("($query.page + 1) - 2")
  })

  it("compiles string combinators", () => {
    expect($.login.email.nonEmpty().toExpr()).toBe("$login.email.length > 0")
    expect($.login.email.empty().toExpr()).toBe("$login.email.length === 0")
    expect($.login.email.trim().nonEmpty().toExpr()).toBe("$login.email.trim().length > 0")
    expect($.login.email.includes("@").toExpr()).toBe('$login.email.includes("@")')
    expect($.login.email.concat(" (", $.query.page, ")").toExpr()).toBe(
      '$login.email + " (" + $query.page + ")"'
    )
  })

  it("compiles array combinators including nested lambdas", () => {
    const id = 42 as UserId
    expect($.selection.length.toExpr()).toBe("$selection.length")
    expect($.selection.length.gt(0).toExpr()).toBe("$selection.length > 0")
    expect($.selection.includes(id).toExpr()).toBe("$selection.includes(42)")
    expect($.selection.isEmpty().toExpr()).toBe("$selection.length === 0")
    expect($.selection.nonEmpty().toExpr()).toBe("$selection.length > 0")
    expect($.selection.every((x) => x.gt(0)).toExpr()).toBe(
      "$selection.every((_x) => _x > 0)"
    )
    expect($.selection.some((x) => x.eq(id)).toExpr()).toBe(
      "$selection.some((_x) => _x === 42)"
    )
    expect($.selection.filter((x) => x.neq(id)).length.toExpr()).toBe(
      "$selection.filter((_x) => _x !== 42).length"
    )
    expect($.matrix.some((row) => row.every((cell) => cell.gt(0))).toExpr()).toBe(
      "$matrix.some((_x) => _x.every((_x1) => _x1 > 0))"
    )
  })

  it("supports lit() and raw() helpers", () => {
    expect(lit("hi").toExpr()).toBe('"hi"')
    expect(raw<number>("window.innerWidth").gt(640).toExpr()).toBe("(window.innerWidth) > 640")
  })
})

describe("Signal mutations", () => {
  it("compiles set, boolean toggle, number inc/dec, and array mutators", () => {
    const id = 7 as UserId
    expect($.login.email.set("ada@acme.test").toExpr()).toBe('$login.email = "ada@acme.test"')
    expect($.login.email.set(el.value).toExpr()).toBe("$login.email = el.value")
    expect($.login.remember.toggle().toExpr()).toBe("$login.remember = !$login.remember")
    expect($.query.page.inc().toExpr()).toBe("$query.page = $query.page + 1")
    expect($.query.page.inc(5).toExpr()).toBe("$query.page = $query.page + 5")
    expect($.query.page.dec().toExpr()).toBe("$query.page = $query.page - 1")
    expect($.query.page.dec(2).toExpr()).toBe("$query.page = $query.page - 2")

    expect($.selection.push(id).toExpr()).toBe("$selection = [...$selection, 7]")
    expect($.selection.remove(id).toExpr()).toBe("$selection = $selection.filter((_x) => _x !== 7)")
    expect($.selection.clear().toExpr()).toBe("$selection = []")
    expect($.selection.toggle(id).toExpr()).toBe(
      "$selection = $selection.includes(7) ? $selection.filter((_x) => _x !== 7) : [...$selection, 7]"
    )
    expect($.selection.toggle(id, el.checked).toExpr()).toBe(
      "$selection = el.checked ? ($selection.includes(7) ? $selection : [...$selection, 7]) : $selection.filter((_x) => _x !== 7)"
    )
  })
})

describe("E tagged template literal", () => {
  it("compiles interpolated expressions with safe literals", () => {
    expect(E`${$.selection.length} selected`.toExpr()).toBe('$selection.length + " selected"')
    expect(E`Page ${$.query.page.add(1)} of "${$.login.email}"`.toExpr()).toBe(
      '"Page " + ($query.page + 1) + " of \\"" + $login.email + "\\""'
    )
    expect(E`plain text`.toExpr()).toBe('"plain text"')
    expect(E``.toExpr()).toBe('""')
    expect(E`${$.query.page}`.toExpr()).toBe('"" + $query.page')
  })
})

describe("Action combinators", () => {
  it("compiles raw, seq, when, and confirm", () => {
    const a = $.query.page.set(1)
    const b = $.selection.clear()
    expect(Action.raw("@post('/reset')").toExpr()).toBe("@post('/reset')")
    expect(Action.seq(a, undefined, false, null, "", b).toExpr()).toBe(
      "$query.page = 1; $selection = []"
    )
    expect(Action.when($.selection.nonEmpty(), b).toExpr()).toBe(
      "if ($selection.length > 0) { $selection = [] }"
    )
    expect(Action.confirm('Delete "all"?', b).toExpr()).toBe(
      'if (confirm("Delete \\"all\\"?")) { $selection = [] }'
    )
  })
})

describe("DOM helpers (el & evt) and Endpoint integration", () => {
  it("compiles el and evt helpers", () => {
    expect(el.value.toExpr()).toBe("el.value")
    expect(el.value.set("").toExpr()).toBe('el.value = ""')
    expect(el.checked.toExpr()).toBe("el.checked")
    expect(el.checked.set($.selection.nonEmpty()).toExpr()).toBe(
      "el.checked = $selection.length > 0"
    )
    expect(el.indeterminate.toExpr()).toBe("el.indeterminate")
    expect(el.indeterminate.set(true).toExpr()).toBe("el.indeterminate = true")
    expect(el.remove().toExpr()).toBe("el.remove()")

    expect(evt.target.toExpr()).toBe("evt.target")
    expect(evt.target.value.toExpr()).toBe("evt.target.value")
    expect(evt.target.checked.toExpr()).toBe("evt.target.checked")
    expect(evt.key.eq("Enter").toExpr()).toBe('evt.key === "Enter"')
    expect(evt.preventDefault().toExpr()).toBe("evt.preventDefault()")
    expect(evt.stopPropagation().toExpr()).toBe("evt.stopPropagation()")
  })

  it("works with Endpoint.js and Endpoint.call retryInterval", () => {
    const ep = Endpoint.make("DELETE", "/users/:id", Effect.succeed([]))
    expect(ep.call({ id: Endpoint.js($.query.page) }, { retryInterval: 1500 })).toBe(
      "@delete('/users/' + encodeURIComponent($query.page) + '', {retryInterval: 1500})"
    )
  })
})

describe("Type safety", () => {
  it("rejects mismatched types at compile time", () => {
    // @ts-expect-error - string signal has no numeric `gt`
    void (() => $.login.email.gt(0))
    // @ts-expect-error - number signal has no string `trim`
    void (() => $.query.page.trim())
    // @ts-expect-error - cannot set number signal to a string
    void (() => $.query.page.set("nope"))
    // @ts-expect-error - cannot push unbranded number into UserId array
    void (() => $.selection.push(123))
    // @ts-expect-error - boolean signal has no array `push`
    void (() => $.login.remember.push(true))
    expect(true).toBe(true)
  })
})
