---
name: nextjs
description: Next.js (App Router, v16) conventions and gotchas - server/client boundaries, async request APIs, Cache Components, route handlers, env vars. Use when working in a Next.js project.
---

# Next.js

Assume the App Router and Next.js 16. Docs change fast: check current Next.js docs (via a docs/library-lookup tool if available) before relying on memory for version-specific APIs.

## Structure and naming

- `app/` for routing/layouts/pages/route handlers; shared code in `lib/`, `components/`, `hooks/`, `contexts/`, `types/`, `public/`; optional `src/` to separate code from config.
- Colocate route-specific components/tests in the route folder, but keep nesting shallow. Shared components go in `components/`. Use route groups `(admin)` for URL-neutral grouping and `_private` folders to opt out of routing. Group large apps by feature.
- Names: folders `kebab-case`; component files and exports `PascalCase` matching the file name; hooks/utilities `camelCase`; providers `XyzProvider`; constants `UPPER_SNAKE_CASE`. Type props with interfaces. Tests colocated (`UserCard.test.tsx`).

## Server vs Client Components

- Server Components are the default; add `'use client'` only for interactivity, state, or browser APIs. Keep client bundles small by leaving most logic on the server.
- Do not use `next/dynamic` with `{ ssr: false }` in a Server Component: it is unsupported and fails the build. Move the client-only UI into a dedicated `'use client'` component (one component for a group such as navbar + profile menu) and import it directly.

## Next.js 16 gotchas

- Request-bound APIs are async: `await cookies()`, `headers()`, `draftMode()`, and treat `params` / `searchParams` as Promises.
- Reading request data makes the route dynamic. Do it deliberately and isolate dynamic parts behind `Suspense`.
- Caching: prefer Cache Components (`cacheComponents: true` + `use cache`, with `cacheTag` / `cacheLife`) over legacy patterns; avoid `unstable_cache` in new code. Use `revalidateTag(tag, 'max')` (stale-while-revalidate); the single-argument form is deprecated. Use `updateTag` in Server Actions when you need read-your-writes.
- `serverRuntimeConfig` / `publicRuntimeConfig` are removed; use env vars. `NEXT_PUBLIC_*` is inlined at build time, so changing it after build has no effect; for runtime reads in dynamic contexts call `connection()` first.
- Turbopack is the default dev bundler; configure it via top-level `turbopack` (`experimental.turbo` is removed). `typedRoutes` is stable (needs TypeScript).
- Run ESLint through the ESLint CLI with the official Next.js config; `next lint` is not the path in 16.

## Route Handlers

- Live in `app/api/**/route.ts`, export verb-named functions, use Web `Request`/`Response` (`NextRequest`/`NextResponse` when needed). Prefer them over Edge Functions unless you need ultra-low latency or geo-distribution.
- Validate all input (e.g. `zod`), return proper status codes, and authorize server-side (middleware or session checks) in Route Handlers and Server Actions. Never trust client input.
- Do not `fetch('/api/...')` your own Route Handlers from Server Components: extract the logic into `lib/` and call it directly, avoiding a needless server hop.

## Other

- Secrets in `.env.local`, never committed.
- Use the built-in Image and Font optimization; Suspense/loading states for async data.
- Do not add example/demo files (e.g. `ModalExample.tsx`) to the codebase unless asked for a live example, Storybook story, or documentation component.
- Component, testing, naming, and security conventions: read `references/CONVENTIONS.md` when creating components, writing tests, or naming files/assets.
