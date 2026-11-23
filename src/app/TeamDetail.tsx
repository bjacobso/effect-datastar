/**
 * `GET /teams/:id`: the team's (live) fields plus its members, which are the
 * users resource embedded with `teamId` locked to the team.
 *
 * This lives outside `Teams.tsx` because users depend on teams (the `teamId`
 * relation), so the teams config can't refer to users.
 */
import { Teams } from "./Teams.tsx"
import { Users } from "./Users.tsx"

export const TeamMembers = Users.embed({ name: "members", title: "Members", lock: "teamId" })

/** Teams routes, with the members table on the detail page. */
export const TeamRoutes = Teams.routesWith({ sections: (team) => [TeamMembers.Section(team.id)] })
