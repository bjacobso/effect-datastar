/**
 * The resources, assembled. Relations and detail-page sections are attached
 * here, where every definition is in scope: users reference teams, and a
 * team's page embeds its users.
 */
import * as Resource from "../crud/Resource.tsx"
import { Teams } from "./Teams.tsx"
import { Users } from "./Users.tsx"

export const Resources = Resource.app(
  // Options, table labels and live invalidation for `teamId` come from the teams resource.
  Users.with({ relations: { teamId: Teams } }),
  // `GET /teams/:id` lists the team's members: the users table with `teamId` locked to the team.
  Teams.with({ sections: [Users.embed({ name: "members", title: "Members", lock: "teamId" })] })
)
