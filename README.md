# effect-datastar

An exploration of a fully Effect-native [Datastar](https://data-star.dev) app: schema-driven CRUD resources (users, teams and tags, related by a foreign key and a many-to-many join table) with pagination, sorting, filtering, create, update and delete, bulk actions, live updates across tabs, and the list state kept in the URL. Form widgets (dates, a textarea, a switch, selects, a tag multi-select) are derived from the schemas. Accounts sign in, and every team, tag and user belongs to an organization that only its members can see. The server side is end-to-end [Effect](https://effect.website) 4.

```sh
npm install
npm run dev        # build demo in watch mode and (re)start the server: http://localhost:3000/users
npm start          # production build of demo, then node apps/demo/dist/server.js
npm run dev:board  # live Kanban board example (4-layer Datastar DSL): http://localhost:3001
npm run build:board # production build of apps/board
npm run typecheck  # typecheck root + all workspaces
npm test           # unit + HTTP + package boundary tests (in-process, in-memory SQLite)
npm run test:e2e   # browser tests (builds demo once, real server + Playwright Chromium)
npm run load -- --streams 1000 --rate 5   # load test of live views (after npm run build), see docs/load.md
```

Requires Node 24+ (uses `node:sqlite`). For the browser tests, run `npx playwright install chromium` once.

Demo accounts (seeded), all with the password `demo-password`:

| Email               | Organization | Sees                                                |
| ------------------- | ------------ | --------------------------------------------------- |
| `ada@acme.test`     | Acme         | teams Platform, Growth, Design; 52 users; tags Remote, On call, Mentor, New hire, Contractor |
| `grace@acme.test`   | Acme         | the same                                            |
| `linus@globex.test` | Globex       | teams Infrastructure, Support; 35 users; tags Remote, Night shift, Lead |

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
  bulk: { set: ["role", "teamId"] },  // bulk actions: Delete, "Set role…", "Set team…"
  tenant: { column: "orgId", service: CurrentOrg },  // per organization (see "Tenant-scoped resources")
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
per-field validation errors, delete, bulk actions on selected rows, a detail
page, and the `Repo` / `Lookup` services. A definition with nothing to attach can be passed to `app` as is.

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
| `POST   /users/bulk/delete` | delete the selected rows                 |
| `POST   /users/bulk/update` | set one field on the selected rows       |
| `GET    /users/query`    | the query signals for a URL (Back/Forward)  |

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
// src/app/User.ts: a field holding tag ids, stored in user_tags(userId, tagId, orgId)
tags: ManyToMany.Ids(TagId, { table: "user_tags", from: "userId", to: "tagId", tenant: "orgId" })

// src/app/Resources.ts: what the ids point at
Users.with({ manyToMany: { tags: Tags } })
```

The field is a plain `ReadonlyArray<TagId>` in every variant of the model, so
rows, form drafts and the JSON API (read and write) all carry it as an array of
ids. The `through` annotation tells the rest:

- `Repo` reads it with each row (a correlated `json_group_array` subquery in the
  same statement: no extra query per page or row), and writes the row and its join
  rows in one transaction, touching only the join rows that changed. The ids are
  references like a foreign key: with a tenant, each must be one of the current
  organization's tags (one `SELECT COUNT(*) … WHERE id IN (…) AND orgId = ?`),
  or the save fails as a whole with `InvalidReference` ("That tag no longer
  exists" as a field error, 409 in the API).
- With a tenant, `through.tenant` names the join table's tenant column: every
  join row gets the current organization, and the table's composite foreign keys,
  `(userId, orgId) → users(id, orgId)` and `(tagId, orgId) → tags(id, orgId)`,
  let the database reject a link across organizations too.
- A change to a user's tags is reported as a change to that user's `tags`
  column: a row patch, unless the view filters on tags.
- The join table references both sides with `ON DELETE CASCADE` (migration
  `0005`), so deleting a tag or a user removes its join rows, bulk deletes included.
- A many-to-many field can't be set in bulk: "Set <field>…" is one value, and
  `Repo.updateMany` writes columns only (see "Bulk actions").
- The target gives the options (the filter select and the dialog's multi-select),
  the chips (label, link, and the color of its `Schemas.Color` field) and live
  updates: renaming or recoloring a tag re-renders the users views that show it.
  The target's lookup is tenant-scoped like any other, so a page only ever has
  its own organization's tag names and colors; a row carries ids only.

## Detail pages and embedded "has many" tables

Every resource has a detail page, `GET /teams/:id`, with the row's fields
kept live by `GET /teams/:id/view` (so a rename in another tab shows up there
too). Unknown and malformed ids get a 404 page. The display column links to it,
and relation cells (a user's team) link to the referenced row's page.

The page has **Edit** and **Delete** for the record. Edit opens the same dialog
as the list, with the same validation (and, for a user, the team select, whose
options the live record keeps current). Delete asks for confirmation and, once
the row is gone, sends the browser back to the list (`?from=detail` tells the
delete route; `Flash.redirect` does the navigation). The list page then shows
the "Deleted" toast: a navigation would lose a toast sent with it, so
`Flash.redirect` puts it in a short-lived cookie (`flash`, 10 s) right before
`location.assign`, and the list page renders it and expires the cookie
(`src/datastar/Flash.ts`). A cookie rather than a query param: there is nothing
to strip from the URL, a reload or a shared link doesn't toast again, and a
link can't make the page say something. A rejected delete (a team that still
has members) stays on the page with a toast.

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

## Sign-in and organizations

### Sessions (`src/auth/`)

- `Auth.ts`: `CurrentUser` and `CurrentOrg` (`Context.Service`), and `Sessions`:
  `signIn` (scrypt via `node:crypto`, see `Password.ts`; an unknown email
  costs the same as a wrong password), `resolve` (cookie to session) and
  `signOut`. A session token is 32 random bytes; the `sessions` table keeps
  only its SHA-256, with an expiry (`SESSION_TTL`, default 7 days). The cookie
  is `session`, `HttpOnly; SameSite=Lax; Path=/` (and `Secure` with
  `SECURE_COOKIES=true`).
- `Middleware.ts`: `RequireSession`, an `HttpRouter.middleware` that resolves
  the cookie and provides `CurrentUser` and `CurrentOrg` to the routes it is
  provided to, and `Authentication`, the same for the JSON API as an
  `HttpApiMiddleware` (the cookie declared as an API key security scheme).

```ts
// src/app/App.tsx: removing the Layer.provide makes this a type error,
// because the resources' routes require CurrentOrg (and the layout CurrentUser).
const Protected = Layer.mergeAll(HttpRouter.add("GET", "/", redirect("/users")), Resources.routes)
  .pipe(Layer.provide(RequireSession.layer))
export const Routes = Layer.mergeAll(Protected, LoginRoutes, ApiRoutes, HttpStaticServer.layer({ root: "public" }))

// src/app/Api.ts
class AppApi extends HttpApi.make("effect-datastar").add(UsersApi.group).add(TeamsApi.group).add(TagsApi.group)
  .middleware(Authentication).prefix("/api") {}
```

Without a valid session:

| Request                                         | Answer                                                    |
| ----------------------------------------------- | --------------------------------------------------------- |
| a page (`GET /teams/2`)                         | `302` to `/login?next=%2Fteams%2F2`                       |
| a Datastar request (`datastar-request: true`): a live view or an action | an SSE response with a redirect event to `/login` |
| the JSON API                                    | `401 {"_tag":"Unauthorized","message":"Sign in first"}`   |

`/login` is a form (the `src/ui` design system, Datastar signals) that posts to
`POST /login`; on success the response sets the cookie and redirects with
`Datastar.redirect` to `next` (a same-site path only). `POST /logout` deletes the
session and expires the cookie. The header shows the account, its organization
and **Sign out**: the layout is an Effect that reads `CurrentUser` and
`CurrentOrg` (`Resource.define`'s `layout` may return one; its requirements
join the routes').

**Accounts are not the users resource.** `users` is CRUD data: any member of the
organization can list, edit and delete those rows, and they flow through live
views, the JSON API and its OpenAPI document. Credentials don't belong in it:
a password hash would need hiding from every one of those paths, deleting a
"user" row would lock someone out (or leave a session behind), and editing a
row's email would change someone's sign-in. So `accounts` (email, name,
password hash, organization) and `sessions` are their own tables, reached only
through `Sessions`.

### Tenant-scoped resources

A resource's `tenant` option names the column that holds its organization and
the request-level service that has the current one:

```ts
export const Users = Resource.define({
  name: "users",
  model: User,                                       // has `orgId: OrgId`
  ...,
  tenant: { column: "orgId", service: CurrentOrg }    // CurrentOrg: { id: OrgId, name }
})
```

It is the embed lock generalized: the value comes from a service instead of
`?scope=`, and it applies to every table, page, route and API call of the
resource (`src/crud/Scope.ts`). The `Repo` and `Lookup` read `CurrentOrg` on
each call, so it is in their types and in the routes' requirements:

- `list`, `live`, the COUNT, `findById` and the lookup's options (the team and
  tag selects, filters, labels and chips) add `orgId = :current`.
- `insert` and `update` set `orgId` to the current organization, whatever was sent.
- `update` and `delete` of another organization's row fail with
  `NoSuchElementError`: "no longer exists" in the UI, 404 in the API. So do the
  detail page (404) and the live record.
- A relation to a tenant-scoped resource (a user's `teamId`, and each of its
  `tags`) must point at a row of the same organization: `Repo` checks it before
  writing and fails with `InvalidReference` (the field error "That team no longer
  exists", or a 409). The foreign key alone can't tell: team 4 exists, just not
  in Acme. A reference an update leaves unchanged isn't checked again (it was
  checked when written, and rows never change organization). The database also
  has composite keys, `(teamId, orgId) REFERENCES teams(id, orgId)` and the join
  table's (see "Many-to-many").
- The column is hidden from forms, filters, columns and the detail page, like
  an embed's lock, and left out of the API's request bodies.
- Emails, team names and tag names are unique per organization, so "already
  taken" says nothing about another organization's data (both have a "Remote" tag).

It composes with an embed lock: the members table on `/teams/2` is
`teamId = 2 AND orgId = :current`. On Acme's session, `?embed=members&scope=4`
(a Globex team) shows nothing, and creating through it is rejected (the team
isn't in Acme).

Bulk actions (`Repo.updateMany` / `deleteMany`, see "Bulk actions") follow the
same rules as single rows: only the current organization's rows are touched
(others count as "no longer exists"), a bulk "Set team" is checked like the
form (`InvalidReference`), the tenant column is never set, and the one
invalidation is on the organization's key.

**Migrations** (`src/app/Db.ts`) run in order on a fresh database and on one
from an earlier version: `0001_users`, `0002_teams`, `0003_orgs` (organizations;
teams and users rebuilt with `orgId`, per-organization uniqueness and the
`(teamId, orgId)` key; existing rows go to Acme), `0004_auth` (accounts and
sessions), `0005_dates_text_tags` (`users.startDate`, `teams.description`,
per-organization `tags` and `user_tags` with composite keys), `0006_list_indexes`
(`(orgId, column)` for every sortable column: list pages read just the page). Tags come after
organizations, so they are per organization from their first migration. The
seed fills what is empty: Globex is added to a database that only had Acme,
and tags (each organization's own) to one that had none.

The types check that `column` is a column whose values are the service's `id`s
(`service: CurrentUser`, whose `id` is an account id, is an error), and that the
routes can't be served without something providing `CurrentOrg`
(`test/types.test.ts`).

### Live updates per organization

Change payloads carry ids, never rows, and a woken stream only re-queries its
own organization. By default the reactivity keys are also per organization:
a change is announced on `users[orgId=1]` (plus the record key), and views
listen on that key and the bare `users` (for invalidations from outside the
repo), so Globex's changes don't wake Acme's views at all. The same goes for
related tables: an Acme users view depends on `teams[orgId=1]` and
`tags[orgId=1]`, so a Globex tag rename, recolor or delete never reaches it,
while an Acme one re-renders the views that show the tag. With
`isolateKeys: false` they share `users`. `test/tenant-repo.test.ts` counts the
statements six open Acme views run when Globex mutates its own rows:

| Globex mutation                       | Shared keys | Per-organization keys |
| ------------------------------------- | ----------: | --------------------: |
| insert                                |          12 |                     0 |
| rename (the sorted column of one view) |          2 |                     0 |
| change role (a filtered column)       |           2 |                     0 |
| toggle `active` (no query column)     |           0 |                     0 |
| delete                                |          12 |                     0 |

The security tests are `test/auth.test.ts` (redirects, 401s, the cookie, sign
out), `test/tenant.test.ts` (every cross-organization path: lists, lookups,
guessed ids, references, embeds, the API, live streams, bulk actions, tags),
`test/tenant-repo.test.ts` (the repo's own checks, with plain foreign keys that
can't catch a cross-organization team or tag) and `test/e2e/auth.test.ts` (sign
in as Acme, see nothing of Globex, sign out).

## Datastar DSL

Beyond the CRUD generator, `@effect-datastar/datastar` and `@effect-datastar/ui` provide a 4-layer typed Datastar DSL (demonstrated end-to-end in `apps/board`, a live Kanban board with SSE sync across tabs via `npm run dev:board`):

1. **Typed signals & expressions (`packages/datastar/src/Expr.ts`):** `Signals.from(schema)` turns an Effect `Schema` struct into a typed signal tree (`$.draft.title`, `$.selection`) with `.set(...)`, `.toggle(...)`, `.push(...)`, `.remove(...)`, `.clear()`, `.inc()`, `.dec()`, composable `Expr` combinators (`eq`, `and`, `nonEmpty`, `includes`, `filter`, …), the `E` tagged template literal, `Action` (`seq`, `when`, `confirm`, `raw`), and `el`/`evt` DOM helpers — all compiling to escaped Datastar JS expressions.
2. **Datastar JSX runtime (`packages/ui/src/jsx-runtime.ts`):** Opt in with `/** @jsxImportSource @effect-datastar/ui */` to write typed `$`-prefixed props (`$signals`, `$bind`, `$show`, `$text`, `$effect`, `$init`, `$indicator`, `$ignoreMorph`, `$on`, `$onSignalPatch`, `$attr`, `$class`) directly on HTML elements, compiled to `data-*` attributes at render time with a zero-overhead fast path for plain elements.
3. **Typed patch slots (`packages/datastar/src/Slot.ts` & `packages/ui/src/Slot.tsx`):** Renderer-agnostic `Slot.make` / `Slot.keyed` and React `reactSlot` / `keyedSlot` helpers pairing a `<Slot.Mount />` target with typed `morph`, `prepend`, `append`, and `remove` SSE patch emitters.
4. **Unified views (`packages/datastar/src/View.ts`):** `View.make`, `View.action`, and `View.live` bundle a namespaced signal tree (`$`), scoped `slots`, auto-derived server `Datastar.signals` + client `filterSignals`, jittered `retryInterval` for SSE streams, and `.scope(ns)` for multi-instance embedding.

## Layout

The repository is an npm workspaces monorepo (`packages/*` and `apps/*`), with automated package boundary and cycle checks in `test/boundaries.test.ts` (run by `npm test`):

- `packages/datastar/`: framework-agnostic Datastar primitives for Effect HTTP (no React dependency)
  - `src/Datastar.ts`: patch events, SSE `respond` (handler error type must be `never`), schema-decoded `signals`
  - `src/Attrs.ts`: signal paths checked against the signals schema, attribute helpers
  - `src/Expr.ts`: Layer 1 — `Signals.from`, `Expr`, `Signal`, `Action`, `E`, `el`/`evt`
  - `src/Slot.ts`: Layer 3 — renderer-agnostic `Slot.make` and `Slot.keyed`
  - `src/View.ts`: Layer 4 — `View.make`, `View.action`, `View.live`
  - `src/Endpoint.ts`: route plus typed client action (`remove.call({ id })` produces `@delete('/users/3')`)
  - `src/Flash.ts`, `src/Shared.ts`, `src/Metrics.ts`, `client/datastar.js`
- `packages/reactivity/`: cross-process `Reactivity` (`Broadcast`, `DistributedReactivity`, `SqliteBroadcast`, `Payload`)
- `packages/ui/`: React + StyleX design system, islands, and Datastar JSX runtime
  - `src/jsx-runtime.ts`, `src/jsx-dev-runtime.ts`: Layer 2 — `@jsxImportSource @effect-datastar/ui`
  - `src/Slot.tsx`: Layer 3 — React `reactSlot` and `keyedSlot`
  - `src/Html.ts`: React element to HTML string (`render` for patches, `document` for pages)
  - `src/theme/`, `src/islands/`, and UI components (`Button`, `form*`, `overlay`, `menu`, `display`, `icons`)
- `packages/crud/`: schema-driven CRUD generator (`Resource.ts` + `src/resource/*`, `Query.ts`, `Repo.ts`, `ManyToMany.ts`, `Lookup.ts`, `Field.ts`, `Form.ts`, `Schemas.ts`, `components.tsx`, `Bulk.tsx`, `UrlState.ts`, `Feedback.tsx`, `Api.ts`, `Scope.ts`)
- `apps/demo/`: multi-tenant users/teams/tags CRUD app (`src/app/`, `src/auth/`, `scripts/build.ts`, `scripts/load/`, `test/`, `test/e2e/`)
- `apps/board/`: live Kanban board app showcasing all 4 Datastar DSL layers (`src/BoardStore.ts`, `src/BoardView.tsx`, `src/App.tsx`, `scripts/build.ts`, `test/board.test.ts`)
- `scripts/build-app.ts`: shared esbuild + StyleX + islands + `datastar.js` app build helper (`createAppBuild`)
- `test/boundaries.test.ts`: enforces monorepo package boundaries (no `packages/` → `apps/` imports, no relative escapes, declared workspace deps, acyclic dependency graph)

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
- **Arrays:** Datastar binds an array signal element-wise (one checkbox per element), so the
  tags multi-select isn't bound with `data-bind`: its value goes in as JSON
  (`data-attr:data-value="JSON.stringify($users.draft.tags)"`) and comes back on `change`
  (`$users.draft.tags = [...evt.target.value]`).
- **Loading:** every island, the Dialog included, is a chunk loaded the first time a page has
  a host with its name (see "Code splitting" below); the placeholder stays until then, and the
  host already has its `value`. Once the island has rendered (the first render is synchronous),
  the host gets `data-island-ready`: until then a click lands on the inert placeholder, so the
  browser tests wait for it before opening a date picker.

Islands in this app:

- `Select`: enum and relation fields in the create/edit form (role, team), a ui-sdk Select.
  Filters stay native `<select>`s.
- `DateInput`: date fields in the form and the date-range filters, a ui-sdk DatePicker.
- `MultiSelect`: many-to-many fields (tags), a ui-sdk Combobox in `multiple` mode with
  colored chips.
- `Dialog`: the create/edit dialog, a ui-sdk Dialog that is open while `$ns.dialog` is true.
  Escape, the backdrop and the close button emit `close`. Its content is the server-rendered
  form, sent as hidden live markup (`data-island-content`) and moved into the dialog once
  (`keepMounted`), straight from that holder in a layout effect. Datastar binds that form like
  any other markup from the start, and the selects inside it are always in the document as
  patch targets: before the island's code has loaded, and while it renders. (An earlier
  version took the nodes out into a fragment before React rendered; a live view's first
  patch to the team or tags select could land in that gap and fail with
  `PatchElementsNoTargetsFound`, an occasional e2e failure.)
  The dialog is modal only while open: ui-sdk would otherwise swallow clicks on the page
  during its exit transition (see `src/ui/overlay.tsx`).
- `Theme`: the Light/Dark/System menu (ui-sdk Menu).

A boolean is a native switch and long text a server-rendered textarea, not islands (see
"Fields").

**Code splitting.** `islands.js` is only the custom element: no React. Each island is a
chunk, and React plus the ui-sdk code they share are common chunks, fetched when the first
host on the page connects. `islands.js` still loads before `datastar.js`, so every host is
upgraded (and has its `value` property) before Datastar binds it; the `value` is kept until
the island renders it. Sizes (minified, from `npm run build`):

| JavaScript                                              | One bundle (before splitting) | Now                          |
| ------------------------------------------------------- | ----------------------------- | ---------------------------- |
| loaded before `datastar.js` runs                        | 470 KB (157 KB gz)            | 2.4 KB                       |
| total, `/users` (Theme, Dialog, Select, DatePicker, Combobox) | —                       | 506 KB (178 KB gz), 25 files |
| total, `/teams`, `/teams/:id`, `/tags` (Theme, Dialog)  | 470 KB                        | 449 KB (156 KB gz), 20 files |

(The one-bundle figure predates the date picker and combobox.) Every page has the theme menu
and a dialog, which between them need React (≈210 KB) and most of ui-sdk, so the total
shrinks only by the islands a page lacks. The gain is that none of it blocks Datastar: React
and the islands download in parallel while the server-rendered page is already live, and a
page without a date field never downloads the calendar.

## Bulk actions

Every table (the list page's and embeds) has a checkbox per row and a "select
all on this page" checkbox in the header. While anything is selected, a bar
above the rows shows "N selected", **Delete**, **Clear**, and a "Set <field>…"
select per field in the resource's `bulk.set` (for users: role and team; the
team options stay live like the form's). `src/crud/Bulk.tsx` has the UI and the
toasts; `Resource` wires the endpoints.

**The selection is a plain signal**, `users.selection` (the ids, in the id
field's JSON form), not a `_`-prefixed local one. Datastar never sends a local
signal, so the bulk action would have to carry the ids itself (`@post('/users/bulk/delete?ids=' +
$users._selection.join(','))`): hand-built URL encoding, a length limit, and a
second way for input to reach the server. As a normal signal it is sent only
where asked for, `include: [users.selection]` on the two bulk actions (the live
view sends just `users.query`, the dialog just `users.draft`), the server
decodes it with a schema (`Array(UserId)`, 1 to 500 ids) like every other
signal, and it can patch it: `selection: []` after a successful action. The
page's ids live in a local signal, `users._page`, which the live view patches
with every page it renders; "select all" copies it, and an effect drops
selected ids that are no longer on the page after a re-render (deleted
elsewhere, filtered out, paged away). Checkboxes aren't `data-bind`ed (Datastar
binds checkboxes to arrays by position, not by value): each row's has an
effect `el.checked = $users.selection.includes(87)` and a change handler.

**On the server** (`POST /users/bulk/delete`, `POST /users/bulk/update`):

- The ids are decoded with the id field's schema; an empty, malformed or
  oversized selection is a toast. The update's field must be in `bulk.set` and
  its value is decoded with the field's `jsonUpdate` schema (`"null"` is "No
  team"), so it is validated exactly as the edit form would.
- `Repo.updateMany` / `Repo.deleteMany` run in **one transaction**: read the
  rows, apply the change (one `UPDATE … WHERE id IN (…)`, or one `DELETE` per
  row in its own savepoint, so a row the database restricts rolls back alone).
  A value the database rejects (a team deleted meanwhile) rolls back the whole
  update.
- **The embed lock holds**: with `?embed=members&scope=2`, rows outside team 2
  are filtered out inside the transaction and count as "no longer exists", and
  the locked field can't be set in bulk.
- **So does the tenant**: the rows are read (and the `UPDATE`/`DELETE`s bounded)
  by `orgId = :current` too, so another organization's ids are "no longer
  exists" and nothing of theirs changes, with or without an embed. A new team
  goes through the same reference check as the edit form (a Globex team is
  "That team no longer exists", and nothing is updated), and `orgId` can never
  be set in bulk.
- **Many-to-many fields aren't bulk-settable**: "Set <field>…" picks one value, while a
  user's tags are a set (replace them all? add one?), and `updateMany` writes columns, not
  join tables. The endpoint doesn't offer such a field even if `bulk.set` names it. A bulk
  delete does take the rows' join rows along (`ON DELETE CASCADE`).
- **Partial failures are reported**: "2 deleted, 1 has members" (the team
  resource's `messages.bulkDeleteRestricted`), "1 updated, 1 no longer exists".
  Rows the database kept stay selected; otherwise the selection is cleared.

**Live updates: one invalidation per bulk change.** `Reactivity.withBatch` is
no help here: `Repo` invalidates synchronously so handlers can read the
change's payload, and a batched handler would run after the payload is gone
(see the comments in `Repo.ts`). Instead the bulk methods invalidate once,
after the commit, with every row's record key (`{ users: [84, 83, 82] }`, or
per organization `{ "users[orgId=1]": [86, 82, 81] }`) and one payload carrying
every row's `Change` (`{ table, changes: [...] }`; single changes keep
`{ table, change }`, so older processes still decode). The payload only travels
with the organization's own key, so another organization's views are never woken. Each stream
is woken once and plans the whole batch, so row-level tracking still applies:
setting the team of three visible rows is one re-fetch of those rows in a view
that doesn't filter on team, and one re-query in a view that does.
`test/queries.test.ts`, six open views:

| Mutation                    | Statements | Three single mutations |
| --------------------------- | ---------- | ---------------------- |
| bulk set team, 3 users      | 9          | about 3 × 8            |
| bulk delete, 3 users        | 24         | 3 × 14                 |

(The team set includes one `SELECT COUNT(*) FROM teams … AND orgId = …` check, once for
all the rows, since they all get the same team.)

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

`test/queries.test.ts` counts SQL statements per mutation with six open Acme views.
Before row-level changes, every mutation was 19 (each view re-ran its page query, COUNT
and team lookup). Now, with users, teams and tags tenant-scoped and users carrying tags:

| Mutation                      | Statements | Notes                                                                 |
| ----------------------------- | ---------- | --------------------------------------------------------------------- |
| rename a visible user         | 7          | BEGIN/COMMIT (a user save is a transaction: its tags), previous version, update, a row re-fetch, the name-sorted view's re-query |
| edit a user no view shows     | 4          | BEGIN, previous version, update, COMMIT                               |
| insert a user                 | 13         | no tags, no team: no check and no transaction; page query and COUNT per view |
| delete a user                 | 14         | the organization check, then as an insert                             |
| rename a team                 | 8          | previous version (the organization check), update, one lookup per view: no page query or COUNT |
| change a visible user's tags  | 10         | + the tag check and the join rows' DELETE and INSERT; row patches only (three views show the user) |
| rename a tag                  | 8          | as a team rename                                                      |
| delete a tag                  | 26         | cascades: page query, COUNT and both lookups per view                 |
| bulk set team, 3 users        | 9          | see "Bulk actions"                                                    |
| bulk delete, 3 users          | 24         | see "Bulk actions"                                                    |

The previous version of a row is always read with a tenant (it is the organization
check; see also "Across server processes"). References (team, tags) are checked only when
they change, so a rename doesn't check the user's team or tags.

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

### Shared views, and how many tabs it takes

Identical live views share their work (`src/datastar/Shared.ts`): every tab
showing the same table (same organization, embed lock and query) or the same
record gets the events of one shared source, which runs the query and renders
once per change. A tab starts from the source's snapshot (so joining a running
view costs no query), then gets its deltas; a tab that stops reading holds at
most 16 pending events before it is switched to the snapshot. The key includes
the organization, so sharing never crosses organizations. A re-query that
renders the same table sends nothing, one that only changes the total sends just
the pagination, and a live record wakes only for its own row
(`users[orgId=1]:42`) and its related tables.

How far that goes is measured by a load harness (`scripts/load/`, `SEED=load`,
`METRICS=1` for `GET /_metrics`): one process holds 10,000 live streams with
5 writes/s at a p50/p99 of 19/140 ms from a write's response to each tab's patch,
about 37 KB of heap per stream. Results, scenarios (bursts, slow consumers, two
processes, reconnect storms), the fixes and their before/after numbers, and what
would come next: **[docs/load.md](docs/load.md)**.

## JSON API

`src/crud/Api.ts` derives an Effect `HttpApiGroup` from an assembled resource
(which carries the relation-aware conflict messages), and `src/app/Api.ts`
mounts the users, teams and tags groups under `/api`, with the OpenAPI document at
`/api/openapi.json` and a Scalar reference at `/api/docs`:

```ts
export const UsersApi = Api.make(Resources.resources.users)
export const TeamsApi = Api.make(Resources.resources.teams)
export const TagsApi = Api.make(Resources.resources.tags)

export class AppApi extends HttpApi.make("effect-datastar")
  .add(UsersApi.group)
  .add(TeamsApi.group)
  .add(TagsApi.group)
  .middleware(Authentication)   // the session cookie; provides CurrentOrg to the scoped groups
  .prefix("/api") {}

export const ApiRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(AppApi, { openapiPath: "/api/openapi.json" }),
  HttpApiScalar.layer(AppApi, { path: "/api/docs" })
).pipe(
  Layer.provide([UsersApi.layer(AppApi), TeamsApi.layer(AppApi), TagsApi.layer(AppApi)]),
  Layer.provide(AuthenticationLive)
)
```

Every endpoint needs the session cookie (401 without one) and works within its
organization: another organization's ids are 404s, a reference to another
organization's team or tag is a 409, and `orgId` is not part of the request bodies.
A group's layer requires the tenant service unless the API's middleware
provides it.

| Endpoint                | Success                        | Errors        |
| ----------------------- | ------------------------------ | ------------- |
| `GET    /api/users`     | `{ rows, total, page, pages }` | 400, 401           |
| `GET    /api/users/:id` | the row                        | 400, 401, 404      |
| `POST   /api/users`     | 201, the row                   | 400, 401, 409      |
| `PUT    /api/users/:id` | the row                        | 400, 401, 404, 409 |
| `DELETE /api/users/:id` | 204                            | 400, 401, 404, 409 |

```sh
# Sign in as the form does, keeping the session cookie:
curl -c jar -H 'content-type: application/json' localhost:3000/login \
  -d '{"login":{"email":"ada@acme.test","password":"demo-password","next":"/users","error":""}}'
curl -b jar 'localhost:3000/api/users?role=admin&teamId=null&sort=name&dir=asc'
curl -b jar -X POST localhost:3000/api/users -H 'content-type: application/json' \
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
(`users._url`) with the canonical URL, which the page writes to the address
bar (`src/crud/UrlState.ts`):

- **Filters, sort and page push history entries**, so Back and Forward step
  through list states.
- **Typing in a text filter is one entry**: its first change pushes, the rest
  replace that entry until the field loses focus (`_typing` / `_pushed` local
  signals), so a search isn't an entry per keystroke.
- **Opening a non-canonical URL replaces it** (`?page=99&role=root` becomes
  `?page=9` without an extra entry).
- **Back/Forward restore the query**: on `popstate` the page calls
  `GET /users/query?<the URL's params>`, which answers with a `patchSignals` of
  `users.query`; the live view re-queries as for any query change, and its
  stream's `_url` already matches the address, so nothing is pushed. A server
  round-trip rather than parsing in the browser: `Query.fromSearchParams` stays
  the only parser (defaults, per-field schemas, page sizes, invalid params), so
  Back shows exactly what a reload of that URL would.

Only the list page's table owns the URL; embeds don't. Both directions use the same `Query` config:
defaults are left out of the URL, and invalid params fall back to defaults.
Filter values are checked against the field's own schema, so `?teamId=1.5`
(`TeamId` is an integer) is dropped like `?role=root`, and the same value in
the signals is rejected as an invalid query.
