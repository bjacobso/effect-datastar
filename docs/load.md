# Live views under load

Every open list or detail page holds a long-lived SSE stream (`GET /users/view`,
`/users/:id/view`) that re-runs its query when a write invalidates it. Does that
scale? This is what one server process costs per open tab and per write, where it
tops out, and what was fixed on the way.

**Short answer.** As first measured, no: at 1,000 open tabs the server sustained
under 3 writes/s and patches arrived seconds late. After six changes, one Node process
holds **10,000 live streams** with 5 writes/s at a p50/p99 of **19 / 140 ms** from a
write's HTTP response to each affected tab's patch, using about **37 KB of heap per
stream**, and 1,000 tabs at 50 writes/s see **3 / 68 ms**. The limit now is the bytes it
fans out: about 14 MB of SSE per write at 10k tabs, which takes the main thread's
`writev` calls and the kernel's sockets.

## Machine

| | |
| --- | --- |
| CPU | Apple M2 Max, 12 cores (8 performance, 4 efficiency) |
| RAM | 32 GB |
| OS | macOS 27.2 |
| Node | 24.13.0 |
| Limits | `ulimit -n` 1,048,576; `kern.maxfilesperproc` 122,880; ephemeral ports 49152–65535 (16,384); `kern.ipc.somaxconn` **128** (the listen backlog: it matters for reconnect storms) |

The clients, the writers and the server all run on this machine and talk over
loopback. The server is one Node process (one thread) unless noted; the clients run in
6 worker threads, so they don't compete with it for the same core. No `ulimit` change
was needed.

## The harness

`scripts/load/` (run with Node's type stripping, no build step):

- `run.ts`: the coordinator, an Effect program. It seeds `.load/template.db` once
  (`SEED=load`), starts one or two servers (`node dist/server.js`, `METRICS=1`) on a
  copy, signs in, opens the tabs, writes, samples `GET /_metrics` every second and
  writes `.load/results/<label>.json`.
- `clients.ts`: worker threads holding the tabs. Each tab is a plain `node:http`
  request, `GET <path>?datastar=<signals>` with `datastar-request: true` and the
  session cookie, exactly as `test/support.ts` and Datastar do. It parses the SSE
  events and keeps the row ids on its page.
- `table.ts`, `profile.ts`: markdown tables of results, and a summary of a
  `--cpu-prof` profile.

**Data** (`SEED=load`, `src/app/Db.ts`): the demo data plus 10 organizations
(`Load 1`..`Load 10`), each with 5,000 users, 10 teams, 8 tags and 50 sign-ins
(`load<org>-<k>@load.test`, password `load-password`). Tabs reuse a session per
account.

**Tabs.** Spread round-robin over the 10 organizations, each picks a view from a fixed
mix (deterministic, so runs compare): the default users list 35%, pages 2–5 10%,
sorted by name, email or start date 11%, filtered by role, active, team, name or tag
19%, 50 per page 5%, a user's detail page 15% (one of each organization's 20 newest
users), the teams list 3% and the tags list 2%. Identical views recur: at 1,000 tabs
there are 287 distinct (organization, view) pairs, at 10,000 about 400.

**Writes**, through the real endpoints, in a random organization: update a user's
email (45%) or name (10%) with `PUT /api/users/:id`, insert (15%, `POST /api/users`),
delete a row the writers inserted (15%, `DELETE /api/users/:id`), bulk "set role" on up
to 5 users (10%, `POST /users/bulk/update`, the Datastar action), and rename a team (5%).

**What is measured**

- Server (`GET /_metrics`, only with `METRICS=1`, `src/metrics/Metrics.ts`): RSS and
  heap, CPU (user + system: over 100% means the kernel's socket work on other cores),
  event-loop delay (`monitorEventLoopDelay`), SQL statements and the time spent in
  them, React renders and their time, open SSE streams, bytes and events sent,
  re-queries.
- Time to first event when a tab opens (TTFE).
- **Mutation-to-patch latency**: every written value carries a tag (`ld<seq>o<org>x`).
  After each write's HTTP response the coordinator tells the workers what it wrote;
  each tab decides from its own state whether it *should* show the change (a detail
  page of that user; a list whose page shows the row and whose query doesn't sort or
  filter on the changed column; for an insert, a newest-first page 1 whose filters
  match), and the latency is the time from the response to the first event carrying
  the tag (for a delete, to the first table without the row).
- **Correctness**: a tab that should see a change and never does is a miss. Two
  things don't count: another write to the same row showing up instead (concurrent
  writes to one row land in either order; the server may coalesce them), and the row
  leaving the page (a concurrent insert pushing it to page 2). Any tag of another
  organization seen by a tab is a **leak**.
