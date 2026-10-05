# @gate-forge/pack-react-router

Reads React Router JSX `<Route>` trees and `createBrowserRouter` / `useRoutes` route objects, resolves relative children, and emits plane-qualified `ui.page` resources with path parameters and source locations. Redirect-only and catch-all routes are excluded; unreadable paths become `PAGE_ROUTE_UNRESOLVED` entries.

Configure `pages.router: react-router` and owner-declared `pages.audiences` in `.gateforge.yml`. Frameworks without React Router can use `pages.router: manual` and `.gateforge/pages.yml`:

```yaml
pages:
  - path: /orders/:id
    audience: tenant
    source: src/routes.tsx:12
```

The manual inventory requires an absolute route path, audience name, and repo-relative `file:line` source. Each plane-resolved page creates `page:loads` and `page:data-ok` obligations; both remain missing until a page proof channel is available.
