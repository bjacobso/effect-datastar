/**
 * The `teams` resource. Same building blocks as `users`; the interesting part is
 * the relation: users reference teams, so
 *   - deleting a team with members is rejected by the FK and shown as a toast
 *   - renaming/creating/deleting a team invalidates `teams`, which the users
 *     live view also listens to (team names in the table, team selects)
 */
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter } from "effect/http"
import * as Components from "../crud/components.tsx"
import { toast, unexpected } from "../crud/Feedback.tsx"
import * as Form from "../crud/Form.ts"
import * as Lookup from "../crud/Lookup.ts"
import * as Query from "../crud/Query.ts"
import * as Repo from "../crud/Repo.ts"
import * as ds from "../datastar/Attrs.ts"
import * as Datastar from "../datastar/Datastar.ts"
import * as Endpoint from "../datastar/Endpoint.ts"
import { Team, TeamId } from "./Team.ts"

// ---------------------------------------------------------------------------
// Derived schemas
// ---------------------------------------------------------------------------

export const TeamQuery = Query.make(Team, {
  sortable: ["name", "createdAt"],
  filters: { name: "contains" },
  defaultSort: ["name", "asc"],
  pageSizes: [10, 25, 50]
})

const formFields = Form.fields(Team.jsonCreate)
const formKeys = formFields.map((f) => f.key) as Array<keyof typeof Team.jsonCreate.fields>
const columns: ReadonlyArray<Components.Column<Team>> = Form.fields(Team).filter((f) => f.key !== "id").map((field) => ({
  field,
  sortable: (TeamQuery.sortable as ReadonlyArray<string>).includes(field.key)
}))

export const TeamSignals = ds.make(Schema.Struct({
  teams: Schema.Struct({
    query: TeamQuery.schema,
    draft: Form.draftSchema(Team.jsonCreate),
    errors: Form.errorsSchema(Team.jsonCreate),
    dialog: Schema.Boolean
  })
}))
const sig = TeamSignals

const blankDraft = Form.blankDraft(Team.jsonCreate)
const noErrors = Form.noErrors(formKeys)

const QuerySignals = Schema.Struct({ teams: Schema.Struct({ query: TeamQuery.schema }) })
const DraftSignals = Schema.Struct({ teams: Schema.Struct({ draft: Form.draftSchema(Team.jsonCreate) }) })
const IdParams = Schema.Struct({ id: Schema.NumberFromString.pipe(Schema.decodeTo(TeamId)) })

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const makeRepo = Repo.make(Team, { table: "teams", idColumn: "id", query: TeamQuery })
export class TeamRepo extends Context.Service<TeamRepo, Effect.Success<typeof makeRepo>>()("app/TeamRepo") {}
export const TeamRepoLive = Layer.effect(TeamRepo, makeRepo)

/** Team options for other resources' selects/filters/labels. */
const makeLookup = Lookup.make({ table: "teams", value: "id", label: "name" })
export class TeamLookup extends Context.Service<TeamLookup, Lookup.Lookup>()("app/TeamLookup") {}
export const TeamLookupLive = Layer.effect(TeamLookup, makeLookup)

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const closeDialog = Datastar.patchSignals({ teams: { dialog: false, draft: blankDraft, errors: noErrors } })
const fieldErrors = (errors: Partial<Record<string, string>>) =>
  Datastar.patchSignals({ teams: { errors: { ...noErrors, ...errors } } })

const view = Endpoint.make(
  "GET",
  "/teams/view",
  Stream.unwrap(Effect.gen(function*() {
    const repo = yield* TeamRepo
    const { teams: { query } } = yield* Datastar.signals(QuerySignals)
    return repo.live(query).pipe(
      Stream.map((page) =>
        page.page > page.pages
          ? Datastar.patchSignals({ teams: { query: { page: page.pages } } })
          : Datastar.patchElements(<TeamTable page={page} query={query} />)
      )
    )
  })).pipe(Stream.catch((error) => Stream.fromEffect(unexpected(error)))),
  { include: [sig.path("teams.query")] }
)

const save = (id?: TeamId) =>
  Effect.gen(function*() {
    const repo = yield* TeamRepo
    const { teams: { draft } } = yield* Datastar.signals(DraftSignals)
    const team = id === undefined
      ? yield* repo.insert(Team.insert.make(yield* Form.decode(Team.jsonCreate, draft)))
      : yield* repo.update(Team.update.make({ ...(yield* Form.decode(Team.jsonUpdate, draft)), id }))
    return [closeDialog, toast(`${id === undefined ? "Created" : "Saved"} ${team.name}`)]
  }).pipe(
    Effect.catchTags({
      SchemaError: (e) => Effect.succeed(fieldErrors(Form.errors(formKeys, e))),
      SqlError: (e) =>
        e.reason._tag === "UniqueViolation" || e.reason._tag === "ConstraintError"
          ? Effect.succeed(fieldErrors({ name: "A team with that name already exists" }))
          : unexpected(e),
      SignalsError: unexpected
    })
  )

