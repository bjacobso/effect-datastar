import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { Migrator, SqlClient } from "effect/sql"

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
  })
})

const seed = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const count = (table: string) =>
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`.pipe(Effect.map((r) => r[0]?.n ?? 0))

  if ((yield* count("teams")) === 0) {
    const names = ["Platform", "Growth", "Design", "Infrastructure", "Support"]
    yield* sql`INSERT INTO teams ${
      sql.insert(
        names.map((name, i) => ({ name, createdAt: new Date(Date.UTC(2025, 6, 1 + i * 9)).toISOString() })) as any
      )
    }`
  }

  if ((yield* count("users")) === 0) {
    const first = ["Ada", "Grace", "Alan", "Linus", "Barbara", "Edsger", "Margaret", "Ken", "Radia", "Dennis", "Frances", "John"]
    const last = ["Lovelace", "Hopper", "Turing", "Torvalds", "Liskov", "Dijkstra", "Hamilton", "Thompson", "Perlman", "Ritchie"]
    const roles = ["admin", "member", "member", "member", "guest"]
    const rows = Array.from({ length: 87 }, (_, i) => {
      const f = first[i % first.length]!
      const l = last[(i * 7) % last.length]!
      return {
        name: `${f} ${l}`,
        email: `${f}.${l}${i}@example.com`.toLowerCase(),
        role: roles[(i * 3) % roles.length]!,
        active: i % 4 === 0 ? 0 : 1,
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 36e5 * 31).toISOString()
      }
    })
    yield* sql`INSERT INTO users ${sql.insert(rows as any)}`
  }

  // First run with teams: spread users across them, leaving every 6th without a team.
  const assigned = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM users WHERE teamId IS NOT NULL`
  if ((assigned[0]?.n ?? 0) === 0) {
    const teamIds = (yield* sql<{ id: number }>`SELECT id FROM teams ORDER BY id`).map((t) => t.id)
    yield* Effect.forEach(teamIds, (teamId, k) =>
      sql`UPDATE users SET teamId = ${teamId}
          WHERE teamId IS NULL AND id % 6 != 0 AND id % ${teamIds.length} = ${k}`, { discard: true })
  }
})

export const DbLive = Layer.effectDiscard(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // SQLite only enforces foreign keys when asked, per connection.
    yield* sql`PRAGMA foreign_keys = ON`
    const ran = yield* SqliteMigrator.run({ loader: migrations })
    for (const [id, name] of ran) yield* Effect.logInfo(`Migrated ${id}_${name}`)
    yield* seed
  })
).pipe(Layer.provideMerge(SqliteClient.layer({ filename: "app.db" })))
