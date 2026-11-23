# effect-datastar

An exploration of a fully Effect-native [Datastar](https://data-star.dev) app: schema-driven CRUD resources (users and teams, related by a foreign key) with pagination, sorting, filtering, create, update and delete, live updates across tabs, and the list state kept in the URL. The server side is end-to-end [Effect](https://effect.website) 4.

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
    sortable: ["name", "email", "role", "createdAt"],
    filters: { name: "contains", email: "contains", role: "eq", teamId: "eq", active: "eq" },
    defaultSort: ["createdAt", "desc"],
    pageSizes: [10, 25, 50]
  },
  messages: {
    unique: { email: "Email is already taken" },
    invalidReference: { teamId: "That team no longer exists" }
  },
  layout: Layout
})
```

Then the **app**, where relations and detail-page sections are attached once
every definition is in scope, so users can point at teams while a team's page
embeds its users:

```ts
// src/app/Resources.ts
export const Resources = Resource.app(
  Users.with({ relations: { teamId: Teams } }),
  Teams.with({ sections: [Users.embed({ name: "members", title: "Members", lock: "teamId" })] })
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
- a relation whose field doesn't hold the target's ids (`role: Teams`).

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
  - `Lookup.ts`: options from another table, for foreign-key selects, filters and labels
  - `Field.ts`, `Form.ts`: field metadata, form drafts (with input coercion) and per-field errors
  - `components.tsx`: generic filter bar, sortable table, pagination, form fields and dialog (React + StyleX)
  - `Feedback.tsx`: toast and unexpected-error patches
  - `Api.ts`: a JSON `HttpApiGroup` (list, get, create, update, delete) from a resource
- `src/ui/`: the design system, copied from `@dw/ui` (document-workflow-service `packages/ui`): StyleX tokens and themes (`theme/`), global CSS and fonts, Button, form styles and the ui-sdk Select, Dialog (`overlay.tsx`), Menu, display pieces and icons
- `src/islands/`: React islands inside Datastar pages (`Island.tsx`: the `<ds-island>` host; `select.tsx`, `dialog.tsx`, `theme.tsx`: the islands, gathered in `islands.tsx`; `client.tsx`: the browser entry; `loaders.ts`, `mount.tsx`: the code it loads on demand)
- `src/reactivity/`: `Reactivity` across processes (`Broadcast`, `DistributedReactivity`, `SqliteBroadcast`), and `Payload.ts` for invalidations that say what changed
- `src/app/`: the `users` and `teams` definitions, their assembly with the relation and the team page's members (`Resources.ts`), the JSON API (`Api.ts`), migrations (`Db.ts`) and app composition (`App.tsx`)
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
  - `public/build/islands.js`, the browser entry: a small loader that defines `<ds-island>`,
    and `public/build/chunks/`, React and each island, split out (esbuild `splitting`, ESM)
    and loaded on demand. See [Islands](#islands).
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

`islands.js` defines `<ds-island>`. A host, once connected, loads React and its island's
code (`src/islands/loaders.ts`: one dynamic import per island) and mounts the component with
`createRoot` (it doesn't hydrate, so server and client markup never have to match). The host
element is where Datastar and React meet:

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

Islands in this app:

- `Select`: the relation field in the create/edit form, a ui-sdk Select. Filters stay native
  `<select>`s.
- `Dialog`: the create/edit dialog, a ui-sdk Dialog that is open while `$ns.dialog` is true.
  Escape, the backdrop and the close button emit `close`. Its content is the server-rendered
  form, sent as hidden live markup (`data-island-content`) and moved into the dialog once
  (`keepMounted`). Datastar binds that form like any other markup from the start, and the
  select inside it always exists as a patch target, even before the island's code has loaded.
  The dialog is modal only while open: ui-sdk would otherwise swallow clicks on the page
  during its exit transition (see `src/ui/overlay.tsx`).
- `Theme`: the Light/Dark/System menu (ui-sdk Menu).

**Code splitting.** `islands.js` is only the custom element: no React. Each island is a
chunk, and React plus the ui-sdk code they share are common chunks, fetched when the first
host on the page connects. `islands.js` still loads before `datastar.js`, so every host is
upgraded (and has its `value` property) before Datastar binds it; the `value` is kept until
the island renders it. Sizes (minified, from `npm run build`):

| JavaScript                                   | Before (one bundle) | After                           |
| -------------------------------------------- | ------------------- | ------------------------------- |
| loaded before `datastar.js` runs             | 470 KB (157 KB gz)  | 2.2 KB                          |
| total, `/users` (Theme, Dialog, Select)      | 470 KB              | 437 KB (154 KB gz), 19 files    |
| total, `/teams`, `/teams/:id` (no Select)    | 470 KB              | 428 KB (151 KB gz), 18 files    |

Every page has the theme menu and a dialog, which between them need React (≈210 KB) and
most of ui-sdk, so the total shrinks only by the islands a page lacks. The gain is that none
of it blocks Datastar any more: React and the islands download in parallel while the
server-rendered page is already live. A new island that only some pages use costs nothing
elsewhere.

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
mounts the users and teams groups under `/api`, with the OpenAPI document at
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