- Bytes sent per write, all streams together.

**Running it**

```sh
npm run build
npm run load -- --streams 1000 --rate 5 --duration 20                 # steady writes
npm run load -- --streams 1000 --rate 50 --duration 20
npm run load -- --scenario burst --streams 1000 --burst 500           # 500 writes, 50 in flight
npm run load -- --scenario burst --streams 1000 --burst 500 --write-orgs 1   # all in one organization
npm run load -- --scenario slow --streams 5000 --slow 0.05 --rate 20 --duration 60
npm run load -- --servers 2 --streams 2000 --rate 50                  # two processes, one database
npm run load -- --scenario storm --streams 5000 --rate 5 --duration 40 [--jitter]
node scripts/load/table.ts 'final-*'                                  # a results table
npm run load -- --streams 10000 --rate 50 --duration 15 --profile     # + node --cpu-prof
node scripts/load/profile.ts .load/prof/*.cpuprofile
```

Other options: `--server <bundle>` (compare builds: copy `dist/` aside), `--port`
(default 4300; servers use the next ports), `--orgs`, `--workers`,
`--open-concurrency`, `--poll-interval`, `--label`. The server runs with
`NODE_ENV=production` unless the environment says otherwise.

## Results before

The repository as it was, served as `npm run serve` served it (React in development
mode, see fix 1):

| run | streams | writes/s | TTFE p50/p99 ms | latency p50/p95/p99/max ms | missed | leaks | CPU % | ELD p99 ms | RSS MB (open/peak) | heap KB/stream | SQL/write | renders/write | KB sent/write |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100, 5/s | 100 | 5 | 894 / 1584 | 17 / 129 / 151 / 210 | 0/293 | 0 | 28 | 125 | 237/292 | 193 | 21 | 8 | 237 |
| 100, 50/s | 100 | 27.9 | 505 / 1217 | 141 / 1284 / 2811 / 8927 | 12/1742 | 0 | 72 | 2991 | 187/336 | 193 | 16 | 6 | 178 |
| 1k, 5/s | 1000 | 2.7 | 1258 / 2540 | 488 / 5599 / 6070 / 6103 | 1/2790 | 0 | 83 | 1414 | 333/543 | 182 | 122 | 77 | 2687 |
| 1k, 50/s | 1000 | 3.2 | 1101 / 1574 | 220 / 2768 / 4313 / 29287 | 48/5192 | 0 | 89 | 5029 | 336/423 | 184 | 121 | 73 | 2443 |
| 1k, burst 500 | 1000 | 3.1 | 1304 / 3164 | 1265 / 4902 / 10272 / 43815 | 26/12670 | 0 | 79 | 10553 | 365/669 | 182 | 109 | 62 | 2202 |
| 5k, 5/s | 5000 | 0.8 | 1206 / 8463 | 408 / 4035 / 8743 / 10911 | 0/12881 | 0 | 99 | 10972 | 736/960 | 178 | 581 | 378 | 12272 |

"writes/s" is what the server actually sustained: the writers keep up to 200 requests
in flight, and at 1,000 tabs the server got through fewer than 3 a second. The 500-write
burst took 145 s. (The few misses in these runs were mostly concurrent writes and
moved rows, which the harness only learned to tell apart later.)

A CPU profile at 1,000 tabs, 5 writes/s: 43% of the busy time in React rendering (in
its development build), 35% in SQLite, the rest Effect, SSE encoding and GC. Per write:
25 page re-queries, 76 renders, 120 statements.

## Fixes

Each is one commit; the before/after numbers are from the same harness scenario
(1,000 tabs at 5 and 50 writes/s, and the 500-write burst, unless noted).

