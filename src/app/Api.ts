/**
 * The JSON API: `/api/users`, `/api/teams`, the OpenAPI document at
 * `/api/openapi.json` and a Scalar reference at `/api/docs`.
 */
import { Layer } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiScalar, OpenApi } from "effect/http-api"
import * as Api from "../crud/Api.ts"
import { Resources } from "./Resources.ts"

export const UsersApi = Api.make(Resources.resources.users)
export const TeamsApi = Api.make(Resources.resources.teams)

export class AppApi extends HttpApi.make("effect-datastar")
  .add(UsersApi.group)
  .add(TeamsApi.group)
  .prefix("/api")
  .annotateMerge(OpenApi.annotations({
    title: "effect-datastar",
    description: "CRUD endpoints generated from the users and teams resources."
  }))
{}

export const ApiRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(AppApi, { openapiPath: "/api/openapi.json" }),
  HttpApiScalar.layer(AppApi, { path: "/api/docs" })
).pipe(
  Layer.provide([UsersApi.layer(AppApi), TeamsApi.layer(AppApi)])
)
