export const Layout = (props: { readonly title: string; readonly children: JSX.Element }) => (
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
      <body>{props.children}</body>
    </html>
  </>
)
