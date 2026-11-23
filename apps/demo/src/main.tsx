import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { createServer } from "node:http"
import { Infra, Routes } from "./app/App.tsx"

HttpRouter.serve(Routes).pipe(
  // `SEED=load` adds the load-test organizations and accounts (see `Db.ts` and `scripts/load/`).
  Layer.provide(Infra({ filename: process.env.DB ?? "app.db", seed: process.env.SEED === "load" ? "load" : true })),
  Layer.provide(NodeHttpServer.layer(createServer, { port: Number(process.env.PORT ?? 3000) })),
  Layer.launch,
  NodeRuntime.runMain
)
