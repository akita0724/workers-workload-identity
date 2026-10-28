---
sidebar:
  label: Admin UI frontend
---

# Admin console frontend selection

**Status:** Implemented. The admin console in `apps/admin-ui` uses this selection. Separation between the Admin Worker and the issuer Worker remains mandatory.

## Decision

Use a **React and Vite single-page application** for the admin console, with **TanStack Router** for navigation and **TanStack Query** for API state and job progress. Components come from **Cloudflare Kumo**, styling from **Tailwind CSS v4**, English and Japanese text from **i18next** (`react-i18next`), and issuance charts from **ECharts**. No form library is used; server-side Zod validation remains authoritative. **Hono remains the Admin Worker JSON API and authentication middleware.** Full-screen SSR with Hono JSX is outside the selection.

## Comparison

| Option                                       | Fit                                                                                               | Cost here                                                                                                                                   | Decision                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Hono JSX SSR + limited JavaScript            | Light for a few forms and lists; one Worker for UI and API                                        | Grant-impact diffs, audit search, asynchronous rotation progress, and multi-step confirmation need custom browser state and synchronization | Alternative if the admin console stays small           |
| React SPA + TanStack Router/Query + Hono API | Fits stateful administration, lists, and job progress; makes the API trust boundary explicit      | Requires SPA build, client state, and cache removal when authentication expires                                                             | **Selected**                                           |
| TanStack Start                               | Adds SSR, server functions, and server routes to Router, with an official Workers deployment path | SSR and SEO bring little value to a private admin console and can create a second server boundary beside Hono                               | Reconsider if SSR or server functions become necessary |
| Astro shell + React SPA                      | Suits an admin UI embedded in an existing content site                                            | This stand-alone issuer has no site to integrate, so Astro adds little                                                                      | Not selected                                           |

TanStack Start is stable and has a Cloudflare Workers guide, so it is not rejected for compatibility. TanStack itself presents Router alone as an option when SSR is unnecessary. The initial release keeps Hono API as the sole server-side authentication and authorization boundary. See [TanStack Start](https://tanstack.com/start/latest/docs/framework/react/overview) and the [Cloudflare guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/).

## Selected structure

```text
apps/
  admin-worker/  Hono JSON API, passkey/Access adapters, RBAC, D1, Rotation Controller RPC
  admin-ui/      React + Vite, TanStack Router/Query, Kumo, Tailwind CSS, i18next, ECharts
packages/
  contracts/     Browser-safe Zod schemas and admin API contracts
  domain-*/      Business rules used by the Workers; never imported directly by the UI
```

- Serve UI and API from one Admin Worker origin, avoiding credentialed cross-origin requests. Use Workers Static Assets SPA fallback with explicit `assets.run_worker_first` and route ordering. Integration tests prove that API paths never return HTML and protected navigation passes through authentication middleware. See [Workers SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).
- Never embed secrets, operator information, or policy data in static JS/CSS. In passkey mode, the login shell and assets may be public, but protected data comes only from authenticated APIs. In Access mode, protect the entire admin path on the public host. The API authenticates and authorizes every request in both modes.
- TanStack Query is a display cache, not an authorization source. Invalidate affected queries after client disablement or key-state mutation. Clear every admin cache on logout, operator disablement, authentication-mode changes, and 401/403. Before high-impact writes, load the current server version and diff.
- Router loaders and search params manage URL and search state. A client-side route guard improves presentation but never replaces API authorization.
- The API remains authoritative for pagination, search, and permission-filtered columns in caller, audience, and audit lists; do not send every row to the browser.
- Put only browser-safe request/response schemas in `contracts`. Browser-side Zod helps with input, but the Admin Worker validates independently. Never import a secret or internal DB row into the UI bundle.

## Acceptance criteria

1. Passkey registration/authentication and Access JWT verification work across SPA navigation, reloads, API fetches, and static assets.
2. An unauthenticated user may receive a passkey shell but cannot obtain caller, key, or audit data through the API, initial HTML, or built assets. Access mode also blocks alternate URLs.
3. Query invalidation after admin mutations, cross-tab operator disablement, cache clearing on logout, and job-progress reconnection work.
4. Navigation and fetches to `/api/*` bypass the SPA fallback and return JSON or the correct authentication error. Reloading a UI deep link returns the correct shell.
