import * as stylex from "@stylexjs/stylex"
import { Effect } from "effect"
import type { ReactNode } from "react"
import { CurrentOrg, CurrentUser } from "../auth/Auth.ts"
import * as ds from "../datastar/Attrs.ts"
import * as Island from "../islands/Island.tsx"
import { Theme } from "../islands/islands.tsx"
import { Button } from "../ui/Button.tsx"
import { Logo } from "../ui/icons.tsx"
import { themeScript } from "../ui/theme/themes.ts"
import { color, font, radius, size, space } from "../ui/theme/tokens.stylex.ts"

const links = [["/users", "Users"], ["/teams", "Teams"]] as const

interface ShellProps {
  readonly title: string
  readonly active: string
  /** The signed-in account and its organization, shown in the header with a sign-out button. */
  readonly account?: { readonly name: string; readonly email: string; readonly org: string } | undefined
  readonly children: ReactNode
}

/**
 * The page shell for the resources, with the signed-in account (the session
 * middleware's `CurrentUser` and `CurrentOrg`) in the header.
 */
export const Layout = (props: { readonly title: string; readonly active: string; readonly children: ReactNode }) =>
  Effect.gen(function*() {
    const user = yield* CurrentUser
    const org = yield* CurrentOrg
    return <Shell {...props} account={{ name: user.name, email: user.email, org: org.name }} />
  })

/** The HTML document, header and page container (the sign-in page uses it without an account). */
export const Shell = (props: ShellProps) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.title}</title>
      <script dangerouslySetInnerHTML={{ __html: themeScript() }} />
      <link rel="stylesheet" href="/build/app.css" />
      {/* Islands first: <ds-island> must be defined before Datastar binds it (see islands/client.tsx). */}
      <script type="module" src="/build/islands.js"></script>
      <script type="module" src="/datastar.js"></script>
    </head>
    <body>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.bar)}>
          <a href="/" {...stylex.props(styles.brand)}>
            <Logo />
            effect-datastar
          </a>
          {props.account && (
            <nav aria-label="Main" {...stylex.props(styles.nav)}>
              {links.map(([href, label]) => (
                <a
                  key={href}
                  href={href}
                  aria-current={props.active === href ? "page" : undefined}
                  {...stylex.props(styles.link, props.active === href && styles.linkActive)}
                >
                  {label}
                </a>
              ))}
            </nav>
          )}
          <span {...stylex.props(styles.spacer)} />
          {props.account && (
            <div id="account" {...stylex.props(styles.account)}>
              <span {...stylex.props(styles.who)} title={props.account.email}>
                <span id="account-name" {...stylex.props(styles.name)}>{props.account.name}</span>
                <span id="account-org" {...stylex.props(styles.org)}>{props.account.org}</span>
              </span>
              <Button size="sm" icon="logout" {...ds.on("click", "@post('/logout')")}>Sign out</Button>
            </div>
          )}
          <Island.Mount island={Theme} props={{}} />
        </div>
      </header>
      <div {...stylex.props(styles.page)}>{props.children}</div>
    </body>
  </html>
)


const styles = stylex.create({
  header: {
    position: "sticky",
    top: 0,
    zIndex: 5,
    backgroundColor: color["--dw-surface"],
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color["--dw-border"]
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: space["--dw-space-6"],
    maxWidth: size["--dw-page-width"],
    height: size["--dw-header-height"],
    marginInline: "auto",
    paddingInline: space["--dw-space-4"]
  },
  brand: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["--dw-space-2"],
    color: color["--dw-text"],
    fontWeight: font["--dw-weight-semibold"],
    textDecoration: "none",
    letterSpacing: "-0.01em"
  },
  nav: { display: "flex", alignItems: "center", gap: space["--dw-space-1"] },
  link: {
    paddingBlock: "6px",
    paddingInline: "10px",
    borderRadius: radius["--dw-radius-md"],
    color: { default: color["--dw-text-muted"], ":hover": color["--dw-text"] },
    backgroundColor: { default: "transparent", ":hover": color["--dw-neutral-soft"] },
    fontSize: font["--dw-text-md"],
    fontWeight: font["--dw-weight-medium"],
    textDecoration: "none"
  },
  linkActive: { color: color["--dw-text"], backgroundColor: color["--dw-neutral-soft"] },
  spacer: { flexGrow: 1 },
  account: { display: "flex", alignItems: "center", gap: space["--dw-space-3"] },
  who: { display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: font["--dw-leading-tight"] },
  name: { fontSize: font["--dw-text-sm"], fontWeight: font["--dw-weight-medium"], color: color["--dw-text"] },
  org: { fontSize: font["--dw-text-xs"], color: color["--dw-text-muted"] },
  page: {
    maxWidth: size["--dw-page-width"],
    marginInline: "auto",
    paddingBlock: space["--dw-space-8"],
    paddingInline: space["--dw-space-4"]
  }
})
