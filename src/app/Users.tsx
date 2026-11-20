/**
 * The `users` resource, composed from the level-2 building blocks.
 *
 *   User (Model)  ──► UserQuery  (signals schema + SQL where/order)
 *                 ──► UserRepo   (makeRepository + list + reactivity)
 *                 ──► form fields / draft / errors schemas
 *                 ──► endpoints  (route + typed `@verb(...)` call)
 *                 ──► views      (generic components)
 *
 * Relation: `teamId -> teams`. Team options come from `TeamLookup`, and the live
 * view listens to both `users` and `teams`, so renaming a team re-renders the
 * table and the team selects in every open tab.
 */
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter } from "effect/http"
import { Reactivity } from "effect/reactivity"
import * as Components from "../crud/components.tsx"
import { toast, unexpected } from "../crud/Feedback.tsx"
import * as Form from "../crud/Form.ts"
import * as Lookup from "../crud/Lookup.ts"
import * as Query from "../crud/Query.ts"
import * as Repo from "../crud/Repo.ts"
import * as ds from "../datastar/Attrs.ts"
import * as Datastar from "../datastar/Datastar.ts"
import * as Endpoint from "../datastar/Endpoint.ts"
import { TeamLookup } from "./Teams.tsx"
import { User, UserId } from "./User.ts"

// ---------------------------------------------------------------------------
// Derived schemas
// ---------------------------------------------------------------------------

export const UserQuery = Query.make(User, {
  sortable: ["name", "email", "role", "createdAt"],
  filters: { name: "contains", email: "contains", role: "eq", teamId: "eq", active: "eq" },
  defaultSort: ["createdAt", "desc"],
  pageSizes: [10, 25, 50]
})

const formFields = Form.fields(User.jsonCreate)
const formKeys = formFields.map((f) => f.key) as Array<keyof typeof User.jsonCreate.fields>
const tableFields = Form.fields(User).filter((f) => f.key !== "id")
/** Fields whose options come from a lookup rather than the schema. */
const relationKeys = ["teamId"] as const

export const UserSignals = ds.make(Schema.Struct({
  users: Schema.Struct({
    query: UserQuery.schema,
    draft: Form.draftSchema(User.jsonCreate),
    errors: Form.errorsSchema(User.jsonCreate),
    dialog: Schema.Boolean
  })
}))
const sig = UserSignals

const blankDraft = Form.blankDraft(User.jsonCreate)
const noErrors = Form.noErrors(formKeys)

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
// Endpoints
// ---------------------------------------------------------------------------

const closeDialog = Datastar.patchSignals({ users: { dialog: false, draft: blankDraft, errors: noErrors } })
const fieldErrors = (errors: Partial<Record<string, string>>) =>
  Datastar.patchSignals({ users: { errors: { ...noErrors, ...errors } } })

/**
 * Live view. Long-lived SSE stream that re-runs when `users` OR `teams` change.
 * Selects whose options come from the team lookup are replaced only when the
 * options actually changed (and on the first emission, since the page shell
 * is rendered without them).
 */
const view = Endpoint.make(
  "GET",
  "/users/view",
  Stream.unwrap(Effect.gen(function*() {
    const repo = yield* UserRepo
    const teams = yield* TeamLookup
    const reactivity = yield* Reactivity.Reactivity
    const { users: { query } } = yield* Datastar.signals(QuerySignals)
    let lastOptions: string | undefined
    return reactivity.stream(["users", teams.table], Effect.all([repo.list(query), teams.options])).pipe(
      Stream.map(([page, teamOptions]): Datastar.Events => {
        if (page.page > page.pages) {
          // Out of range (e.g. after deleting the last row on the last page): clamp.
          return Datastar.patchSignals({ users: { query: { page: page.pages } } })
        }
        const lookups: Components.Lookups = { teamId: teamOptions }
        const events = [Datastar.patchElements(<UserTable page={page} query={query} lookups={lookups} />)]
        const key = JSON.stringify(teamOptions)
        if (key !== lastOptions) {
          lastOptions = key
          events.push(...relationSelects(lookups))
        }
        return events
      })
    )
  })).pipe(
    Stream.catch((error) => Stream.fromEffect(unexpected(error)))
  ),
  { include: [sig.path("users.query")] }
)

