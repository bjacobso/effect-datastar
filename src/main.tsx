import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { createServer } from "node:http"
import { Infra, Routes } from "./app/App.tsx"

HttpRouter.serve(Routes).pipe(
  Layer.provide(Infra({ filename: process.env.DB ?? "app.db" })),
  Layer.provide(NodeHttpServer.layer(createServer, { port: Number(process.env.PORT ?? 3000) })),
  Layer.launch,
  NodeRuntime.runMain
)
