/**
 * The `users` resource, composed from the level-2 building blocks.
 *
 *   User (Model)  ──► UserQuery  (signals schema + SQL where/order)
 *                 ──► UserRepo   (makeRepository + list + live + reactivity)
 *                 ──► form fields / draft / errors schemas
 *                 ──► endpoints  (route + typed `@verb(...)` call)
 *                 ──► views      (generic components)
 */
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter } from "effect/http"
import * as Components from "../crud/components.tsx"
import * as Form from "../crud/Form.ts"
import * as Query from "../crud/Query.ts"
import * as Repo from "../crud/Repo.ts"
import * as ds from "../datastar/Attrs.ts"
import * as Datastar from "../datastar/Datastar.ts"
import * as Endpoint from "../datastar/Endpoint.ts"
import { User, UserId } from "./User.ts"

// ---------------------------------------------------------------------------
// Derived schemas
// ---------------------------------------------------------------------------

export const UserQuery = Query.make(User, {
  sortable: ["name", "email", "role", "createdAt"],
  filters: { name: "contains", email: "contains", role: "eq", active: "eq" },
  defaultSort: ["createdAt", "desc"],
  pageSizes: [10, 25, 50]
})

const formFields = Form.fields(User.jsonCreate)
const formKeys = formFields.map((f) => f.key) as Array<keyof typeof User.jsonCreate.fields>
const columns: ReadonlyArray<Components.Column<User>> = Form.fields(User).filter((f) => f.key !== "id").map((field) => ({
  field,
  sortable: (UserQuery.sortable as ReadonlyArray<string>).includes(field.key)
}))

export const UserSignals = ds.make(Schema.Struct({
  users: Schema.Struct({
    query: UserQuery.schema,
    draft: Form.draftSchema(User.jsonCreate),
    errors: Form.errorsSchema(User.jsonCreate),
    dialog: Schema.Boolean
  })
}))

const sig = UserSignals
const initialSignals: typeof UserSignals.schema.Type = {
  users: {
    query: UserQuery.initial,
    draft: Form.blankDraft(User.jsonCreate),
    errors: Form.noErrors(formKeys),
    dialog: false
  }
}

// Each endpoint decodes only the slice of signals it needs.
const QuerySignals = Schema.Struct({ users: Schema.Struct({ query: UserQuery.schema }) })
const DraftSignals = Schema.Struct({ users: Schema.Struct({ draft: Form.draftSchema(User.jsonCreate) }) })
const IdParams = Schema.Struct({ id: Schema.NumberFromString.pipe(Schema.decodeTo(UserId)) })

// ---------------------------------------------------------------------------
// Repository service
// ---------------------------------------------------------------------------

const makeRepo = Repo.make(User, { table: "users", idColumn: "id", query: UserQuery })

export class UserRepo extends Context.Service<UserRepo, Effect.Success<typeof makeRepo>>()("app/UserRepo") {}
export const UserRepoLive = Layer.effect(UserRepo, makeRepo)

// ---------------------------------------------------------------------------
// UI patches (shared by handlers)
// ---------------------------------------------------------------------------

const toast = (message: string, kind: "ok" | "error" = "ok") =>
  Datastar.patchElements(<div id="toast" class={["toast", kind]} safe>{message}</div>)

const closeDialog = Datastar.patchSignals({
  users: { dialog: false, draft: Form.blankDraft(User.jsonCreate), errors: Form.noErrors(formKeys) }
})

/** Map a failed draft decode / constraint violation onto per-field errors. */
const fieldErrors = (errors: Partial<Record<string, string>>) =>
  Datastar.patchSignals({ users: { errors: { ...Form.noErrors(formKeys), ...errors } } })

const unexpected = (error: { readonly _tag: string; readonly message?: string }) =>
  Effect.logError("unexpected failure", error).pipe(
    Effect.as(toast(`Something went wrong (${error._tag})`, "error"))
  )

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Live view. Long-lived SSE stream: re-renders the table whenever the `users`
 * table is mutated (by anyone). When the query signals change, the browser
 * re-issues this request and Datastar aborts the previous stream.
 */
const view = Endpoint.make(
  "GET",
  "/users/view",
  Stream.unwrap(Effect.gen(function*() {
    const repo = yield* UserRepo
    const { users: { query } } = yield* Datastar.signals(QuerySignals)
    return repo.live(query).pipe(
      Stream.map((page) =>
        page.page > page.pages
          // Out of range (e.g. after deleting the last row on the last page): clamp.
          ? Datastar.patchSignals({ users: { query: { page: page.pages } } })
          : Datastar.patchElements(<UserTable page={page} query={query} />)
      )
    )
  })).pipe(
    Stream.catch((error) => Stream.fromEffect(unexpected(error)))
  ),
  { include: [sig.path("users.query")] }
)

const create = Endpoint.make(
  "POST",
  "/users",
  Effect.gen(function*() {
    const repo = yield* UserRepo
    const { users: { draft } } = yield* Datastar.signals(DraftSignals)
    const input = yield* Schema.decodeUnknownEffect(User.jsonCreate)(draft, { errors: "all" })
    const user = yield* repo.insert(User.insert.make(input))
    return [closeDialog, toast(`Created ${user.name}`)]
  }).pipe(
    Effect.catchTags({
      SchemaError: (e) => Effect.succeed(fieldErrors(Form.errors(formKeys, e))),
      SqlError: (e) =>
        e.reason._tag === "UniqueViolation" || e.reason._tag === "ConstraintError"
          ? Effect.succeed(fieldErrors({ email: "Email is already taken" }))
          : unexpected(e),
      SignalsError: unexpected
    })
  ),
  { include: [sig.path("users.draft")] }
)

