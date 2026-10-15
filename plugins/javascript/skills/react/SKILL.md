---
name: react
description: React 19+ conventions - component design, state, effects, data fetching, styling (Tailwind v4), testing, Storybook. Use when writing or reviewing React code.
---

# React

Target React 19+ with function components and hooks, TypeScript, per https://react.dev.

## Architecture and components

- Organize by feature/domain. Prefer composition over inheritance; extract reusable stateful logic into custom hooks.
- Keep components small, single-purpose, testable. Separate presentational from container components so UI stays reusable.
- Atomic design for the UI kit and its lint rules: the `atomic-design` skill. Design tokens centralized in the Tailwind config.
- Type props with interfaces; use React's built-in types (`React.ComponentProps`, etc.) and union types for variants.

## State, effects, performance

- State ladder: `useState` locally, `useReducer` for complex transitions, context for tree-wide sharing, Redux Toolkit or Zustand only when an app truly needs it. Server state goes in React Query or SWR, not hand-rolled effects.
- Effects: correct dependency arrays and cleanup (otherwise loops and leaks). Do not reach for effects when derivation or event handlers suffice.
- Memoization (`useMemo`, `useCallback`, `React.memo`) only where profiling shows a need; code-split routes with `React.lazy` + `Suspense`; virtualize large lists.

## Data, errors, forms

- Handle loading, error and success states, request cancellation/races, and offline/network failures. Optimistic updates where UX benefits.
- Error Boundaries with fallback UI; surface meaningful messages to users.
- Controlled inputs; React Hook Form (or Formik) for validation; labelled, ARIA-correct forms.

## Styling

- Tailwind v4 with config in `globals.css` via `@theme` / `@utility`; mobile-first responsive; consistent spacing/type/color scale.

## Security and accessibility

- Sanitize and escape user-provided content (XSS); keep sensitive data out of `localStorage`/`sessionStorage`; enforce auth server-side; use CSP headers.
- Semantic HTML first, ARIA when needed, keyboard operability, alt text, contrast. Verify with screen readers/tools.

## Testing and docs

- React Testing Library + Jest; test behavior, not implementation; mock external APIs; cover keyboard/a11y.
- Storybook: `*.stories.tsx` beside components, using `@storybook/react`.
- JSDoc for complex components and custom hooks; ESLint + Prettier.

## Routing

- React Router for client-side apps: nested routes, route protection, lazy-loaded route chunks.

## References

- Implementation process, common patterns, build tooling, and extra form/routing/security notes: read `references/PATTERNS_AND_PROCESS.md` when planning a feature or choosing a pattern.
