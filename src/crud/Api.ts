/**
 * A JSON API derived from a resource: an `HttpApiGroup` with list, get,
 * create, update and delete, implemented over the resource's `Repo`.
 *
 *   const UsersApi = Api.make(Resources.resources.users)   // from `Resource.app(...)`
 *   const AppApi = HttpApi.make("app").add(UsersApi.group).add(TeamsApi.group).prefix("/api")
 *
 *   HttpApiBuilder.layer(AppApi, { openapiPath: "/api/openapi.json" }).pipe(
 *     Layer.provide([UsersApi.layer(AppApi), TeamsApi.layer(AppApi)])
 *   )
 *
 * | Endpoint            | Success                              | Errors        |
 * | ------------------- | ------------------------------------ | ------------- |
 * | `GET    /users`     | `{ rows, total, page, pages }`       | 400           |
 * | `GET    /users/:id` | the row                              | 400, 404      |
 * | `POST   /users`     | 201, the row                         | 400, 409      |
 * | `PUT    /users/:id` | the row                              | 400, 404, 409 |
 * | `DELETE /users/:id` | 204                                  | 400, 404, 409 |
 *
 * - The list takes the URL-state params (`page`, `pageSize`, `sort`, `dir`,
 *   one per filter, e.g. `?role=admin&teamId=null&sort=name&dir=asc`),
 *   validated with the same per-field schemas as the live view's signals. The
 *   page is lenient about bad params; the API answers 400.
 * - Bodies are the model's `jsonCreate` / `jsonUpdate` (an update replaces
 *   every editable field, like the edit dialog). Rows are the model's `json`.
 * - 400 is a `ValidationError` with one message per field or param (all of
 *   them, not just the first), 404 a `NotFound`, 409 a `Conflict` for unique
 *   and foreign key violations, with the resource's `messages`.
 * - Mutations go through the `Repo`, so every live view (in every process)
 *   updates as it does for the HTML forms.
 */
import { Effect, Layer, Schema, SchemaIssue } from "effect"
import type * as Cause from "effect/Cause"
import type * as Context from "effect/Context"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema } from "effect/http-api"
import type { HttpApiError } from "effect/http-api"
import type { SqlError } from "effect/sql"
import type * as Query from "./Query.ts"
import type * as Repo from "./Repo.ts"
import type { Messages, ModelLike, RepoOf } from "./Resource.tsx"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** 404: no row with that id. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String
}, { httpApiStatus: 404 }) {}

/** 400: the request didn't decode. `fields` has the first message per field (body) or param (path, query). */
export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String,
  fields: Schema.Record(Schema.String, Schema.String)
}, { httpApiStatus: 400 }) {}

/** 409: a unique or foreign key constraint rejected the change. `fields` names the offending field, if known. */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
  fields: Schema.Record(Schema.String, Schema.String)
}, { httpApiStatus: 409 }) {}

// ---------------------------------------------------------------------------
// Request validation: decoding failures as per-field 400s
// ---------------------------------------------------------------------------

/** Turns request decoding failures into a `ValidationError` (otherwise they are an empty 400). */
export class Validation extends HttpApiMiddleware.Service<Validation>()("effect-datastar/crud/Api/Validation", {
  error: ValidationError
}) {}

const formatter = SchemaIssue.makeFormatterStandardSchemaV1()

const toValidationError = (error: HttpApiError.HttpApiSchemaError): ValidationError => {
  const fields: Record<string, string> = {}
  const general: Array<string> = []
  for (const issue of formatter(error.cause.issue).issues) {
    const head = issue.path?.[0]
    const key = typeof head === "object" && head !== null ? head.key : head
    if (key === undefined) general.push(issue.message)
    else fields[String(key)] ??= issue.message
  }
  const where = error.kind === "Payload" ? "body" : error.kind === "Params" ? "path" : error.kind.toLowerCase()
  return new ValidationError({ message: general[0] ?? `Invalid request ${where}`, fields })
}