| run | streams | writes/s | latency p50/p99 ms | CPU % | ELD p99 ms | heap KB/stream | SQL/write | renders/write | KB sent/write | 500-write burst |
|---|---|---|---|---|---|---|---|---|---|---|
| before | 1000 | 2.7 / 3.2 | 488 / 6070 | 83 | 1414 | 182 | 122 | 77 | 2687 | 145 s |
| 1. production React | 1000 | 5 / 6.1 | 176 / 1557 | 83 | 1196 | 185 | 120 | 79 | 2613 | 44 s |
| 2. records wake for their own row | 1000 | 4.7 / 5.8 | 239 / 2216 | 78 | 1850 | 186 | 80 | 60 | 2387 | 43 s |
| 3. shared live tables | 1000 | 5 / 23.4 | 8 / 134 | 27 | 249 | 72 | 28 | 16 | 2675 | 9.7 s |
| 4. list indexes | 1000 | 5 / 50 | 7 / 82 | 21 | 333 | 72 | 28 | 16 | 2675 | 5.4 s |
| 5. shared live records | (see below) | | | | | | | | | |
| 6. send only what changed | 1000 | 5 / 50 | 4 / 54 | 17 | 86 | 73 | 27 | 15 | 2223 | 4.8 s |

(writes/s: sustained at 5/s and 50/s offered. Latency, CPU, ELD and the rest: at 5/s.)

**1. Serve with `NODE_ENV=production`** (`package.json`). `npm run serve` ran React's
development build: every render validated props and built dev-only element metadata.
Rendering was the largest single cost. Throughput doubled (2.7 → 5 writes/s at 1k
tabs), latency p50 fell from 488 to 176 ms, the burst from 145 to 44 s.

