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
  - `Html.ts`: React element to HTML string (`render` for patches, `document` for pages)
- `src/crud/`: building blocks derived from a schema
  - `Resource.tsx`: composes everything below into a resource
  - `Query.ts`: query signals schema, SQL `WHERE` / `ORDER BY`, URL params
  - `Repo.ts`: `SqlModel.makeRepository` plus paginated `list` and a `live` stream with row-level updates
  - `Lookup.ts`: options from another table, for foreign-key selects, filters and labels
  - `Field.ts`, `Form.ts`: field metadata, form drafts (with input coercion) and per-field errors
  - `components.tsx`: generic filter bar, sortable table, pagination, form fields and dialog (React + StyleX)
  - `Feedback.tsx`: toast and unexpected-error patches
- `src/ui/`: the design system, copied from `@dw/ui` (document-workflow-service `packages/ui`): StyleX tokens and themes (`theme/`), global CSS and fonts, Button, form styles and the ui-sdk Select, Dialog (`overlay.tsx`), Menu, display pieces and icons
- `src/islands/`: React islands inside Datastar pages (`Island.tsx`: the `<ds-island>` host; `islands.tsx`: Select, Dialog, Theme; `client.tsx`: the browser bundle)
- `src/reactivity/`: `Reactivity` across processes (`Broadcast`, `DistributedReactivity`, `SqliteBroadcast`)
- `src/app/`: the `users` and `teams` resources, the team detail page with embedded members (`TeamDetail.tsx`), migrations (`Db.ts`) and app composition (`App.tsx`)
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
  - `public/build/islands.js`, React and the islands.
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

Islands in this app:

- `Select`: the relation field in the create/edit form, a ui-sdk Select. Filters stay native
  `<select>`s.
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

The users view also depends on `teams` (its relation), so renaming or adding a
team re-renders the table with fresh team labels and re-sends the team selects
in every open users tab. When the query signals change, the browser re-issues
the request and Datastar cancels the previous stream.

`test/queries.test.ts` counts SQL statements per mutation with six open views:
renaming a visible user went from 19 to 5, editing a user no view shows from 19
to 2, inserts and deletes from 19 to 13 (team lookups are no longer re-read),
and a team rename stays at 19.

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
npm run build && (PORT=3000 npm run serve & PORT=3001 npm run serve)   # same app.db; edit in one, watch the other
```

## URL state

`GET /users?teamId=3&sort=name&dir=asc` renders that query on the server, so the
first paint has the table. Each new live stream patches a local signal
(`users._url`) with the canonical URL, which the page mirrors into the address
bar with `history.replaceState`. Both directions use the same `Query` config:
defaults are left out of the URL, and invalid params fall back to defaults.