const save = (id?: UserId) =>
  Effect.gen(function*() {
    const repo = yield* UserRepo
    const { users: { draft } } = yield* Datastar.signals(DraftSignals)
    const user = id === undefined
      ? yield* repo.insert(User.insert.make(yield* Form.decode(User.jsonCreate, draft)))
      : yield* repo.update(User.update.make({ ...(yield* Form.decode(User.jsonUpdate, draft)), id }))
    return [closeDialog, toast(`${id === undefined ? "Created" : "Saved"} ${user.name}`)]
  }).pipe(
    Effect.catchTags({
      SchemaError: (e) => Effect.succeed(fieldErrors(Form.errors(formKeys, e))),
      SqlError: (e) =>
        e.reason._tag === "UniqueViolation"
          ? Effect.succeed(fieldErrors({ email: "Email is already taken" }))
          : e.reason._tag === "ConstraintError"
          // FK violation: the chosen team was deleted while the dialog was open.
          ? Effect.succeed(fieldErrors({ teamId: "That team no longer exists" }))
          : unexpected(e),
      SignalsError: unexpected
    })
  )

const create = Endpoint.make("POST", "/users", save(), { include: [sig.path("users.draft")] })

const update = Endpoint.make(
  "PUT",
  "/users/:id",
  Effect.flatMap(HttpRouter.schemaPathParams(IdParams), ({ id }) => save(id)).pipe(
    Effect.catchTag("SchemaError", unexpected)
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
    return Datastar.patchSignals({
      users: { dialog: true, draft: Form.toDraft(User.jsonUpdate, user, user.id), errors: noErrors }
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

const columnsFor = (lookups: Components.Lookups): ReadonlyArray<Components.Column<User>> => {
  const teamNames = Lookup.labels(lookups["teamId"] ?? [])
  return tableFields.map((field) => ({
    field,
    sortable: (UserQuery.sortable as ReadonlyArray<string>).includes(field.key),
    render: field.key === "teamId"
      ? (u: User) => <span safe>{u.teamId === null ? "—" : teamNames.get(String(u.teamId)) ?? "?"}</span>
      : undefined
  }))
}

/** `mode: "replace"` gives a fresh element, so `data-bind` re-applies the current signal value. */
const relationSelects = (lookups: Components.Lookups): Array<Datastar.DatastarEvent> =>
  relationKeys.flatMap((key) => {
    const filter = UserQuery.filters.find((f) => f.key === key)
    const field = formFields.find((f) => f.key === key)
    return [
      ...(filter
        ? [
          Datastar.patchElements(
            <Components.FilterSelect prefix="users" filter={filter} query={sig.path("users.query")} lookup={lookups[key]} />,
            { selector: `#${Components.filterId("users", key)}`, mode: "replace" }
          )
        ]
        : []),
      ...(field
        ? [
          Datastar.patchElements(
            <Components.FieldSelect
              prefix="users"
              field={field}
              draft={sig.path("users.draft")}
              errors={sig.path("users.errors")}
              lookup={lookups[key]}
            />,
            { selector: `#${Components.fieldId("users", key)}`, mode: "replace" }
          )
        ]
        : [])
    ]
  })

const UserTable = (props: {
  readonly page: Repo.Page<User>
  readonly query: typeof UserQuery.initial
  readonly lookups: Components.Lookups
}) => (
  <section id="users-table">
    <Components.Table
      id="users-rows"
      columns={columnsFor(props.lookups)}
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

/** Page shell. Table content and team options arrive over the live stream. */
export const UsersPage = () => (
  <main
    {...sig.init({ users: { query: UserQuery.initial, draft: blankDraft, errors: noErrors, dialog: false } })}
  >
    <header class="bar">
      <h1>Users</h1>
      <button
        {...ds.on(
          "click",
          `${sig.$("users.draft")} = ${JSON.stringify(blankDraft)}; ${sig.$("users.errors")} = ${
            JSON.stringify(noErrors)
          }; ${sig.$("users.dialog")} = true`
        )}
      >
        New user
      </button>
    </header>
    <Components.FilterBar prefix="users" filters={UserQuery.filters} query={sig.path("users.query")} />
    <div
      id="users-live"
      {...ds.merge(
        ds.init(view.call()),
        ds.onSignalPatch(view.call(), { include: [sig.path("users.query")], debounce: "200ms" })
      )}
    >
      <section id="users-table" aria-busy="true">Loading…</section>
    </div>
    <Components.FormDialog
      prefix="users"
      noun="user"
      fields={formFields}
      draft={sig.path("users.draft")}
      errors={sig.path("users.errors")}
      open={sig.path("users.dialog")}
      submit={`${sig.$("users.draft.id")} ? ${update.call({ id: Endpoint.js(sig.$("users.draft.id")) })} : ${create.call()}`}
    />
    <Components.Toast />
  </main>
)
