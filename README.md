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
  - `Repo.ts`: `SqlModel.makeRepository` plus paginated `list` and a `live` stream with row-level updates
  - `Lookup.ts`: options from another table, for foreign-key selects, filters and labels
  - `Field.ts`, `Form.ts`: field metadata, form drafts (with input coercion) and per-field errors
  - `components.tsx`: generic filter bar, sortable table, pagination, form fields and dialog (`@kitajs/html`)
  - `Feedback.tsx`: toast and unexpected-error patches
- `src/app/`: the `users` and `teams` resources, migrations (`Db.ts`) and app composition (`App.tsx`)
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
and a team rename stays at 19.

## URL state

`GET /users?teamId=3&sort=name&dir=asc` renders that query on the server, so the
first paint has the table. Each new live stream patches a local signal
(`users._url`) with the canonical URL, which the page mirrors into the address
bar with `history.replaceState`. Both directions use the same `Query` config:
defaults are left out of the URL, and invalid params fall back to defaults.
