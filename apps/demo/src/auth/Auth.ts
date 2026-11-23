/**
 * Sign-in and sessions.
 *
 * - `CurrentUser` and `CurrentOrg` are request-level services: the session
 *   middleware (`Middleware.ts`) provides them to every protected handler, and
 *   tenant-scoped resources read `CurrentOrg` to bound their queries.
 * - `Sessions` signs in (scrypt, see `Password.ts`), resolves a session cookie
 *   and signs out. A session token is 32 random bytes; the database keeps only
 *   its SHA-256, and sessions expire after `ttl`.
 *
 * Accounts are not the `users` resource: that one is CRUD data any member of
 * an organization can list, edit and delete, and it reaches the JSON API and
 * live views. Credentials never go near it.
 */
import { Config, Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import type { Cookies } from "effect/http"
import { SqlClient } from "effect/sql"
import { createHash, randomBytes } from "node:crypto"
import { OrgId } from "../app/Org.ts"
import * as Password from "./Password.ts"

export const AccountId = Schema.Int.pipe(Schema.brand("AccountId"))
export type AccountId = typeof AccountId.Type

/** The signed-in account. */
export class CurrentUser extends Context.Service<CurrentUser, {
  readonly id: AccountId
  readonly email: string
  readonly name: string
  readonly orgId: OrgId
}>()("effect-datastar/auth/CurrentUser") {}

/** The signed-in account's organization: the tenant of every scoped resource. */
export class CurrentOrg extends Context.Service<CurrentOrg, {
  readonly id: OrgId
  readonly name: string
}>()("effect-datastar/auth/CurrentOrg") {}

export interface Session {
  readonly user: CurrentUser["Service"]
  readonly org: CurrentOrg["Service"]
}

/** The session cookie's name. */
export const COOKIE = "session"

const SessionRow = Schema.Struct({
  id: AccountId,
  email: Schema.String,
  name: Schema.String,
  orgId: OrgId,
  orgName: Schema.String
})
const AccountRow = Schema.Struct({ ...SessionRow.fields, passwordHash: Schema.String })
const decodeSession = Schema.decodeUnknownEffect(Schema.Array(SessionRow))
const decodeAccount = Schema.decodeUnknownEffect(Schema.Array(AccountRow))

const toSession = (row: typeof SessionRow.Type): Session => ({
  user: { id: row.id, email: row.email, name: row.name, orgId: row.orgId },
  org: { id: row.orgId, name: row.orgName }
})

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex")

export class Sessions extends Context.Service<Sessions, {
  /** A new session for valid credentials (`None` otherwise, with no hint which part was wrong). */
  readonly signIn: (
    email: string,
    password: string
  ) => Effect.Effect<Option.Option<{ readonly token: string; readonly session: Session }>>
  /** The session for a cookie value, if it exists and hasn't expired. */
  readonly resolve: (token: string | undefined) => Effect.Effect<Option.Option<Session>>
  readonly signOut: (token: string | undefined) => Effect.Effect<void>
  /** Options for the session cookie: HttpOnly, SameSite=Lax, Secure if `SECURE_COOKIES=true`. */
  readonly cookie: Cookies.Cookie["options"]
}>()("effect-datastar/auth/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const ttl = yield* Config.Duration("SESSION_TTL").pipe(Config.withDefault(Duration.days(7)))
      const secure = yield* Config.Boolean("SECURE_COOKIES").pipe(Config.withDefault(false))
      const now = Effect.map(DateTime.now, DateTime.formatIso)

      const signIn = (email: string, password: string) =>
        Effect.gen(function*() {
          const rows = yield* sql`
            SELECT a.id, a.email, a.name, a.orgId, o.name AS orgName, a.passwordHash
            FROM accounts a JOIN orgs o ON o.id = a.orgId
            WHERE a.email = ${email.trim()}`.pipe(Effect.flatMap(decodeAccount))
          const account = rows[0]
          // Unknown emails cost the same as wrong passwords.
          const ok = yield* Password.verify(password, account?.passwordHash ?? Password.decoy)
          if (account === undefined || !ok) return Option.none()
          const token = randomBytes(32).toString("base64url")
          const created = yield* DateTime.now
          yield* sql`DELETE FROM sessions WHERE expiresAt <= ${DateTime.formatIso(created)}`
          yield* sql`INSERT INTO sessions ${
            sql.insert({
              tokenHash: tokenHash(token),
              accountId: account.id,
              createdAt: DateTime.formatIso(created),
              expiresAt: DateTime.formatIso(DateTime.addDuration(created, ttl))
            })
          }`
          return Option.some({ token, session: toSession(account) })
        }).pipe(Effect.orDie, Effect.withSpan("Sessions.signIn"))

      const resolve = (token: string | undefined) =>
        token === undefined || token === ""
          ? Effect.succeedNone
          : Effect.gen(function*() {
            const rows = yield* sql`
              SELECT a.id, a.email, a.name, a.orgId, o.name AS orgName
              FROM sessions s JOIN accounts a ON a.id = s.accountId JOIN orgs o ON o.id = a.orgId
              WHERE s.tokenHash = ${tokenHash(token)} AND s.expiresAt > ${yield* now}`.pipe(Effect.flatMap(decodeSession))
            return Option.map(Option.fromNullishOr(rows[0]), toSession)
          }).pipe(Effect.orDie)

      const signOut = (token: string | undefined) =>
        token === undefined || token === ""
          ? Effect.void
          : sql`DELETE FROM sessions WHERE tokenHash = ${tokenHash(token)}`.pipe(Effect.asVoid, Effect.orDie)

      return Sessions.of({
        signIn,
        resolve,
        signOut,
        cookie: { httpOnly: true, sameSite: "lax", path: "/", secure, maxAge: ttl }
      })
    })
  )
}