**2. A live record wakes only for its own row** (`Resource.tsx`). The detail page's
stream listened on the table's key, so *every* write in the organization re-read
the record and both lookups and re-rendered it, for every open detail page. It now
listens on the row's record key (`users[orgId=1]:42`, which the repo invalidates
with each change to the row), the bare table key and the related tables' keys, and
sends nothing if the render didn't change. SQL per write 120 → 80, renders 79 → 60.
(The server was still saturated, so latency didn't improve yet.)

**3. Share live tables between tabs that show the same query**
(`src/datastar/Shared.ts`, `Resource.tsx`). This was the big one. Each tab ran its own
page query, COUNT and render; on an insert every tab of the organization did, though
most of them showed the same thing (35% of tabs are an organization's default list).
Now identical views share one *source*, keyed by tenant, embed lock and query:

- The first tab starts it, the last one stops it; it runs with only the tenant
  service of the request that started it, so it holds no request.
- Every tab starts from the source's *snapshot* (the table with row patches applied,
  all relation selects, the page's ids, and for a new tab the canonical URL), so a tab
  that joins a running view costs no query at all. Then it gets the shared deltas.
- Each event is encoded to bytes once (a `WeakMap` in `Datastar.respond`), and a batch
  of events is one socket write.
- **Tenant isolation**: the key contains the organization, so two organizations with
  the same query have two sources (`test/shared.test.ts` checks it, and that a Globex
  write never reaches an Acme tab). No run had a cross-organization leak.

1k tabs at 5 writes/s: p50/p99 239/2216 → 8/134 ms, CPU 78 → 27%, renders per write
60 → 16, heap per stream 186 → 72 KB. At 50/s offered: 5.8 → 23.4 sustained. Burst:
43 → 9.7 s.

**4. Index list queries by organization and sort column** (`Db.ts`, migration
`0006_list_indexes`). Every list query is `WHERE orgId = ? ORDER BY <column>`. With
only `users(orgId)` SQLite read an organization's 5,000 rows and sorted them for every
page, about 1 ms; with `(orgId, column)` it reads the page, 0.02 ms. Live views re-run
it on every insert and delete. SQL time at 5 writes/s 88 → 30 ms/s; 1k tabs now sustain
50 writes/s (23.4 before) at p50/p99 12/278 ms; the burst 9.7 → 5.4 s.

**5. Share live records, bound what a stalled tab holds** (`Resource.tsx`). The
record stream used `Reactivity.stream`, whose result queue is unbounded: a tab that
stopped reading kept every version of the record. Records now go through `Shared`
too: one read and render per change for all tabs of a record, and a stalled tab
holds at most 16 pending events before it is switched to the latest snapshot. In
practice this was not yet a leak (since fix 2 a stalled record only grows on changes
to its own row): 300 tabs, 143 stalled, 10 writes/s for 90 s left heap after GC at
98 → 104 MB with and without it. It closes the hole rather than fixing a measured one.

**6. Send only what a re-query changed** (`Resource.tsx`, `components.tsx`). A re-query
re-sent the whole table (~20 KB) to every tab even when it rendered the same (an insert
the filter excludes) or only the total changed (an insert that sorts onto another page).
The source now compares the render with the last one and sends nothing, just the
pagination (`<nav id="users-pagination">`), or the table; `_page` only when the ids
changed. At 10k tabs, 5 writes/s: CPU 96 → 61%, KB per write 22,082 → 18,444, p99 284 →
140 ms; at 50 writes/s offered, 16.4 → 35.7 sustained, p99 2275 → 847 ms.

**Verified and not changed: coalescing invalidations.** A burst of N writes does *not*
cause N re-queries per view. `Repo.live` takes every signal that arrived while it was
busy as one batch (`Queue.takeAll`), and with shared sources a batch includes the
render and fan-out time, so under load the batches grow by themselves. 500 writes as
fast as possible into **one** organization (1k tabs): 372 writes/s, about 0 re-queries
per write (23 re-queries/s in total), p50/p99 35/113 ms. An explicit throttle (at most
one re-query per view per 50 ms, tried as `LIVE_COALESCE`) made it worse: 231 writes/s,
p50/p99 83/265 ms. It was removed.

**SQLite contention** wasn't a bottleneck either: SQL took 2–10% of the main thread
after fix 4. `node:sqlite` is synchronous on the one connection, so "contention" is
just serialization on the event loop, and the statements are short. Idle, the
cross-process poll is 10 statements/s per process (`PRAGMA data_version` every 100 ms).

## Results after

The final build (all fixes):

| run | streams | writes/s | TTFE p50/p99 ms | latency p50/p95/p99/max ms | missed | leaks | CPU % | ELD p99 ms | RSS MB (open/peak) | heap KB/stream | SQL/write | renders/write | KB sent/write |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100, 5/s | 100 | 5 | 286 / 401 | 5.7 / 25 / 32 / 45 | 0/290 | 0 | 12 | 50 | 367/409 | 162 | 13 | 4 | 194 |
| 100, 50/s | 100 | 50 | 170 / 225 | 1.7 / 8.4 / 13 / 45 | 0/2789 | 0 | 36 | 34 | 237/469 | 161 | 11 | 4 | 177 |
| 1k, 5/s | 1000 | 5 | 75 / 251 | 4.3 / 32 / 54 / 182 | 0/2983 | 0 | 17 | 86 | 380/452 | 73 | 27 | 15 | 2223 |
| 1k, 50/s | 1000 | 50 | 77 / 219 | 2.8 / 30 / 68 / 152 | 0/28020 | 0 | 83 | 165 | 376/912 | 73 | 24 | 14 | 1957 |
| 5k, 5/s | 5000 | 5 | 23 / 229 | 13 / 51 / 77 / 195 | 0/13626 | 0 | 26 | 106 | 541/654 | 41 | 31 | 18 | 10020 |
| 5k, 50/s | 5000 | 49.7 | 20 / 190 | 79 / 248 / 502 / 9040 | 0/144535 | 0 | 119 | 702 | 511/906 | 41 | 24 | 13 | 8347 |
| 10k, 5/s | 10000 | 5 | 20 / 155 | 19 / 99 / 140 / 329 | 0/30971 | 0 | 61 | 344 | 731/894 | 37 | 29 | 15 | 18444 |
| 10k, 50/s offered | 10000 | 35.7 | 20 / 167 | 212 / 688 / 847 / 6484 | 72/265910 | 0 | 238 | 950 | 682/953 | 37 | 22 | 12 | 13760 |
| 1k, burst 500 | 1000 | – | 69 / 255 | 139 / 315 / 358 / 3262 | 1/13701 | 0 | 94 | 422 | 316/702 | 72 | 16 | 8 | 1113 |
| 5k, burst 500 | 5000 | – | 21 / 164 | 201 / 445 / 510 / 2153 | 43/73717 | 0 | 114 | 558 | 617/963 | 41 | 18 | 9 | 5383 |
| 10k, burst 500 | 10000 | – | 26 / 186 | 313 / 1210 / 1416 / 6420 | 4/148746 | 0 | 205 | 1849 | 640/1006 | 37 | 21 | 11 | 13647 |

By kind at 10k tabs, 5 writes/s: a single-row update (a row patch) p50/p99 11.5/41 ms,
an insert (a re-query, a new table for most tabs) 46/174 ms. At 1k: 2.3/14 and 8.6/135 ms.

TTFE (time to the first event of a new tab) *falls* as tabs are added: most join a
running shared view and get its snapshot without a query.

The remaining misses (0.003–0.06% of expected deliveries) appear only at saturation
(10k tabs at 50/s offered, bursts with 50 writes in flight) and always involve several
writes to the same few rows in flight at once: bulk role changes on detail pages, and in
the 5k burst one email update that every list tab showing the row missed. The writers
build each request from their own copy of the row, so with two requests in flight a
later-landing one can restore an older value, and the harness's expectation (and its
"superseded" check) is then wrong rather than the server. I could not rule out a server
race completely; none appears at 5 writes/s or in the 1k/5k steady runs, and no run
ever showed a cross-organization leak.

### Bursts

| | 1k tabs | 5k tabs | 10k tabs |
| --- | --- | --- | --- |
| 500 writes, 50 in flight, before | 145 s (3 writes/s) | | |
| after | 4.8 s (105 writes/s) | 6.1 s (81 writes/s) | 20.1 s (25 writes/s) |
| all tabs caught up | at the last response + 0.003 s | + 0.05 s | + 0.007 s |
| all into one organization (1k tabs) | 1.3 s (372 writes/s), p99 113 ms | | |

The server never falls behind its writes: once the last write's response is out, every
tab has its patch within milliseconds, because a view handles whatever piled up as one
batch.

### Slow consumers

`--slow`: a fraction of the tabs stop reading their socket after the first event (the
TCP window fills, the server's writes see backpressure).

- **There is backpressure**: `HttpServerResponse.stream` waits for `drain` before it
  pulls the next chunk. A stalled tab's shared subscription then holds at most 16
  pending events (references to the events every other tab got too) before it is
  switched to the snapshot, which supersedes them.
- **Memory stays flat**: 5,000 tabs, 266 stalled, 20 writes/s for 60 s: heap after GC
  264 MB opened, 255 MB at the end; 300 tabs with 143 stalled for 90 s, 98 → 104 MB.
- **Others aren't hurt**: the healthy tabs in the 5k run saw p50/p99 6.8/84 ms, the same
  as without stalled tabs.
- **The kernel is the limit here**: with 1,060 of 5,000 tabs stalled (`--slow 0.2`), the
  stalled sockets filled their send and receive buffers (up to 128 KB–4 MB each, both
  ends on this machine) and macOS ran out of network buffers: new connections failed
  with `ENOBUFS` (the harness's own metrics requests). The Node process was fine. On a
  real network a stalled browser's receive buffer is on its machine, but the server's
  send buffers are still kernel memory per stalled socket. See recommendations.

### Two server processes on one database

`--servers 2`: tabs and writes split evenly; a write on A reaches B's tabs through the
`reactivity_invalidations` table, polled every 100 ms.

| | same process p50/p95/p99 | other process p50/p95/p99 | CPU (A + B) | idle poll cost |
| --- | --- | --- | --- | --- |
| 2k tabs, 50 writes/s | 4 / 23 / 39 ms | 64 / 115 / 144 ms | 52% + 54% | 10 statements/s each |
| 10k tabs, 5 writes/s | 17 / 115 / 188 ms | 62 / 190 / 254 ms | 37% + 23% | 10 statements/s each |

Cross-process latency is the poll interval's average wait (50 ms) plus the same work;
lower it with `INVALIDATION_POLL_INTERVAL`. 10k tabs over two processes used 37% and 23%
CPU where one process needed 61%: shared views are per process, so each pays for its
own distinct views, but the fan-out is split.

### Reconnect storm

`--scenario storm`: after writes are running, every tab drops its connection (a TCP
reset, as when a browser is killed) and all reconnect at once. Failed connects are
retried as Datastar does (1 s, doubling, at most 30 s, 10 retries: `public/datastar.js`,
which has no jitter).

| | 5k tabs | 10k tabs |
| --- | --- | --- |
| Datastar's retry (no jitter) | after 182 s, 3,272 reconnected, **1,728 gave up**; 37,620 retries | after 182 s, 7,838 reconnected, **2,162 gave up** |
| with full jitter (`--jitter`) | all 5,000 in 8.9 s (p50 1.9 s, p99 4.9 s) | all 10,000 in 17.1 s (p50 2.5 s, p99 9.0 s) |
| server CPU during it | 7% | 15% |

The server isn't the problem: it was nearly idle. macOS's listen backlog is 128
(`kern.ipc.somaxconn`, which caps Node's 511), and connections beyond it are reset.
Without jitter every tab retries at the same instants (1 s, 3 s, 7 s, ...), so each round
only about 128 get in, and the writers' own requests failed alongside (`fetch failed`).
With jitter the same server takes 10,000 reconnects in 17 s.

## Where it tops out, and what bounds it

- **10,000 streams on one process is reachable** on this machine, with headroom at
  5 writes/s (61% CPU, p99 140 ms). The machine's other limits (16k ephemeral ports,
  file descriptors) were not reached.
- **At 50 writes/s it saturates between 5k and 10k tabs** (49.7 sustained at 5k; 35.7 at
  10k), and in bursts at about 25 writes/s with 10k tabs.
- **What bounds it now is fan-out bytes**, not queries. A CPU profile at 10k tabs and
  50 writes/s offered: socket `writev` 16% of all samples, the Effect runtime (a stream
  per tab) 12%, GC 6%, React rendering 10%, SQLite 6%, idle 30%. Every insert sends a
  new table (about 20 KB) to each of an organization's ~850 list tabs: about 14 MB per
  write, and the kernel's socket work shows up as CPU over 100% (238%).
- **Memory per stream**: about 37 KB of heap and 40 KB of RSS at 10k (73 KB of heap at 1k,
  where fixed costs weigh more). Before: about 180 KB. 10k tabs fit in 730 MB RSS.
- **CPU per re-query**: a page query plus COUNT is 0.05–0.2 ms with the indexes, a table
  render about 0.5–1 ms. With sharing, it's per distinct view (about 40 per organization
  here), not per tab.
- **Event loop**: p99 delay 0.1–0.35 s at 5–10k tabs and 5 writes/s, about 1 s when
  saturated: the fan-out of one change to thousands of sockets runs in one go.
- **SQLite** is not the limit (2–10% of the thread).

## What would come next at larger scale

1. **Send smaller patches.** An insert re-sends the whole table to every tab. Sending the
   changed rows instead (a new `<tr>` to prepend, the last one to remove, the
   pagination) would cut most of the 14 MB per write. Datastar's morph would apply it
   just as well.
2. **Jitter reconnects.** Datastar retries without jitter, and a restart or a network
   blip makes every tab reconnect at once. Set a per-page randomized
   `retryInterval` on the live views' `@get` (e.g. `500 + Math.random() * 1000`), and
   raise the listen backlog (`kern.ipc.somaxconn` / `net.core.somaxconn`) on servers.
3. **Bound stalled sockets.** A tab that stays blocked for, say, 30 s should be closed
   (Datastar reconnects and gets a snapshot) and the server's send buffer per SSE socket
   capped, so a few thousand dead tabs can't hold the kernel's network memory.
4. **Spread the fan-out.** One process does the queries, renders and every socket write.
   More processes behind a load balancer split the writes (the poll costs ~10
   statements/s each); sticky routing by organization would also keep each process's
   shared views to its own organizations. Beyond a few processes, replace the polled
   table with a push transport (`Broadcast` for Postgres `LISTEN/NOTIFY` or Redis), and
   move SSE fan-out to something built for it (a Node worker per core, or an edge
   pub/sub) with the app publishing rendered patches once.
5. **Compress.** SSE compresses very well (the tables are repetitive), but per
   connection; it would trade CPU for bandwidth on real networks.
6. **Batch encodings per subscriber.** A multi-event batch is concatenated per tab
   (`batchBytes`, 4% at 10k); writing the shared encoded events with `cork`/`writev`
   instead would avoid the copy.
