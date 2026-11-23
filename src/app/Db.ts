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
})

/** SQLite + migrations + seed. Use `":memory:"` for tests. */
export const layer = (options: { readonly filename: string; readonly seed?: boolean }) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // SQLite only enforces foreign keys when asked, per connection.
    yield* sql`PRAGMA foreign_keys = ON`
    const ran = yield* SqliteMigrator.run({ loader: migrations })
    for (const [id, name] of ran) yield* Effect.logInfo(`Migrated ${id}_${name}`)
    if (options.seed ?? true) yield* seed
  })).pipe(Layer.provideMerge(SqliteClient.layer({ filename: options.filename })))
