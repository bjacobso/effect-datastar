/**
 * Password hashing with `node:crypto` scrypt.
 *
 * Stored as `scrypt$N$r$p$salt$hash` (salt and hash base64url), so the cost
 * parameters can be raised later without invalidating existing hashes.
 * Verification recomputes with the stored parameters and compares in
 * constant time.
 */
import { Effect } from "effect"
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"

const N = 16384
const r = 8
const p = 1
const KEY_LENGTH = 64

const derive = (password: string, salt: Buffer, params: { N: number; r: number; p: number }) =>
  Effect.callback<Buffer>((resume) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { ...params, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      resume(error ? Effect.die(error) : Effect.succeed(key))
    })
  })

/** A new salted hash of `password`. */
export const hash = (password: string): Effect.Effect<string> =>
  Effect.gen(function*() {
    const salt = randomBytes(16)
    const key = yield* derive(password, salt, { N, r, p })
    return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$")
  })

/** Whether `password` matches `stored`. A malformed `stored` never matches. */
export const verify = (password: string, stored: string): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const [scheme, n, rr, pp, salt, expected] = stored.split("$")
    if (scheme !== "scrypt" || salt === undefined || expected === undefined) return false
    const key = yield* derive(password, Buffer.from(salt, "base64url"), { N: Number(n), r: Number(rr), p: Number(pp) })
    const want = Buffer.from(expected, "base64url")
    return want.length === key.length && timingSafeEqual(want, key)
  })

/**
 * A hash nobody's password matches, verified against when the email is
 * unknown, so a sign-in takes as long whether or not the account exists.
 */
export const decoy = ["scrypt", N, r, p, Buffer.alloc(16).toString("base64url"), Buffer.alloc(KEY_LENGTH).toString("base64url")]
  .join("$")
