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

## Layout

- `src/datastar/`: Datastar primitives for Effect HTTP
  - `Datastar.ts`: patch events, SSE `respond` (the handler error type must be `never`), schema-decoded `signals`
  - `Attrs.ts`: signal paths checked against the signals schema, attribute helpers
  - `Endpoint.ts`: route plus typed client action (`remove.call({ id })` produces `@delete('/users/3')`)
- `src/crud/`: building blocks derived from a schema
  - `Resource.tsx`: composes everything below into a resource
  - `Query.ts`: query signals schema, SQL `WHERE` / `ORDER BY`, URL params
  - `Repo.ts`: `SqlModel.makeRepository` plus paginated `list` and a reactive `live` stream
  - `Lookup.ts`: options from another table, for foreign-key selects, filters and labels
  - `Field.ts`, `Form.ts`: field metadata, form drafts (with input coercion) and per-field errors
  - `components.tsx`: generic filter bar, sortable table, pagination, form fields and dialog (`@kitajs/html`)
  - `Feedback.tsx`: toast and unexpected-error patches
- `src/reactivity/`: `Reactivity` across processes (`Broadcast`, `DistributedReactivity`, `SqliteBroadcast`)
- `src/app/`: the `users` and `teams` resources, migrations (`Db.ts`) and app composition (`App.tsx`)
- `test/`: unit, in-process HTTP, and browser (`test/e2e`) tests

## How live updates work

The table is a long-lived SSE stream (`GET /users/view`). Mutations go through
`Reactivity.mutation(["users"], ...)`, and the stream re-renders whenever that key
is invalidated, so every open tab updates. When the query signals change, the
browser re-issues the request and Datastar cancels the previous stream.

The users view listens to both `users` and `teams`, so renaming or adding a team
updates the team column and the team selects in every open users tab.

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

## URL state

`GET /users?teamId=3&sort=name&dir=asc` renders that query on the server, so the
first paint has the table. Each new live stream patches a local signal
(`users._url`) with the canonical URL, which the page mirrors into the address
bar with `history.replaceState`. Both directions use the same `Query` config:
defaults are left out of the URL, and invalid params fall back to defaults.
