export const Layout = (props: { readonly title: string; readonly active: string; readonly children: JSX.Element }) => (
  <>
    {"<!doctype html>"}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title safe>{props.title}</title>
        <link rel="stylesheet" href="/app.css" />
        <script type="module" src="/datastar.js"></script>
      </head>
      <body>
        <nav class="top">
          {[["/users", "Users"], ["/teams", "Teams"]].map(([href, label]) => (
            <a href={href} class={props.active === href ? "active" : undefined}>{label}</a>
          ))}
        </nav>
        {props.children}
      </body>
    </html>
  </>
)
