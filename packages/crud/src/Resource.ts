/**
 * CRUD resources from a model + a small typed config, in two steps.
 *
 * 1. `define`: one pure value per resource (model, table, query, display,
 *    messages). Definitions never refer to each other, so they can't form a cycle.
 *
 *      export const Users = Resource.define({ name: "users", model: User, idColumn: "id", ... })
 *      export const Teams = Resource.define({ name: "teams", model: Team, idColumn: "id", ... })
 *
 * 2. `app`: attach relations and detail-page sections once every definition
 *    exists. It registers every route once and checks (in the types) that each
 *    resource a relation or embed names is part of the app.
 *
 *      export const Resources = Resource.app(
 *        Users.with({ relations: { teamId: Teams } }),
 *        Teams.with({ sections: [Users.embed({ name: "members", title: "Members", lock: "teamId" })] })
 *      )
 *      Resources.routes                 // every route of every resource
 *      Resources.layer                  // every `Repo` and `Lookup`
 *      Resources.resources.users        // endpoints, messages, `Page`, ... (e.g. for `Api.make`)
 *
 * Routes per resource:
 *
 *   GET    /users              list page, server-rendered for the query in the URL
 *   GET    /users/view         live table
 *   POST   /users              create
 *   GET    /users/:id/edit     open the edit dialog
 *   PUT    /users/:id          update
 *   DELETE /users/:id          delete
 *   GET    /users/:id          detail page (fields, Edit, Delete, sections)
 *   GET    /users/:id/view     live record
 *   POST   /users/bulk/delete  delete the selected rows
 *   POST   /users/bulk/update  set one field on the selected rows
 *   GET    /users/query        the query signals for a URL (Back/Forward)
 *
 * An embed (the users table on a team's page, with `teamId` locked) uses the
 * same table routes, with `?embed=members&scope=3`. The server looks up the
 * embed by name, decodes the scope with the lock field's own schema and applies
 * the lock; anything else is a `ScopeError`.
 *
 * A tenant (`tenant: { column: "orgId", service: CurrentOrg }`, see `Scope.ts`)
 * works like a lock whose value comes from a request-level service instead of
 * the URL: the `Repo` and `Lookup` filter and set the column, the column is
 * hidden, and the service is in the routes' requirements. It composes with
 * embed locks (the members embed is bounded by both team and org).
 *
 * Conventions (from `name`): table name, URL prefix `/${name}`, signal namespace
 * `${name}.{query,draft,errors,dialog}`, DOM id prefix. An embed uses its own
 * `name` for the signal namespace and DOM ids.
 *
 * The implementation is in `resource/`: `definition.ts` (`define`), `app.ts`,
 * `context.ts` (what a definition resolves to), `endpoints.ts` (the table
 * routes), `table.ts` (a table's signals and rules), `view.tsx` (its rendering),
 * `live.tsx` (the live table), `rows.ts` and `bulk.ts` (its actions),
 * `detail.tsx` (the detail page and live record) and `build.tsx` (all of it,
 * once the relations are known).
 */
export { app } from "./resource/app.ts"
export { define } from "./resource/definition.ts"
export type {
  AnySpec,
  Config,
  Embed,
  Layout,
  LookupOf,
  LookupTag,
  Messages,
  ModelLike,
  RepoOf,
  Section,
  ServicesOf,
  Spec,
  Target
} from "./resource/types.ts"
export { ScopeError } from "./resource/types.ts"
