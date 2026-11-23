import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Array as Arr, Effect, Layer } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import * as Password from "../auth/Password.ts"

const migrations = Migrator.fromRecord({
  "0001_users": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      active INTEGER NOT NULL,
      createdAt TEXT NOT NULL
    )`
  }),
  "0002_teams": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL
    )`
    // Deleting a team that still has members is rejected by the database.
    yield* sql`ALTER TABLE users ADD COLUMN teamId INTEGER REFERENCES teams(id) ON DELETE RESTRICT`
    yield* sql`CREATE INDEX users_teamId ON users(teamId)`
  }),
  /**
   * Organizations (tenants). Teams and users get an `orgId`; existing rows go
   * to a first organization. SQLite can't add constraints to a table, so both
   * are rebuilt (child first, so no foreign key ever dangles):
   *
   * - a user's team must be in the user's organization: `(teamId, orgId)`
   *   references `teams(id, orgId)`. The server checks it too; this is the
   *   last line of defence.
   * - team names and user emails are unique per organization. Globally unique,
   *   a "name already taken" would tell one organization what another has.
   */
  "0003_orgs": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE orgs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL
    )`
    yield* sql`INSERT INTO orgs (name, createdAt)
      SELECT 'Acme', ${new Date(Date.UTC(2025, 5, 1)).toISOString()}
      WHERE EXISTS (SELECT 1 FROM teams) OR EXISTS (SELECT 1 FROM users)`
    yield* sql`CREATE TABLE teams_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orgId INTEGER NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE (orgId, name),
      UNIQUE (id, orgId)
    )`
    yield* sql`INSERT INTO teams_new (id, orgId, name, createdAt)
      SELECT id, (SELECT MIN(id) FROM orgs), name, createdAt FROM teams`
    yield* sql`CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orgId INTEGER NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      teamId INTEGER,
      UNIQUE (orgId, email),
      FOREIGN KEY (teamId, orgId) REFERENCES teams_new(id, orgId) ON DELETE RESTRICT
    )`
    yield* sql`INSERT INTO users_new (id, orgId, name, email, role, active, createdAt, teamId)
      SELECT id, (SELECT MIN(id) FROM orgs), name, email, role, active, createdAt, teamId FROM users`
    yield* sql`DROP TABLE users`
    yield* sql`DROP TABLE teams`
    // Renaming updates the foreign key in users_new to `teams`.
    yield* sql`ALTER TABLE teams_new RENAME TO teams`
    yield* sql`ALTER TABLE users_new RENAME TO users`
    yield* sql`CREATE INDEX users_teamId ON users(teamId)`
    yield* sql`CREATE INDEX users_orgId ON users(orgId)`
    yield* sql`CREATE INDEX teams_orgId ON teams(orgId)`
  }),
  /**
   * Sign-in accounts, separate from the `users` resource (CRUD data any member
   * of an organization can edit), and their sessions. A session is stored as
   * the SHA-256 of its token, so the table alone can't be used to sign in.
   */
  "0004_auth": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orgId INTEGER NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      passwordHash TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )`
    yield* sql`CREATE TABLE sessions (
      tokenHash TEXT PRIMARY KEY,
      accountId INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL
    )`
    yield* sql`CREATE INDEX sessions_accountId ON sessions(accountId)`
  }),
  /**
   * Dates, long text and tags (after organizations, so tags are per
   * organization from the start; a database from before it has none).
   *
   * - `users.startDate`: a calendar date, ISO `YYYY-MM-DD` text
   *   (`Schemas.LocalDate`), so it sorts and compares as a date.
   * - `teams.description`: long text (a textarea).
   * - `tags`: per organization, like teams: names unique per organization, and
   *   `(id, orgId)` unique so join rows can reference it.
   * - `user_tags`: the many-to-many, with the organization in each row and
   *   composite foreign keys to `users(id, orgId)` and `tags(id, orgId)`: a
   *   user can only be linked to a tag of its own organization. Deleting a user
   *   or a tag deletes its join rows (`ON DELETE CASCADE`).
   */
  "0005_dates_text_tags": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE users ADD COLUMN startDate TEXT`
    yield* sql`ALTER TABLE teams ADD COLUMN description TEXT NOT NULL DEFAULT ''`
    // The parent key of `user_tags`' composite foreign key (SQLite needs a unique index on it).
    yield* sql`CREATE UNIQUE INDEX users_id_orgId ON users(id, orgId)`
    yield* sql`CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orgId INTEGER NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE (orgId, name),
      UNIQUE (id, orgId)
    )`
    yield* sql`CREATE INDEX tags_orgId ON tags(orgId)`
    yield* sql`CREATE TABLE user_tags (
      userId INTEGER NOT NULL,
      tagId INTEGER NOT NULL,
      orgId INTEGER NOT NULL,
      PRIMARY KEY (userId, tagId),
      FOREIGN KEY (userId, orgId) REFERENCES users(id, orgId) ON DELETE CASCADE,
      FOREIGN KEY (tagId, orgId) REFERENCES tags(id, orgId) ON DELETE CASCADE
    )`
    yield* sql`CREATE INDEX user_tags_tagId ON user_tags(tagId)`
  }),
  /**
   * Indexes for the list pages: every list query is `WHERE orgId = ? ORDER BY
   * <sortable column>`. With only `(orgId)`, SQLite read all of an
   * organization's rows and sorted them for each page (about 1 ms at 5000
   * users); with `(orgId, column)` it reads the page's rows in order (about
   * 0.02 ms). Live views re-run that query on every insert or delete, so it
   * adds up (see docs/load.md).
   */
  "0006_list_indexes": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    for (const column of ["createdAt", "name", "email", "role", "startDate"]) {
      yield* sql`CREATE INDEX ${sql(`users_orgId_${column}`)} ON users(orgId, ${sql(column)})`
    }
    yield* sql`CREATE INDEX teams_orgId_name ON teams(orgId, name)`
    yield* sql`CREATE INDEX tags_orgId_name ON tags(orgId, name)`
  })
})

/** Demo sign-ins (seeded): two in Acme, one in Globex. */
export const demoAccounts = [
  { email: "ada@acme.test", name: "Ada Lovelace", org: "Acme", password: "demo-password" },
  { email: "grace@acme.test", name: "Grace Hopper", org: "Acme", password: "demo-password" },
  { email: "linus@globex.test", name: "Linus Torvalds", org: "Globex", password: "demo-password" }
] as const

const seed = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const insertAll = (table: string, rows: ReadonlyArray<Record<string, unknown>>) =>
    Arr.isReadonlyArrayNonEmpty(rows) ? sql`INSERT INTO ${sql(table)} ${sql.insert(rows)}` : Effect.void
  const count = (table: string) =>
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`.pipe(Effect.map((r) => r[0]?.n ?? 0))

  // Both organizations, also in a database migrated from before organizations (which has Acme only).
  yield* Effect.forEach(["Acme", "Globex"], (name, i) =>
    sql`INSERT INTO orgs (name, createdAt) SELECT ${name}, ${new Date(Date.UTC(2025, 5, 1 + i)).toISOString()}
        WHERE NOT EXISTS (SELECT 1 FROM orgs WHERE name = ${name})`, { discard: true })
  const orgs = yield* sql<{ id: number; name: string }>`SELECT id, name FROM orgs ORDER BY id`
  const orgId = (name: string) => orgs.find((o) => o.name === name)?.id ?? orgs[0]!.id

  // Acme: Platform, Growth, Design. Globex: Infrastructure, Support.
  if ((yield* count("teams")) === 0) {
    const teams = [["Platform", "Acme"], ["Growth", "Acme"], ["Design", "Acme"], ["Infrastructure", "Globex"], [
      "Support",
      "Globex"
    ]] as const
    yield* insertAll(
      "teams",
      teams.map(([name, org], i) => ({
        name,
        orgId: orgId(org),
        createdAt: new Date(Date.UTC(2025, 6, 1 + i * 9)).toISOString()
      }))
    )
  }

  // Users are spread across the teams (every 6th has none) and belong to their
  // team's organization; those without a team alternate. Acme: 52, Globex: 35.
  if ((yield* count("users")) === 0) {
    const teams = yield* sql<{ id: number; orgId: number }>`SELECT id, orgId FROM teams ORDER BY id`
    const first = ["Ada", "Grace", "Alan", "Linus", "Barbara", "Edsger", "Margaret", "Ken", "Radia", "Dennis", "Frances", "John"]
    const last = ["Lovelace", "Hopper", "Turing", "Torvalds", "Liskov", "Dijkstra", "Hamilton", "Thompson", "Perlman", "Ritchie"]
    const roles = ["admin", "member", "member", "member", "guest"]
    const rows = Array.from({ length: 87 }, (_, i) => {
      const f = first[i % first.length]!
      const l = last[(i * 7) % last.length]!
      const id = i + 1
      const team = id % 6 === 0 ? undefined : teams[id % teams.length]
      return {
        name: `${f} ${l}`,
        email: `${f}.${l}${i}@example.com`.toLowerCase(),
        role: roles[(i * 3) % roles.length]!,
        active: i % 4 === 0 ? 0 : 1,
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 36e5 * 31).toISOString(),
        teamId: team?.id ?? null,
        orgId: team?.orgId ?? orgId(id % 12 === 0 ? "Globex" : "Acme")
      }
    })
    yield* insertAll("users", rows)
  }

  if ((yield* count("accounts")) === 0) {
    const rows = yield* Effect.forEach(demoAccounts, (a) =>
      Effect.map(Password.hash(a.password), (passwordHash) => ({
        email: a.email,
        name: a.name,
        orgId: orgId(a.org),
        passwordHash,
        createdAt: new Date(Date.UTC(2025, 5, 1)).toISOString()
      })), { concurrency: "unbounded" })
    yield* insertAll("accounts", rows)
  }

  // First run with tags: each organization's own (Acme five, Globex three; both have a
  // "Remote", which per-organization uniqueness allows), some on most users, always of
  // the user's organization. Start dates for two thirds of the users.
  if ((yield* count("tags")) === 0) {
    const tags = [
      ["Remote", "#2563eb", "Acme"],
      ["On call", "#dc2626", "Acme"],
      ["Mentor", "#16a34a", "Acme"],
      ["New hire", "#d97706", "Acme"],
      ["Contractor", "#7c3aed", "Acme"],
      ["Remote", "#0891b2", "Globex"],
      ["Night shift", "#be185d", "Globex"],
      ["Lead", "#4d7c0f", "Globex"]
    ] as const
    yield* insertAll(
      "tags",
      tags.map(([name, color, org], i) => ({
        name,
        color,
        orgId: orgId(org),
        createdAt: new Date(Date.UTC(2025, 8, 1 + i)).toISOString()
      }))
    )
    const tagRows = yield* sql<{ id: number; orgId: number }>`SELECT id, orgId FROM tags ORDER BY id`
    const users = yield* sql<{ id: number; orgId: number }>`SELECT id, orgId FROM users ORDER BY id`
    yield* insertAll(
      "user_tags",
      users.flatMap((user) =>
        tagRows.filter((t) => t.orgId === user.orgId)
          .filter((_, k) => (user.id * (k + 3)) % 7 < 2)
          .map((tag) => ({ userId: user.id, tagId: tag.id, orgId: user.orgId }))
      )
    )
    yield* sql`UPDATE users SET startDate = date('2024-01-01', '+' || ((id * 37) % 900) || ' days')
               WHERE startDate IS NULL AND id % 3 != 0`
  }
  if ((yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM teams WHERE description != ''`)[0]?.n === 0) {
    yield* sql`UPDATE teams SET description = 'The ' || name || ' team.' WHERE id % 2 = 1`
  }
})

/**
 * Extra data for load tests (`SEED=load`, see `scripts/load/`): `LOAD_ORGS`
 * organizations (default 10) named `Load 1`..`Load N`, each with 10 teams, 8
 * tags, `LOAD_USERS` users (default 5000) and `LOAD_ACCOUNTS` sign-ins (default
 * 50): `load<org>-<k>@load.test`, password `load-password`. All accounts share
 * one hash (scrypt is slow on purpose; 500 of them would take a while).
 * Runs once: an organization that already exists is left alone.
 */
export const LOAD_PASSWORD = "load-password"
const loadSeed = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const env = (name: string, fallback: number) => {
    const n = Number(process.env[name])
    return Number.isInteger(n) && n > 0 ? n : fallback
  }
  const orgCount = env("LOAD_ORGS", 10)
  const usersPerOrg = env("LOAD_USERS", 5000)
  const accountsPerOrg = env("LOAD_ACCOUNTS", 50)
  // SQLite caps bound parameters per statement; insert in chunks.
  const insertChunked = (table: string, rows: ReadonlyArray<Record<string, unknown>>) =>
    Effect.forEach(Arr.chunksOf(rows, 500), (chunk) =>
      Arr.isReadonlyArrayNonEmpty(chunk) ? Effect.asVoid(sql`INSERT INTO ${sql(table)} ${sql.insert(chunk)}`) : Effect.void, { discard: true })
  const passwordHash = yield* Password.hash(LOAD_PASSWORD)
  const roles = ["admin", "member", "member", "member", "guest"]
  const first = ["Ada", "Grace", "Alan", "Linus", "Barbara", "Edsger", "Margaret", "Ken", "Radia", "Dennis", "Frances", "John"]
  const last = ["Lovelace", "Hopper", "Turing", "Torvalds", "Liskov", "Dijkstra", "Hamilton", "Thompson", "Perlman", "Ritchie"]
  const colors = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#be185d", "#4d7c0f"]
  for (let o = 1; o <= orgCount; o++) {
    const name = `Load ${o}`
    const exists = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM orgs WHERE name = ${name}`
    if ((exists[0]?.n ?? 0) > 0) continue
    yield* sql.withTransaction(Effect.gen(function*() {
      yield* sql`INSERT INTO orgs (name, createdAt) VALUES (${name}, ${new Date(Date.UTC(2025, 0, o)).toISOString()})`
      const [org] = yield* sql<{ id: number }>`SELECT id FROM orgs WHERE name = ${name}`
      const orgId = org!.id
      yield* insertChunked("teams", Array.from({ length: 10 }, (_, t) => ({
        orgId,
        name: `Team ${t + 1}`,
        description: "",
        createdAt: new Date(Date.UTC(2025, 1, 1 + t)).toISOString()
      })))
      yield* insertChunked("tags", colors.map((color, t) => ({
        orgId,
        name: `Tag ${t + 1}`,
        color,
        createdAt: new Date(Date.UTC(2025, 2, 1 + t)).toISOString()
      })))
      const teams = yield* sql<{ id: number }>`SELECT id FROM teams WHERE orgId = ${orgId} ORDER BY id`
      const tags = yield* sql<{ id: number }>`SELECT id FROM tags WHERE orgId = ${orgId} ORDER BY id`
      yield* insertChunked("users", Array.from({ length: usersPerOrg }, (_, i) => ({
        orgId,
        name: `${first[i % first.length]} ${last[(i * 7) % last.length]} ${i}`,
        email: `user${i}@org${o}.load.test`,
        role: roles[(i * 3) % roles.length]!,
        active: i % 4 === 0 ? 0 : 1,
        createdAt: new Date(Date.UTC(2024, 0, 1) + i * 60_000 * 37).toISOString(),
        teamId: i % 6 === 0 ? null : teams[i % teams.length]!.id,
        startDate: i % 3 === 0 ? null : new Date(Date.UTC(2023, 0, 1) + (i % 900) * 864e5).toISOString().slice(0, 10)
      })))
      const users = yield* sql<{ id: number }>`SELECT id FROM users WHERE orgId = ${orgId} ORDER BY id`
      yield* insertChunked("user_tags", users.flatMap((u) =>
        tags.filter((_, k) => (u.id * (k + 3)) % 7 < 2).map((t) => ({ userId: u.id, tagId: t.id, orgId }))))
      yield* insertChunked("accounts", Array.from({ length: accountsPerOrg }, (_, k) => ({
        orgId,
        email: `load${o}-${k}@load.test`,
        name: `Load ${o}.${k}`,
        passwordHash,
        createdAt: new Date(Date.UTC(2025, 0, 1)).toISOString()
      })))
    }))
    yield* Effect.logInfo(`Seeded ${name}: ${usersPerOrg} users, ${accountsPerOrg} accounts`)
  }
})

/**
 * SQLite + migrations + seed. Use `":memory:"` for tests. `seed: "load"` adds
 * the load-test organizations (see `loadSeed`) after the demo data.
 */
export const layer = (options: { readonly filename: string; readonly seed?: boolean | "load" }) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // SQLite only enforces foreign keys when asked, per connection.
    yield* sql`PRAGMA foreign_keys = ON`
    const ran = yield* SqliteMigrator.run({ loader: migrations })
    for (const [id, name] of ran) yield* Effect.logInfo(`Migrated ${id}_${name}`)
    if (options.seed ?? true) yield* seed
    if (options.seed === "load") yield* loadSeed
  })).pipe(Layer.provideMerge(SqliteClient.layer({ filename: options.filename })))
