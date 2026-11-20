# effect-datastar

An exploration of a fully Effect-native [Datastar](https://data-star.dev) app: a schema-driven CRUD resource with pagination, sorting, filtering, create, update and delete, and live updates across tabs. The server side is end-to-end [Effect](https://effect.website) 4.

```sh
npm install
npm run dev        # http://localhost:3000/users
```

Requires Node 24+ (uses `node:sqlite`).

## Layout

- `src/datastar/`: Datastar primitives for Effect HTTP
  - `Datastar.ts`: patch events, SSE `respond` (the handler error type must be `never`), schema-decoded `signals`
  - `Attrs.ts`: signal paths checked against the signals schema, attribute helpers
  - `Endpoint.ts`: route plus typed client action (`remove.call({ id })` produces `@delete('/users/3')`)
- `src/crud/`: building blocks derived from a schema
  - `Query.ts`: query signals schema, SQL `WHERE` / `ORDER BY`
  - `Repo.ts`: `SqlModel.makeRepository` plus paginated `list` and a reactive `live` stream
  - `Field.ts`, `Form.ts`: field metadata, form drafts and per-field errors
  - `components.tsx`: generic filter bar, sortable table, pagination and form fields (`@kitajs/html`)
- `src/app/`: the `users` resource, composed from the pieces above

## How live updates work

The table is a long-lived SSE stream (`GET /users/view`). Mutations go through
`Reactivity.mutation(["users"], ...)`, and the stream re-renders whenever that key
is invalidated, so every open tab updates. When the query signals change, the
browser re-issues the request and Datastar cancels the previous stream.
