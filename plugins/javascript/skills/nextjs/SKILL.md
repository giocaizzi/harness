---
name: nextjs
description: "Next.js 16 App Router rules and gotchas: server and client components, async params and cookies, Cache Components, route handlers, env vars. Use in any project whose package.json depends on next or that has an app/ directory with layout.tsx, before adding or changing a page or dynamic route, an API endpoint or form handler (app/api/**/route.ts), a Server Action or caching, or fixing a build error, even when the user does not say Next.js. Load it alongside javascript-typescript and react, not instead of them."
---

# Next.js

Assume the App Router and Next.js 16. The APIs move fast: check the current Next.js docs (a docs or library-lookup tool if available) before relying on memory for anything version-specific.

## Structure and naming

- `app/` holds routing only: layouts, pages, route handlers. Shared code goes in `lib/`, `components/`, `hooks/`, `contexts/`, `types/`; static files in `public/`.
- Colocate route-specific components and tests in the route folder, with shallow nesting. Route groups `(admin)` group without changing the URL; `_private` folders opt out of routing.
- Folders `kebab-case`; component files and their default export `PascalCase`, matching; hooks and utilities `camelCase`; providers `XyzProvider`; constants `UPPER_SNAKE_CASE`; static assets `snake_case` or `kebab-case`. Related components share an `index.ts` barrel. Props typed with an interface. Tests beside the file (`UserCard.test.tsx`).
- No example or demo files (`ModalExample.tsx`) unless asked for a live example, story or docs component.

## Server and client

- Server Components by default; `'use client'` only for interactivity, state or browser APIs, on the smallest component that needs it.
- Route handlers live in `app/api/**/route.ts`, export verb-named functions and use Web `Request`/`Response`. Validate every input (for example with `zod`), return the right status, and authorize on the server in every route handler and Server Action.
- Secrets in `.env.local`, never committed. HTTPS in production, with secure HTTP headers.
- Tests with Jest, React Testing Library or Playwright, covering all critical logic.

## Gotchas

- Request APIs are async: `await cookies()`, `await headers()`, `await draftMode()`, and `params` / `searchParams` are Promises. Reading any of them makes the route dynamic; isolate that part behind `Suspense`.
- `next/dynamic` with `{ ssr: false }` fails the build inside a Server Component. Move the client-only UI into its own `'use client'` component and import it directly.
- A Server Component never `fetch`es its own route handler (`fetch('/api/...')`): call the logic in `lib/` directly.
- Caching: Cache Components (`cacheComponents: true`, `'use cache'`, `cacheTag`, `cacheLife`), not `unstable_cache`. `revalidateTag(tag, 'max')`; the one-argument form is deprecated. `updateTag` in a Server Action for read-your-writes.
- `NEXT_PUBLIC_*` is inlined at build time; changing it later has no effect. For a runtime read in a dynamic context, call `connection()` first. `serverRuntimeConfig` / `publicRuntimeConfig` are gone.
- Turbopack is the default; configure it under top-level `turbopack` (`experimental.turbo` is removed). `typedRoutes` is stable.
- `next lint` is gone in 16: run the ESLint CLI with the official Next.js config.
