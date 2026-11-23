# effect-datastar

An exploration of a fully Effect-native [Datastar](https://data-star.dev) app: schema-driven CRUD resources (users, teams and tags, related by a foreign key and a many-to-many join table) with pagination, sorting, filtering, create, update and delete, live updates across tabs, and the list state kept in the URL. The server side is end-to-end [Effect](https://effect.website) 4.

```sh
npm install
npm run dev        # build in watch mode and (re)start the server: http://localhost:3000/users
npm start          # production build, then node dist/server.js
npm test           # unit + HTTP tests (in-process, in-memory SQLite)
npm run test:e2e   # browser tests (builds once, real server + Playwright Chromium)
```

Requires Node 24+ (uses `node:sqlite`). For the browser tests, run `npx playwright install chromium` once.

## Resources

A resource is defined in two steps. First a **definition**, a pure value per
resource with no references to other resources:

```tsx
// src/app/Users.tsx
export const Users = Resource.define({
  name: "users",
  title: "Users",
  noun: "user",
  model: User,                 // Model.Class: the single source of truth
  idColumn: "id",
  display: "name",
  query: {
    sortable: ["name", "email", "role", "createdAt", "startDate"],
    filters: {
      name: "contains", email: "contains", role: "eq", teamId: "eq", active: "eq",
      tags: "has",          // many-to-many: users with this tag
      createdAt: "range"    // two filters, createdAtFrom and createdAtTo
    },
    defaultSort: ["createdAt", "desc"],
    pageSizes: [10, 25, 50]
  },
  messages: {
    unique: { email: "Email is already taken" },
    invalidReference: { teamId: "That team no longer exists", tags: "That tag no longer exists" }
  },
  layout: Layout
})
```

Then the **app**, where relations and detail-page sections are attached once
every definition is in scope, so users can point at teams and tags while a
team's page embeds its users:

```ts
// src/app/Resources.ts
export const Resources = Resource.app(
  Users.with({
    relations: { teamId: Teams },   // a foreign key column
    manyToMany: { tags: Tags }      // a join table (see "Fields" below)
  }),
  Teams.with({ sections: [Users.embed({ name: "members", title: "Members", lock: "teamId" })] }),
  Tags
)
// App: Resources.routes (every route), Resources.layer (every Repo and Lookup),
//      Resources.resources.users (endpoints, messages, Page, ...)
```

That gives each resource a list page (server-rendered for the query in the
URL), a live table, filters, sorting, paging, a create/edit dialog with
per-field validation errors, delete, a detail page, and the `Repo` / `Lookup`
services. A definition with nothing to attach can be passed to `app` as is.

| Route                    |                                             |
| ------------------------ | ------------------------------------------- |
| `GET    /users`          | list page                                   |
| `GET    /users/view`     | live table (SSE)                            |
| `POST   /users`          | create                                      |
| `GET    /users/:id/edit` | open the edit dialog                        |
| `PUT    /users/:id`      | update                                      |
| `DELETE /users/:id`      | delete                                      |
| `GET    /users/:id`      | detail page: fields, Edit, Delete, sections |
| `GET    /users/:id/view` | live record (SSE)                           |

Each route is registered once; embeds reuse them (below). Endpoint paths are
typed as registered (`Resources.resources.users.endpoints.update.path` is
`"/users/:id"`), and calls are typed from their params.

The types catch wiring mistakes (`test/types.test.ts`):

- a relation or embed naming a resource that isn't in the app (the error names
  the missing resources), and routes served without a resource's layer;
