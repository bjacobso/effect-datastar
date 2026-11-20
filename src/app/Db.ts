import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

const migrate = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    active INTEGER NOT NULL,
    createdAt TEXT NOT NULL
  )`
  const existing = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM users`
  if ((existing[0]?.count ?? 0) > 0) return
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
  yield* Effect.logInfo(`Seeded ${rows.length} users`)
})

export const DbLive = Layer.effectDiscard(migrate).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: "app.db" }))
)