const create = Endpoint.make("POST", "/teams", save(), { include: [sig.path("teams.draft")] })

const update = Endpoint.make(
  "PUT",
  "/teams/:id",
  Effect.flatMap(HttpRouter.schemaPathParams(IdParams), ({ id }) => save(id)).pipe(
    Effect.catchTag("SchemaError", unexpected)
  ),
  { include: [sig.path("teams.draft")] }
)

const edit = Endpoint.make(
  "GET",
  "/teams/:id/edit",
  Effect.gen(function*() {
    const repo = yield* TeamRepo
    const { id } = yield* HttpRouter.schemaPathParams(IdParams)
    const team = yield* repo.findById(id)
    return Datastar.patchSignals({
      teams: { dialog: true, draft: Form.toDraft(Team.jsonUpdate, team, team.id), errors: noErrors }
    })
  }).pipe(
    Effect.catchTags({
      NoSuchElementError: () => Effect.succeed(toast("That team no longer exists", "error")),
      SchemaError: unexpected,
      SqlError: unexpected
    })
  ),
  { include: [] }
)

const remove = Endpoint.make(
  "DELETE",
  "/teams/:id",
  Effect.gen(function*() {
    const repo = yield* TeamRepo
    const { id } = yield* HttpRouter.schemaPathParams(IdParams)
    yield* repo.delete(id)
    return toast("Deleted")
  }).pipe(
    Effect.catchTags({
      SqlError: (e) =>
        e.reason._tag === "ConstraintError"
          ? Effect.succeed(toast("This team still has members. Move them first.", "error"))
          : unexpected(e),
      SchemaError: unexpected
    })
  ),
  { include: [] }
)

export const TeamRoutes = HttpRouter.addAll([view.route, create.route, update.route, edit.route, remove.route])

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const TeamTable = (props: { readonly page: Repo.Page<Team>; readonly query: typeof TeamQuery.initial }) => (
  <section id="teams-table">
    <Components.Table
      id="teams-rows"
      columns={columns}
      rows={props.page.rows}
      rowId={(t) => `team-${t.id}`}
      query={sig.path("teams.query")}
      current={props.query}
      actions={(t) => (
        <>
          <button class="link" {...ds.on("click", edit.call({ id: t.id }))}>Edit</button>
          <button
            class="link danger"
            {...ds.on("click", `confirm(${JSON.stringify(`Delete ${t.name}?`)}) && ${remove.call({ id: t.id })}`)}
          >
            Delete
          </button>
        </>
      )}
    />
    <Components.Pagination
      query={sig.path("teams.query")}
      page={props.page.page}
      pages={props.page.pages}
      total={props.page.total}
      pageSizes={TeamQuery.pageSizes}
    />
  </section>
)

export const TeamsPage = () => (
  <main
    {...sig.init({ teams: { query: TeamQuery.initial, draft: blankDraft, errors: noErrors, dialog: false } })}
  >
    <header class="bar">
      <h1>Teams</h1>
      <button
        {...ds.on(
          "click",
          `${sig.$("teams.draft")} = ${JSON.stringify(blankDraft)}; ${sig.$("teams.errors")} = ${
            JSON.stringify(noErrors)
          }; ${sig.$("teams.dialog")} = true`
        )}
      >
        New team
      </button>
    </header>
    <Components.FilterBar prefix="teams" filters={TeamQuery.filters} query={sig.path("teams.query")} />
    <div
      id="teams-live"
      {...ds.merge(
        ds.init(view.call()),
        ds.onSignalPatch(view.call(), { include: [sig.path("teams.query")], debounce: "200ms" })
      )}
    >
      <section id="teams-table" aria-busy="true">Loading…</section>
    </div>
    <Components.FormDialog
      prefix="teams"
      noun="team"
      fields={formFields}
      draft={sig.path("teams.draft")}
      errors={sig.path("teams.errors")}
      open={sig.path("teams.dialog")}
      submit={`${sig.$("teams.draft.id")} ? ${update.call({ id: Endpoint.js(sig.$("teams.draft.id")) })} : ${create.call()}`}
    />
    <Components.Toast />
  </main>
)
