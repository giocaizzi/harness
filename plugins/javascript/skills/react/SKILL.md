---
name: react
description: "React 19+ rules: components, state, effects, data fetching, forms, Tailwind v4, testing, Storybook. Use whenever you write, change, debug or review a React component or hook (.tsx or .jsx), such as adding UI behaviour, fixing an effect that loops or refetches, or handling loading and error states."
---

# React

Target React 19+ with function components, hooks and TypeScript.

## Components and state

- Organize by feature. Extract reusable stateful logic into custom hooks; separate presentational components from the ones that fetch or hold state, so the UI stays reusable.
- Atomic design for the UI kit and its lint rules: the `atomic-design` skill.
- Type props with an interface; reuse React's types (`React.ComponentProps<'button'>`) and a union for variants.
- State ladder: `useState` locally, `useReducer` for complex transitions, context for tree-wide sharing, Redux Toolkit or Zustand only when an app truly needs it. Server state goes in React Query or SWR, not hand-rolled effects.
- No effect when derivation or an event handler does the job. An effect that stays has a complete dependency array and a cleanup.
- Memoize (`useMemo`, `useCallback`, `React.memo`) only where profiling shows a need.

## Data, errors, forms

- Every request handles loading, error and success, and cancels or ignores stale responses.
- Error Boundaries with a fallback UI around each independently failing area.
- React Hook Form for validated forms; every input labelled.

## Styling, testing, docs

- Tailwind v4, configured in CSS: tokens in `globals.css` under `@theme` and custom utilities under `@utility`. There is no `tailwind.config.js` unless the project already has one.
- React Testing Library + Jest: test what the user sees and does, including keyboard use; mock the network, not components.
- Storybook: `*.stories.tsx` beside the component, using `@storybook/react`.
- React Router for client-side routing in apps without a framework.

## Gotchas

- An object, array or function literal in a dependency array is new on every render, so the effect runs every render: an effect that sets state from a fetch then refetches forever. Move the value inside the effect, depend on its primitive fields, or memoize it.
- `StrictMode` mounts, unmounts and remounts every component in development, so effects run twice. A missing cleanup shows up there first; don't remove `StrictMode` to hide it.
- React 19 passes `ref` as a normal prop to function components: no `forwardRef` in new code. `<Context value={...}>` replaces `<Context.Provider>`.
- With the React Compiler enabled, don't add `useMemo`/`useCallback` by hand; it memoizes for you.
- Never render user HTML through `dangerouslySetInnerHTML` without sanitizing it (DOMPurify), and keep tokens out of `localStorage`.
