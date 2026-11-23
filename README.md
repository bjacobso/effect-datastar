# effect-datastar

An exploration of a fully Effect-native [Datastar](https://data-star.dev) app: schema-driven CRUD resources (users and teams, related by a foreign key) with pagination, sorting, filtering, create, update and delete, live updates across tabs, and the list state kept in the URL. The server side is end-to-end [Effect](https://effect.website) 4.

```sh
npm install
npm run dev        # http://localhost:3000/users
npm test           # unit + HTTP tests (in-process, in-memory SQLite)
npm run test:e2e   # browser tests (real server + Playwright Chromium)
```

Requires Node 24+ (uses `node:sqlite`). For the browser tests, run `npx playwright install chromium` once.

## A resource

```tsx
export const Users = Resource.make({
  name: "users",
  title: "Users",
  noun: "user",
  model: User,                 // Model.Class: the single source of truth
  idColumn: "id",
  display: "name",
  query: {
    sortable: ["name", "email", "role", "createdAt"],
    filters: { name: "contains", email: "contains", role: "eq", teamId: "eq", active: "eq" },
    defaultSort: ["createdAt", "desc"],
    pageSizes: [10, 25, 50]
  },
  relations: { teamId: Teams.Lookup },
  messages: {
    unique: { email: "Email is already taken" },
    invalidReference: { teamId: "That team no longer exists" }
  },
  layout: Layout
})
```

That gives the page (server-rendered for the query in the URL), a live table, filters, sorting, paging, a create/edit dialog with per-field validation errors, delete, and the `Repo` / `Lookup` services. Everything it builds is exposed, so a resource can drop down a level when the config isn't enough.

## Detail pages and embedded "has many" tables

Every resource also has a detail page, `GET /teams/:id`, with the row's fields
kept live by `GET /teams/:id/view` (so a rename shows up there too). Unknown and
malformed ids get a 404 page. The display column links to it, and relation
cells (a user's team) link to the referenced row's page.

A resource can be embedded in another page with one `eq` filter locked:

```tsx
// src/app/TeamDetail.tsx
export const TeamMembers = Users.embed({ name: "members", title: "Members", lock: "teamId" })
export const TeamRoutes = Teams.routesWith({ sections: (team) => [TeamMembers.Section(team.id)] })
// App: Layer.mergeAll(Users.routes, TeamRoutes, TeamMembers.routes, ...)
```

The embed keeps everything the users table has: live updates, sorting, the
other filters, paging, and the create/edit dialog. It gets its own signal
namespace (`members.*`) and DOM ids, so it can sit next to a full users table,
and its own routes under `/users/embed/members/:scope/...`. The lock is enforced
on the server:

- `:scope` is decoded with the field's own schema (`/users/embed/members/abc/view` is rejected).
- The embed's query schema has no `teamId` filter, and signals that try to set one are rejected.
- Creates and updates get `teamId` from the server; any value in the draft is ignored.
- Edits and deletes of rows outside the lock answer "no longer exists".
- The locked column, filter and form field are hidden.

`Teams.routesWith(...)` exists because users depend on teams (`relations: { teamId: Teams.Lookup }`),
so the teams config can't name users; the sections are attached where both are in scope.

**URL state:** an embed doesn't sync its query to the URL. The detail page's
URL identifies the team, and two tables on one page would otherwise fight over
the query string. Its query lives in its signals and resets on reload.

## Layout

- `src/datastar/`: Datastar primitives for Effect HTTP
  - `Datastar.ts`: patch events, SSE `respond` (the handler error type must be `never`), schema-decoded `signals`
  - `Attrs.ts`: signal paths checked against the signals schema, attribute helpers
  - `Endpoint.ts`: route plus typed client action (`remove.call({ id })` produces `@delete('/users/3')`)
- `src/crud/`: building blocks derived from a schema
  - `Resource.tsx`: composes everything below into a resource
  - `Query.ts`: query signals schema, SQL `WHERE` / `ORDER BY`, URL params
  - `Repo.ts`: `SqlModel.makeRepository` plus paginated `list` and a `live` stream with row-level updates
  - `Lookup.ts`: options from another table, for foreign-key selects, filters and labels
  - `Field.ts`, `Form.ts`: field metadata, form drafts (with input coercion) and per-field errors
  - `components.tsx`: generic filter bar, sortable table, pagination, form fields and dialog (`@kitajs/html`)
  - `Feedback.tsx`: toast and unexpected-error patches
  - `Api.ts`: a JSON `HttpApiGroup` (list, get, create, update, delete) from a resource
- `src/reactivity/`: `Reactivity` across processes (`Broadcast`, `DistributedReactivity`, `SqliteBroadcast`), and `Payload.ts` for invalidations that say what changed
- `src/app/`: the `users` and `teams` resources, the team detail page with embedded members (`TeamDetail.tsx`), the JSON API (`Api.ts`), migrations (`Db.ts`) and app composition (`App.tsx`)
- `test/`: unit, in-process HTTP, and browser (`test/e2e`) tests

## How live updates work

The table is a long-lived SSE stream (`GET /users/view`) over `Repo.live(query)`.
Every repo mutation invalidates the row's record key (`{ users: [42] }`, which
also fires `users`) and hands the open streams a `Change`: insert, delete, or
update with the columns whose stored value changed (read from the previous
version of the row). Each stream then does as little as it can:

- An update that touches none of the query's sort or active filter columns
  can't change which rows are on the page, their order or the total. If the row
  is on the page, the stream re-fetches just that row and patches its `<tr>` by
  id (`users-42`); otherwise it does nothing.
- Anything else re-runs the page query and COUNT and re-renders the table:
  inserts, deletes, updates to a sorted or filtered column (which may move a
  row into or out of the page), and a bare `Reactivity.invalidate(["users"])`
  from outside the repo.

The users view also depends on `teams` (its relation), so renaming or adding a
team re-renders the table with fresh team labels and re-sends the team selects
in every open users tab. When the query signals change, the browser re-issues
the request and Datastar cancels the previous stream.

`test/queries.test.ts` counts SQL statements per mutation with six open views:
renaming a visible user went from 19 to 5, editing a user no view shows from 19
to 2, inserts and deletes from 19 to 13 (team lookups are no longer re-read),
and a team rename is 20 (19, plus reading the previous version of the team:
see below).

### Across server processes

`Reactivity` is process-local, so `Infra` provides a wrapped one
(`src/reactivity/`). Several servers on the same SQLite file then update each
other's tabs, with no change to the resource code:

```ts
Layer.mergeAll(Users.layer, Teams.layer).pipe(
  Layer.provideMerge(DistributedReactivity.layer),   // Reactivity
  Layer.provide(SqliteBroadcast.layer({ pollInterval })), // Broadcast
  Layer.provideMerge(Db.layer(db))                   // SqlClient
)
```

- `Broadcast` is the transport: `publish` a batch of invalidations, `subscribe`
  to what is published from then on.
- `DistributedReactivity` invalidates locally as before, queues the keys for a
  background publisher, and applies other processes' invalidations locally.
  Each process tags its messages with a random origin and skips its own.
- `SqliteBroadcast` appends to a `reactivity_invalidations` table and polls it
  with an id cursor, starting at the current end (no replay). A poll is one
  `PRAGMA data_version` unless another connection has committed. Rows older
  than a minute are pruned. The poll interval defaults to 100 ms
  (`INVALIDATION_POLL_INTERVAL="50 millis"` or `Infra({ pollInterval })`).

```sh
PORT=3000 npm start & PORT=3001 npm start   # same app.db; edit in one, watch the other
```

### Cross-process row patches

A rename on server A is a single-row patch on server B, as it is on A: the
`Change` travels with the broadcast.

- `InvalidationPayload` (`src/reactivity/Payload.ts`) is a generic side channel
  next to `Reactivity`: `invalidateUnsafe(keys, payload)` runs the handlers
  with `current()` returning the payload (a JSON value). `DistributedReactivity`
  provides it, publishes the payload with the keys, and sets it while applying
  a received message. It knows nothing about repos.
- A broadcast message is `{ origin, keys, payload? }`; the SQLite table has a
  nullable `payload` column (added on startup to tables from older versions).
- `Repo` sends `{ table: "users", change: { _tag: "Update", id: 42, columns: ["name"] } }`
  (the id encoded with the id field's JSON codec), and its streams decode the
  payload of whatever invalidation woke them. Local and remote changes take the
  same path. No payload (older senders, bare `Reactivity.invalidate`) or one
  that doesn't decode means a full re-query.
- To report changed columns, an update reads the row's previous version. Only
  one process knows whether it has open views, so with a cross-process
  `Reactivity` the previous version is always read (one SELECT per update).

`test/crossprocess.test.ts` runs two apps on one SQLite file, with a users view
open on B only. Statements B runs per mutation on A:

| Mutation on A                          | Before (bare keys) | After             |
| -------------------------------------- | ------------------ | ----------------- |
| rename a visible user                  | page query + COUNT | 1 row re-fetch    |
| change a filtered column (`role`)      | page query + COUNT | page query + COUNT |
| keys-only message from an older sender | page query + COUNT | page query + COUNT |

**Gaps.** A process stalled for longer than the retention (a long GC pause, a
suspended VM) would miss pruned rows. Each poll reads the newest assigned id
(`sqlite_sequence`) and the rows after the cursor in one statement; every id in
between was assigned, so fewer rows than ids means some were pruned. The
subscription then delivers a `Gap`, and `DistributedReactivity` re-runs every
key registered in that process (it tracks `registerUnsafe`, `query` and
`stream` registrations), so every live view re-queries.

## JSON API

`src/crud/Api.ts` derives an Effect `HttpApiGroup` from a resource, and
`src/app/Api.ts` mounts the users and teams groups under `/api`, with the
OpenAPI document at `/api/openapi.json` and a Scalar reference at `/api/docs`:

```ts
export const UsersApi = Api.make(Users)
export const TeamsApi = Api.make(Teams)

export class AppApi extends HttpApi.make("effect-datastar")
  .add(UsersApi.group)
  .add(TeamsApi.group)
  .prefix("/api") {}

export const ApiRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(AppApi, { openapiPath: "/api/openapi.json" }),
  HttpApiScalar.layer(AppApi, { path: "/api/docs" })
).pipe(Layer.provide([UsersApi.layer(AppApi), TeamsApi.layer(AppApi)]))
```

| Endpoint                | Success                        | Errors        |
| ----------------------- | ------------------------------ | ------------- |
| `GET    /api/users`     | `{ rows, total, page, pages }` | 400           |
| `GET    /api/users/:id` | the row                        | 400, 404      |
| `POST   /api/users`     | 201, the row                   | 400, 409      |
| `PUT    /api/users/:id` | the row                        | 400, 404, 409 |
| `DELETE /api/users/:id` | 204                            | 400, 404, 409 |

```sh
curl 'localhost:3000/api/users?role=admin&teamId=null&sort=name&dir=asc'
curl -X POST localhost:3000/api/users -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","role":"admin","teamId":1,"active":true}'
# 201 the new row; the same request again:
# 409 {"_tag":"Conflict","message":"Email is already taken","fields":{"email":"Email is already taken"}}
```

- The list takes the URL-state params (`page`, `pageSize`, `sort`, `dir`, one
  per filter) with the same per-field schemas as the live view's signals
  (`Query.params`). Where the page falls back to defaults, the API answers 400.
- Bodies are the model's `jsonCreate` / `jsonUpdate` (an update replaces every
  editable field, like the edit dialog); rows are the model's `json` variant.
- `ValidationError` (400) has one message per invalid field or param, all of
  them; `NotFound` (404); `Conflict` (409) for unique and foreign key
  violations, with the resource's `messages`.
- Mutations go through the resource's `Repo`, so open live views update (in
  every process), exactly as for the HTML forms.

## URL state

`GET /users?teamId=3&sort=name&dir=asc` renders that query on the server, so the
first paint has the table. Each new live stream patches a local signal
(`users._url`) with the canonical URL, which the page mirrors into the address
bar with `history.replaceState`. Both directions use the same `Query` config:
defaults are left out of the URL, and invalid params fall back to defaults.
Filter values are checked against the field's own schema, so `?teamId=1.5`
(`TeamId` is an integer) is dropped like `?role=root`, and the same value in
the signals is rejected as an invalid query.