- an embed locking a filter that isn't `eq`, or whose values aren't the parent's
  ids (`lock: "role"` on a team's page);
- a relation whose field doesn't hold the target's ids (`role: Teams`);
- a many-to-many target missing from the app (`Resource.app(Users.with({ manyToMany: { tags: Tags } }), Teams)`),
  a many-to-many field whose elements aren't the target's ids (`tags: Teams`), or
  that isn't an array (`manyToMany: { teamId: Teams }`).

## Fields

Every widget, filter and SQL encoding follows from the model's schemas, not from
per-field config (`src/crud/Field.ts`, `src/crud/Schemas.ts`):

| Schema                                   | Kind       | Form widget                                    | Table                  |
| ---------------------------------------- | ---------- | ---------------------------------------------- | ---------------------- |
| `Schema.String`                          | `string`   | text input (`widget: "email"` for an email)    | text                   |
| a string with `isMaxLength(200)` or more | `string`   | ui-sdk Textarea (server-rendered)              | text                   |
| `Schema.Literals([...])`                 | `enum`     | ui-sdk Select island                           | badge                  |
| a foreign key (`relations`)              | `number`   | ui-sdk Select island, options from the target  | linked label           |
| `Schema.Boolean` / `Model.BooleanSqlite` | `boolean`  | switch (native checkbox, `role="switch"`)      | Yes / No badge         |
| `Schemas.LocalDate` (`format: "date"`)   | `date`     | ui-sdk DatePicker island                       | date                   |
| `DateTime.Utc` (`Model.DateTimeInsert`)  | `datetime` | read-only                                      | date and time          |
| `Schemas.Color`                          | `string`   | color input                                    | swatch                 |
| `ManyToMany.Ids(TagId, through)`         | `ids`      | ui-sdk Combobox (multiple) island, with chips  | chips in the tag color |

A `widget` annotation still overrides the derived one.

- **Dates.** `LocalDate` is a calendar date with no time or zone: an ISO
  `YYYY-MM-DD` string, stored as that text in SQLite and sent as it in JSON
  (`format: date` in the OpenAPI document). `DateTime.Utc` columns are ISO text
  too, so a `range` filter compares text: `createdAtFrom=2026-01-01&createdAtTo=2026-01-31`
  is `createdAt >= '2026-01-01' AND createdAt < '2026-02-01'` (on a date column,
  `<= to`). In the filter bar a range is two date pickers; both keys round-trip
  through the URL and are validated like any filter.
- **Switch, not a ui-sdk Switch island.** `data-bind` already maps a checkbox to
  a boolean signal, so a native `<input type="checkbox" role="switch">` styled as
  the ui-sdk Switch (`styles.switch` in `src/ui/form.tsx`) needs no island, no
  chunk and no host round trip, and works before any island code has loaded.
- **Textarea.** The ui-sdk Textarea renders a plain `<textarea>` on the server,
  which Datastar binds; it grows with its text through CSS `field-sizing: content`.

### Many-to-many

Storage is part of the model, the target is attached in the app, as for a
foreign key:

```ts
// src/app/User.ts: a field holding tag ids, stored in user_tags(userId, tagId)
tags: ManyToMany.Ids(TagId, { table: "user_tags", from: "userId", to: "tagId" })

// src/app/Resources.ts: what the ids point at
Users.with({ manyToMany: { tags: Tags } })
```

The field is a plain `ReadonlyArray<TagId>` in every variant of the model, so
rows, form drafts and the JSON API (read and write) all carry it as an array of
ids. The `through` annotation tells the rest:

- `Repo` reads it with each row (a correlated `json_group_array` subquery in the
  same statement: no extra query per page or row), and writes the row and its join
  rows in one transaction, touching only the join rows that changed. A missing
  tag fails the whole save and maps to the resource's `invalidReference` message.
- A change to a user's tags is reported as a change to that user's `tags`
  column: a row patch, unless the view filters on tags.
- The join table references both sides with `ON DELETE CASCADE` (migration
  `0003`), so deleting a tag or a user removes its join rows.
- The target gives the options (the filter select and the dialog's multi-select),
  the chips (label, link, and the color of its `Schemas.Color` field) and live
  updates: renaming or recoloring a tag re-renders the users views that show it.

## Detail pages and embedded "has many" tables

Every resource has a detail page, `GET /teams/:id`, with the row's fields
kept live by `GET /teams/:id/view` (so a rename in another tab shows up there
too). Unknown and malformed ids get a 404 page. The display column links to it,
and relation cells (a user's team) link to the referenced row's page.

The page has **Edit** and **Delete** for the record. Edit opens the same dialog
as the list, with the same validation (and, for a user, the team select, whose
options the live record keeps current). Delete asks for confirmation and, once
the row is gone, sends the browser back to the list (`?from=detail` tells the
delete route; `Datastar.redirect` does the navigation). A rejected delete (a
team that still has members) stays on the page with a toast.

A section is an embed of another resource, with one `eq` filter locked to the
page's row id, or any `(row) => Effect<ReactNode>`:

```ts
Teams.with({ sections: [Users.embed({ name: "members", title: "Members", lock: "teamId" })] })
```

The embed keeps everything the users table has: live updates, sorting, the
other filters, paging, and the create/edit dialog. It gets its own signal
namespace (`members.*`) and DOM ids, so it can sit next to a full users table.
It has no routes of its own: it uses the users routes with the scope in the
URL, `GET /users/view?embed=members&scope=2`, `POST /users?embed=members&scope=2`,
`PUT /users/7?embed=members&scope=2`, and so on. The lock is enforced on the server:

- `embed` must name an embed of that resource, and `scope` is decoded with the
  locked field's own schema (`?embed=members&scope=abc` is a `ScopeError`, as are
  an unknown embed and a scope without an embed).
- The embed's query schema has no `teamId` filter, and signals that try to set one are rejected.
- Creates and updates get `teamId` from the server; any value in the draft is ignored.
- Edits and deletes of rows outside the lock answer "no longer exists".
- The locked column, filter and form field are hidden.

**URL state:** an embed doesn't sync its query to the URL. The detail page's
URL identifies the team, and two tables on one page would otherwise fight over
the query string. Its query lives in its signals and resets on reload.

## Layout

- `src/datastar/`: Datastar primitives for Effect HTTP
  - `Datastar.ts`: patch events, SSE `respond` (the handler error type must be `never`), schema-decoded `signals`
  - `Attrs.ts`: signal paths checked against the signals schema, attribute helpers
  - `Endpoint.ts`: route plus typed client action (`remove.call({ id })` produces `@delete('/users/3')`), with an optional param-free path prefix and search params
  - `Html.ts`: React element to HTML string (`render` for patches, `document` for pages)
- `src/crud/`: building blocks derived from a schema
  - `Resource.tsx`: composes everything below into resources (`define`, then `app`)
  - `Query.ts`: query signals schema, SQL `WHERE` / `ORDER BY`, URL params
  - `Repo.ts`: `SqlModel.makeRepository` plus paginated `list` and a `live` stream with row-level updates
  - `ManyToMany.ts`: many-to-many fields (`Ids`), their SQL reads, writes and `has` filter
  - `Lookup.ts`: options from another table, for foreign-key selects, filters and labels
  - `Field.ts`, `Form.ts`, `Schemas.ts`: field metadata and widgets derived from schemas (`LocalDate`, `Color`), form drafts (with input coercion) and per-field errors
  - `components.tsx`: generic filter bar, sortable table, pagination, form fields and dialog (React + StyleX)
  - `Feedback.tsx`: toast and unexpected-error patches
  - `Api.ts`: a JSON `HttpApiGroup` (list, get, create, update, delete) from a resource
- `src/ui/`: the design system, copied from `@dw/ui` (document-workflow-service `packages/ui`): StyleX tokens and themes (`theme/`), global CSS and fonts, Button, form styles, the ui-sdk Textarea, Select (`form-pickers.tsx`), Combobox (`form-combobox.tsx`), DatePicker (`form-date.tsx`), Dialog (`overlay.tsx`), Menu, display pieces and icons
- `src/islands/`: React islands inside Datastar pages (`Island.tsx`: the `<ds-island>` host; `select.tsx`, `date.tsx`, `multiselect.tsx`, `dialog.tsx`, `theme.tsx`: one module per island; `registry.ts`: chunk loaders by name; `client.tsx`: the browser bundle)
- `src/reactivity/`: `Reactivity` across processes (`Broadcast`, `DistributedReactivity`, `SqliteBroadcast`), and `Payload.ts` for invalidations that say what changed
- `src/app/`: the `users`, `teams` and `tags` definitions, their assembly with the relations and the team page's members (`Resources.ts`), the JSON API (`Api.ts`), migrations (`Db.ts`) and app composition (`App.tsx`)
- `scripts/build.ts`: the esbuild + StyleX build (`npm run build`, `npm run dev`)
- `test/`: unit, in-process HTTP, and browser (`test/e2e`) tests

## Stack

- **Server:** Effect 4 HTTP. Every page and patch is React rendered on the server with
  `renderToStaticMarkup` (`src/datastar/Html.ts`). Static markup has no `<!-- -->` text
  separators, so Datastar morphs plain HTML; nothing server-rendered is hydrated. Datastar
  attributes (`data-on:click`, `data-on-signal-patch-filter`, ...) are spread from the typed
  `Attrs` helpers and reach the HTML unchanged (`test/render.test.tsx`).
- **Styling:** StyleX with the `@dw/ui` tokens (`--dw-*` custom properties), so this app and
  document-workflow-service share one design. Dark mode follows `prefers-color-scheme`; the
  theme menu in the header forces Light or Dark (saved per browser, applied before first paint).
  The only global CSS is `src/ui/theme/global.css` (reset, fonts, the `ui-sdk` layer).
- **Browser:** Datastar owns state (signals, SSE, morphing). React runs only in islands.
- **Build:** StyleX must be compiled, and the server renders nearly every component, so the
  server is bundled too. `scripts/build.ts` runs esbuild with `@stylexjs/unplugin` twice in
  one process, server then browser, and writes:
  - `dist/server.js`, the server, with dependencies left external.
  - `public/build/islands.js`, React, the island host and the Dialog, and
    `public/build/chunks/`, one chunk per other island plus shared chunks (about 450 KB
    for a page without pickers, 520 KB / 180 KB gzipped with all of them, against 470 KB
    for the single bundle before the date picker and combobox).
  - `public/build/app.css`, the global CSS and fonts plus every StyleX rule from both builds.
    It is served as a static file.

  Vitest compiles StyleX with the unplugin's Vite plugin. The e2e global setup builds once and
  the tests start `node dist/server.js`.

## Islands

An island is a React component that also runs in the browser. The server renders its host,
with the component rendered once as a placeholder:

```tsx
<Island.Mount
  island={Select}
  id="users-field-teamId"
  props={{ options, label: "Team", emptyLabel: "No team" }}
  attrs={ds.merge(ds.bind("users.draft.teamId"), ds.attr("aria-invalid", "$users.errors.teamId ? 'true' : 'false'"))}
/>
// <ds-island name="select" props='{"options":[...]}' data-bind="users.draft.teamId" ...>
//   <div data-island-root data-ignore-morph>…placeholder…</div>
// </ds-island>
```

`islands.js` defines `<ds-island>`, which mounts the component with `createRoot` (it doesn't
hydrate, so server and client markup never have to match). The host element is where Datastar
and React meet:

- **Value:** Datastar v1 binds `data-bind` to the `value` property of any custom element that
  has one, and listens for `change`. The island reads `host.value`; `host.setValue(v)` sets it
  and dispatches `change`, so `$users.draft.teamId` follows. Datastar writes to the property, and
  the island re-renders. `islands.js` loads before `datastar.js`, so hosts are already upgraded
  when Datastar binds them. Before the upgrade they have no `value` property, and Datastar would
  bind the attribute instead. The ui-sdk Select fires its own `input`/`change` events from a
  hidden form input; these are stopped at the island root so they don't reach the binding.
- **Other inputs:** host attributes. The island re-renders on any attribute change, `props`
  included. Example: `data-attr:open="$users.dialog"`.
- **Outputs:** events on the host, e.g. `host.emit("close")` for `data-on:close="$users.dialog = false"`.
- **Morphs:** the React root has `data-ignore-morph`, so a morph of an ancestor leaves React's
  DOM alone. The host's attributes still update.
- **New options:** when a team changes, the live view re-sends the select with `replace`. The
  old island unmounts, a new one mounts with the new `props`, and `data-bind` gives it the
  current value. The dialog stays open.
- **Arrays:** Datastar binds an array signal element-wise (one checkbox per element), so the
  tags multi-select isn't bound with `data-bind`: its value goes in as JSON
  (`data-attr:data-value="JSON.stringify($users.draft.tags)"`) and comes back on `change`
  (`$users.draft.tags = [...evt.target.value]`).
- **Loading:** `islands.js` holds the `<ds-island>` element, React and the Dialog. Every other
  island is a chunk loaded the first time a page has a host with its name
  (`src/islands/registry.ts`, esbuild `splitting`); the placeholder stays until then, and the
  host already has its `value`. The Dialog is in the bundle because live views patch the form
  inside it from their first response.

Islands in this app:

- `Select`: enum and relation fields in the create/edit form (role, team), a ui-sdk Select.
  Filters stay native `<select>`s.
- `DateInput`: date fields in the form and the date-range filters, a ui-sdk DatePicker.
- `MultiSelect`: many-to-many fields (tags), a ui-sdk Combobox in `multiple` mode with
  colored chips.
- `Dialog`: the create/edit dialog, a ui-sdk Dialog that is open while `$ns.dialog` is true.
  Escape, the backdrop and the close button emit `close`. Its content is the server-rendered
  form, sent in a `<template>` and placed once with `keepMounted`. Datastar binds that form like
  any other markup, and the select inside it always exists as a patch target.
- `Theme`: the Light/Dark/System menu (ui-sdk Menu).

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

The users view also depends on `teams` and `tags` (its relations), and decodes
their repos' changes too:

- An insert or update of a team or tag (a rename, a recolor, a new option) can't
  change which users a page shows. The stream reloads only that table's lookup
  and re-renders the table from the page it already has; if the table renders
  the same (the page shows no user with that tag), nothing is sent. The selects
  of that relation (filter and form) are re-sent only when their options changed.
- A delete may cascade (deleting a tag deletes its join rows), so it re-queries.

When the query signals change, the browser re-issues the request and Datastar
cancels the previous stream.

`test/queries.test.ts` counts SQL statements per mutation with six open views:

| Mutation                      | Count | Was | Notes                                                       |
| ----------------------------- | ----- | --- | ----------------------------------------------------------- |
| rename a visible user         | 7     | 5   | +BEGIN/COMMIT: a user save is a transaction (its tags)      |
| edit a user no view shows     | 4     | 2   | same                                                        |
| insert, delete a user         | 13    | 13  | an insert without tags needs no transaction                 |
| rename a team                 | 8     | 20  | no page query or COUNT: one lookup per view                 |
| change a visible user's tags  | 9     | —   | row patches only (three views show the user)                |
| rename a tag                  | 8     | —   | as a team rename                                            |
| delete a tag                  | 25    | —   | cascades: page query, COUNT and lookups per view            |

Before row-level changes, every mutation was 19 (each view re-ran its page
query, COUNT and team lookup). Reading the previous version: see below.

### Across server processes

`Reactivity` is process-local, so `Infra` provides a wrapped one
(`src/reactivity/`). Several servers on the same SQLite file then update each
other's tabs, with no change to the resource code:

```ts
Resources.layer.pipe(
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
npm run build && (PORT=3000 npm run serve & PORT=3001 npm run serve)   # same app.db; edit in one, watch the other
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

`src/crud/Api.ts` derives an Effect `HttpApiGroup` from an assembled resource
(which carries the relation-aware conflict messages), and `src/app/Api.ts`
mounts the users, teams and tags groups under `/api`, with the OpenAPI document at
`/api/openapi.json` and a Scalar reference at `/api/docs`:

```ts
export const UsersApi = Api.make(Resources.resources.users)
export const TeamsApi = Api.make(Resources.resources.teams)

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
  -d '{"name":"Ada","email":"ada@example.com","role":"admin","teamId":1,"active":true,"startDate":"2026-03-01","tags":[1,3]}'
# 201 the new row; the same request again:
# 409 {"_tag":"Conflict","message":"Email is already taken","fields":{"email":"Email is already taken"}}
```

- The list takes the URL-state params (`page`, `pageSize`, `sort`, `dir`, one
  per filter) with the same per-field schemas as the live view's signals
  (`Query.params`). Where the page falls back to defaults, the API answers 400.
- Bodies are the model's `jsonCreate` / `jsonUpdate` (an update replaces every
  editable field, like the edit dialog); rows are the model's `json` variant. A
  user's `tags` is an array of tag ids on read and write (`?tags=3` lists the
  users with tag 3), and `startDate` an ISO date or `null`.
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
