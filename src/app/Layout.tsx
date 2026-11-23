import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import * as Island from "../islands/Island.tsx"
import { Theme } from "../islands/islands.tsx"
import { Logo } from "../ui/icons.tsx"
import { themeScript } from "../ui/theme/themes.ts"
import { color, font, radius, size, space } from "../ui/theme/tokens.stylex.ts"

const links = [["/users", "Users"], ["/teams", "Teams"]] as const

export const Layout = (props: { readonly title: string; readonly active: string; readonly children: ReactNode }) => (
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
          <span {...stylex.props(styles.spacer)} />
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
  page: {
    maxWidth: size["--dw-page-width"],
    marginInline: "auto",
    paddingBlock: space["--dw-space-8"],
    paddingInline: space["--dw-space-4"]
  }
})
