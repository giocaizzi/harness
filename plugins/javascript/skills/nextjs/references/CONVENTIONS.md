# Next.js Conventions (detail)

## Components

- Create a component when:
  - A UI pattern is reused more than once.
  - A section of a page is complex or self-contained.
  - It improves readability or testability.
- Single-export files: default export the component.
- Multiple related components: use an `index.ts` barrel file.
- Match the component name to the file name.

## Naming and layout

- Static assets: `snake_case` or `kebab-case` (e.g., `logo_dark.svg`).
- `styles/` holds global and modular stylesheets.

## Testing

- Use Jest, React Testing Library, or Playwright.
- Write tests for all critical logic and components.
- Co-locate tests with components (e.g., `UserCard.test.tsx`).

## Security and documentation

- Use HTTPS in production and set secure HTTP headers.
- Document public APIs and components; use JSDoc for complex functions and types.
