/** Messages between the load coordinator (`run.ts`) and its client workers (`clients.ts`). */

/** One simulated tab: a live view to open. */
export interface ClientSpec {
  readonly index: number
  /** Index into the organizations of the run (not the database id). */
  readonly org: number
  /** Which server process it talks to (index into the run's servers). */
  readonly server: number
  readonly port: number
  readonly cookie: string
  /** Path with the `datastar` query param. */
  readonly path: string
  readonly kind: "list" | "detail"
  readonly resource: "users" | "teams" | "tags"
  /** Signal namespace (DOM id prefix). */
  readonly ns: string
  /** The list query (for reports). */
  readonly query?: unknown
  /** Columns the list query sorts or filters on: a change to one may move rows. */
  readonly queryColumns: ReadonlyArray<string>
  /** Whether a row inserted by the writers lands on this list's page (newest first, page 1, filters it matches). */
  readonly insertLandsOnPage?: boolean
  readonly recordId?: number | undefined
  /** Stops reading its socket after the first event. */
  readonly slow?: boolean
}

/** A completed write, sent to every worker once its HTTP response arrived. */
export interface Descriptor {
  readonly seq: number
  readonly kind: "update" | "insert" | "delete" | "bulk" | "team"
  readonly org: number
  /** Which server took the write. */
  readonly server: number
  /** The rows written (update, delete: one; bulk: several; insert: the new one). */
  readonly ids: ReadonlyArray<number>
  /** The column an update changed (`email` or `name`). */
  readonly column: string
  /** When the HTTP response arrived (epoch ms, sub-ms precision). */
  readonly sent: number
}

export type ToWorker =
  | { readonly type: "init"; readonly specs: ReadonlyArray<ClientSpec> }
  | { readonly type: "open"; readonly concurrency: number }
  | { readonly type: "phase"; readonly phase: "setup" | "write" | "after" }
  | { readonly type: "desc"; readonly descriptors: ReadonlyArray<Descriptor> }
  | { readonly type: "storm" }
  | { readonly type: "report" }
  | { readonly type: "close" }

export interface WorkerReport {
  readonly clients: number
  readonly connected: number
  readonly failed: number
  readonly failures: ReadonlyArray<string>
  /** Time to first event per client, ms. */
  readonly ttfe: ReadonlyArray<number>
  /** Mutation-to-patch latency per kind, ms, one sample per (expected client, mutation) delivered. */
  readonly latency: Readonly<Record<string, ReadonlyArray<number>>>
  /** The same samples split by whether the client is on another server process than the write. */
  readonly crossLatency: ReadonlyArray<number>
  readonly sameLatency: ReadonlyArray<number>
  readonly expected: number
  readonly delivered: number
  /** Expected but skipped for a later write to the same row (coalescing). */
  readonly superseded: number
  readonly misses: number
  readonly missSamples: ReadonlyArray<string>
  /** Tags of another organization seen by a client: must be 0. */
  readonly leaks: number
  readonly leakSamples: ReadonlyArray<string>
  /** Bytes and events received during the write phase. */
  readonly phaseBytes: number
  readonly phaseEvents: number
}