const update = Endpoint.make(
  "PUT",
  "/users/:id",
  Effect.gen(function*() {
    const repo = yield* UserRepo
    const { id } = yield* HttpRouter.schemaPathParams(IdParams)
    const { users: { draft } } = yield* Datastar.signals(DraftSignals)
    const input = yield* Schema.decodeUnknownEffect(User.jsonUpdate)(draft, { errors: "all" })
    const user = yield* repo.update(User.update.make({ ...input, id }))
    return [closeDialog, toast(`Saved ${user.name}`)]
  }).pipe(
    Effect.catchTags({
      SchemaError: (e) => Effect.succeed(fieldErrors(Form.errors(formKeys, e))),
      SqlError: (e) =>
        e.reason._tag === "UniqueViolation" || e.reason._tag === "ConstraintError"
          ? Effect.succeed(fieldErrors({ email: "Email is already taken" }))
          : unexpected(e),
      SignalsError: unexpected
    })
  ),
  { include: [sig.path("users.draft")] }
)

/** Load a row into the draft and open the dialog. */
const edit = Endpoint.make(
  "GET",
  "/users/:id/edit",
  Effect.gen(function*() {
    const repo = yield* UserRepo
    const { id } = yield* HttpRouter.schemaPathParams(IdParams)
    const user = yield* repo.findById(id)
    const draft = Schema.encodeSync(User.jsonUpdate)(user)
    return Datastar.patchSignals({
      users: { dialog: true, draft: { ...draft, id: user.id }, errors: Form.noErrors(formKeys) }
    })
  }).pipe(
    Effect.catchTags({
      NoSuchElementError: () => Effect.succeed(toast("That user no longer exists", "error")),
      SchemaError: unexpected,
      SqlError: unexpected
    })
  ),
  { include: [] }
)

const remove = Endpoint.make(
  "DELETE",
  "/users/:id",
  Effect.gen(function*() {
    const repo = yield* UserRepo
    const { id } = yield* HttpRouter.schemaPathParams(IdParams)
    yield* repo.delete(id)
    return toast("Deleted")
  }).pipe(
    Effect.catchTags({ SchemaError: unexpected, SqlError: unexpected })
  ),
  { include: [] }
)

export const UserRoutes = HttpRouter.addAll([view.route, create.route, update.route, edit.route, remove.route])

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const UserTable = (props: { readonly page: Repo.Page<User>; readonly query: typeof UserQuery.initial }) => (
  <section id="users-table">
    <Components.Table
      id="users-rows"
      columns={columns}
      rows={props.page.rows}
      rowId={(u) => `user-${u.id}`}
      query={sig.path("users.query")}
      current={props.query}
      actions={(u) => (
        <>
          <button class="link" {...ds.on("click", edit.call({ id: u.id }))}>Edit</button>
          <button
            class="link danger"
            {...ds.on("click", `confirm(${JSON.stringify(`Delete ${u.name}?`)}) && ${remove.call({ id: u.id })}`)}
          >
            Delete
          </button>
        </>
      )}
    />
    <Components.Pagination
      query={sig.path("users.query")}
      page={props.page.page}
      pages={props.page.pages}
      total={props.page.total}
      pageSizes={UserQuery.pageSizes}
    />
  </section>
)

const UserDialog = () => {
  const id = sig.$("users.draft.id")
  return (
    <dialog
      id="user-dialog"
      {...ds.merge(
        ds.attr("open", sig.$("users.dialog")),
        ds.on("keydown", `evt.key === 'Escape' && (${sig.$("users.dialog")} = false)`)
      )}
    >
      <form novalidate {...ds.on("submit", `${id} ? ${update.call({ id: Endpoint.js(id) })} : ${create.call()}`, { prevent: true })}>
        <h2 {...ds.text(`${id} ? 'Edit user' : 'New user'`)} />
        {formFields.map((field) => (
          <Components.FormField field={field} draft={sig.path("users.draft")} errors={sig.path("users.errors")} />
        ))}
        <footer>
          <button type="button" class="secondary" {...ds.on("click", `${sig.$("users.dialog")} = false`)}>Cancel</button>
          <button type="submit">Save</button>
        </footer>
      </form>
    </dialog>
  )
}

/** Full page body. Initial table content arrives over the live stream. */
export const UsersPage = () => (
  <main {...sig.init(initialSignals)}>
    <header class="bar">
      <h1>Users</h1>
      <button
        {...ds.on(
          "click",
          `${sig.$("users.draft")} = ${JSON.stringify(Form.blankDraft(User.jsonCreate))}; ${sig.$("users.errors")} = ${
            JSON.stringify(Form.noErrors(formKeys))
          }; ${sig.$("users.dialog")} = true`
        )}
      >
        New user
      </button>
    </header>
    <Components.FilterBar filters={UserQuery.filters} query={sig.path("users.query")} />
    <div
      id="users-live"
      {...ds.merge(
        ds.init(view.call()),
        ds.onSignalPatch(view.call(), { include: [sig.path("users.query")], debounce: "200ms" })
      )}
    >
      <section id="users-table" aria-busy="true">Loading…</section>
    </div>
    <UserDialog />
    <div id="toast" />
  </main>
)
