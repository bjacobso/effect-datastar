/**
 * Counts SQL statements executed through `node:sqlite` in this test process,
 * by wrapping the `StatementSync` methods the driver uses.
 */
import { StatementSync } from "node:sqlite"

const executed: Array<string> = []
type Exec = (this: StatementSync, ...params: Array<never>) => unknown

for (const method of ["all", "run", "get", "iterate"] as const) {
  const original = StatementSync.prototype[method] as Exec
  ;(StatementSync.prototype as unknown as Record<string, Exec>)[method] = function(this: StatementSync, ...params) {
    executed.push(this.sourceSQL)
    return original.apply(this, params)
  }
}

/** Statements executed since the last `reset()`. */
export const sqlLog = {
  reset: () => {
    executed.length = 0
  },
  get statements(): ReadonlyArray<string> {
    return [...executed]
  },
  get count() {
    return executed.length
  }
}
