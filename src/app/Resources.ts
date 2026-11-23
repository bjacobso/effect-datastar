/**
 * The resources, assembled. Relations and detail-page sections are attached
 * here, where every definition is in scope: users reference teams and tags,
 * and a team's page embeds its users.
 */
import * as Resource from "../crud/Resource.tsx"
import { Tags } from "./Tags.tsx"
import { Teams } from "./Teams.tsx"
import { Users } from "./Users.tsx"

export const Resources = Resource.app(
  Users.with({
    // Options, table labels and live invalidation for `teamId` come from the teams resource.
    relations: { teamId: Teams },
    // `tags` (stored in `user_tags`, see `User`) holds tag ids: options, chips and live updates from tags.
    manyToMany: { tags: Tags }
  }),
  // `GET /teams/:id` lists the team's members: the users table with `teamId` locked to the team.
  Teams.with({ sections: [Users.embed({ name: "members", title: "Members", lock: "teamId" })] }),
  Tags
)