/** Provides `Validation`. Response encoding failures are left alone (a 500). */
export const validation: Layer.Layer<Validation> = HttpApiMiddleware.layerSchemaErrorTransform(
  Validation,
  (error) =>
    error.kind === "Body" || error.kind === "ResponseHeaders"
      ? Effect.fail(error)
      : Effect.fail(toValidationError(error))
)

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

/**
 * What `make` needs from a resource. An assembled resource (`Resource.app(...).resources.users`)
 * has all of it, including the default messages for its relations.
 */
export interface Source<
  Name extends string,
  M extends ModelLike,
  Id extends keyof M["fields"] & keyof M["Type"] & keyof M["update"]["Type"] & string,
  Sortable extends string,
  FK extends string
> {
  readonly name: Name
  readonly noun: string
  readonly model: M
  readonly idColumn: Id
  readonly query: Query.QueryDef<Sortable, FK>
  readonly Repo: Context.Key<RepoOf<Name>, Repo.Repo<M, Id, Sortable, FK>>
  readonly messages: Messages
}

export const make = <
  const Name extends string,
  M extends ModelLike,
  const Id extends keyof M["fields"] & keyof M["Type"] & keyof M["update"]["Type"] & string,
  Sortable extends string,
  FK extends string
>(resource: Source<Name, M, Id, Sortable, FK>) => {
  const { idColumn, messages, model, name, noun, query } = resource
  type Row = M["Type"]
  type IdType = M["fields"][Id]["Type"]

  // --- schemas ---------------------------------------------------------------

  const RowJson = model.json as unknown as Schema.Codec<Row, Schema.Json>
  const CreateJson = model.jsonCreate as unknown as Schema.Codec<M["jsonCreate"]["Type"], Schema.Json>
  const UpdateJson = model.jsonUpdate as unknown as Schema.Codec<M["jsonUpdate"]["Type"], Schema.Json>
  const IdParam = { id: model.fields[idColumn] as unknown as Schema.Codec<IdType, number> }
  const PageJson = Schema.Struct({
    rows: Schema.Array(RowJson),
    total: Schema.Int,
    page: Schema.Int,
    pages: Schema.Int
  })

  const group = HttpApiGroup.make(name)
    .add(
      HttpApiEndpoint.get("list", "/", { query: query.params, success: PageJson }),
      HttpApiEndpoint.get("get", "/:id", { params: IdParam, success: RowJson, error: NotFound }),
      HttpApiEndpoint.post("create", "/", {
        payload: CreateJson,
        success: RowJson.pipe(HttpApiSchema.status(201)),
        error: Conflict
      }),
      HttpApiEndpoint.put("update", "/:id", {
        params: IdParam,
        payload: UpdateJson,
        success: RowJson,
        error: [NotFound, Conflict]
      }),
      HttpApiEndpoint.delete("delete", "/:id", { params: IdParam, error: [NotFound, Conflict] })
    )
    .middleware(Validation)
    .prefix(`/${name}`)
    // Report every invalid field, as the HTML form does.
    .annotate(HttpApi.PayloadParseOptions, { errors: "all" })
    .annotate(HttpApi.QueryParseOptions, { errors: "all" })

  // --- errors ----------------------------------------------------------------

  const notFound = (id: IdType) => new NotFound({ message: `No ${noun} with id ${String(id)}` })

  /** The configured field whose column name appears in the database error (else the first). */
  const pick = (configured: Readonly<Partial<Record<string, string>>>, e: SqlError.SqlError) => {
    const text = `${e.reason.message ?? ""} ${String(e.reason.cause ?? "")}`
    const entries = Object.entries(configured).filter((x): x is [string, string] => x[1] !== undefined)
    return entries.find(([k]) => text.includes(k)) ?? entries[0]
  }
  const conflict = (message: string, field?: readonly [string, string]) =>
    new Conflict({ message: field?.[1] ?? message, fields: field ? { [field[0]]: field[1] } : {} })

  const saveError = (e: SqlError.SqlError): Effect.Effect<never, Conflict> => {
    switch (e.reason._tag) {
      case "UniqueViolation":
        return Effect.fail(conflict(`A ${noun} with these values already exists`, pick(messages.unique, e)))
      case "ConstraintError":
        return Effect.fail(conflict("A referenced row does not exist", pick(messages.invalidReference, e)))
      default:
        return Effect.die(e)
    }
  }
  const deleteError = (e: SqlError.SqlError): Effect.Effect<never, Conflict> =>
    e.reason._tag === "ConstraintError"
      ? Effect.fail(conflict(messages.deleteRestricted ?? `This ${noun} is still referenced elsewhere.`))
      : Effect.die(e)

  // --- handlers --------------------------------------------------------------

  // `HttpApiBuilder.group` types each handler from the endpoint's schemas,
  // which TypeScript can't resolve while the model is a type parameter. The
  // handlers are written against this erased view instead; the schemas above
  // still decode every request and encode every response.
  interface Request {
    readonly params: { readonly id: IdType }
    readonly query: Query.ListParams<Sortable, FK>
    readonly payload: Readonly<Record<string, unknown>>
  }
  interface Handlers {
    readonly handle: (
      endpoint: "list" | "get" | "create" | "update" | "delete",
      handler: (request: Request) => Effect.Effect<unknown, NotFound | Conflict>
    ) => Handlers
  }
  const buildGroup = HttpApiBuilder.group as unknown as <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
    api: HttpApi.HttpApi<ApiId, Groups>,
    group: Name,
    build: (handlers: Handlers) => Effect.Effect<Handlers, never, RepoOf<Name>>
  ) => Layer.Layer<HttpApiGroup.Service<ApiId, Name>, never, RepoOf<Name>>
  const construct = <T>(variant: unknown, value: unknown): T => (variant as { make: (v: unknown) => T }).make(value)

  /**
   * The handlers, for an `HttpApi` that includes `group` (it may be prefixed).
   * Requires the resource's `Repo`.
   */
  const layer = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
    api: HttpApi.HttpApi<ApiId, Groups>
  ): Layer.Layer<HttpApiGroup.Service<ApiId, Name>, never, RepoOf<Name>> =>
    buildGroup(api, name, (handlers) =>
      Effect.map(Effect.service(resource.Repo), (repo) => {
        const find = (id: IdType): Effect.Effect<Row, NotFound> =>
          repo.findById(id).pipe(
            Effect.catchTag("NoSuchElementError", (_: Cause.NoSuchElementError) => Effect.fail(notFound(id))),
            Effect.catchTags({ SchemaError: Effect.die, SqlError: Effect.die })
          )
        return handlers
          .handle("list", (r) => repo.list(query.fromParams(r.query)).pipe(Effect.orDie))
          .handle("get", (r) => find(r.params.id))
          .handle("create", (r) =>
            repo.insert(construct<M["insert"]["Type"]>(model.insert, r.payload)).pipe(
              Effect.catchTags({ SqlError: saveError, SchemaError: Effect.die })
            ))
          .handle("update", (r) =>
            Effect.gen(function*() {
              yield* find(r.params.id)
              return yield* repo.update(
                construct<M["update"]["Type"]>(model.update, { ...r.payload, [idColumn]: r.params.id })
              )
            }).pipe(Effect.catchTags({ SqlError: saveError, SchemaError: Effect.die })))
          .handle("delete", (r) =>
            Effect.gen(function*() {
              yield* find(r.params.id)
              yield* repo.delete(r.params.id)
            }).pipe(Effect.catchTags({ SqlError: deleteError, SchemaError: Effect.die })))
      })).pipe(
        // The group's routes capture the middleware when they are built.
        Layer.provide(validation)
      )

  return { group, layer }
}
