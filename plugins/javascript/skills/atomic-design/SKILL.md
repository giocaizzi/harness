---
name: atomic-design
description: "Use when extracting shared components or layouts, structuring a UI kit or component folders, deciding where a component goes, or adding lint rules for import boundaries (feature to feature, UI kit to features, layers, cycles). Atomic design."
---

# Atomic design

Atomic design is the vocabulary of the shared UI kit, not the layout of the whole app. Enforce direction mechanically; leave classification to review.

It fits a UI kit in React, Next.js, Vue, Svelte or React Native, and covers enforcing the component architecture with lint (import boundaries, layers, cycles, chokepoints).

## Structure

- **Atomic levels live in one kit** (`ui/` or `components/ui/`): atoms, molecules, organisms. Feature and business code goes in feature folders (`features/<name>/`), never in a level folder.
- **Templates and pages are the framework's.** Templates map to layouts (`layout.tsx`, Nuxt layouts), pages to routes. Keep both thin: compose, don't draw.
- **The kit holds no data.** Atoms, molecules and organisms take props. Fetching, stores, API clients, i18n and logging belong to features, routes or server components.
- **Build atoms on headless primitives** (Radix, React Aria, Ark UI, shadcn/ui copies) and design tokens. A primitive's parts (`Dialog.Root`, `Dialog.Trigger`) count as one atom.
- **Molecule or organism:** if it breaks down into bare elements, it is a molecule; if it breaks down into other components, it is an organism. Don't spend longer than that on the question; move it later if it was wrong.
- **Stories follow the levels** (`Atoms/Button`); stories may use fixed data, the kit may not.

## Enforce

Automate only rules that have one right answer:

- A level never imports a higher level; the kit never imports features, routes or the app.
- A feature never imports a sibling feature; share through the kit or a lower layer.
- No import cycles.
- Chokepoints: raw `fetch`, platform SDKs, icon packs and raw palette colours only inside their one wrapper.
- Production code never imports tests or stories.

Leave which level a component belongs to, naming and granularity to review.

How to set it up (tools, configs, existing violations, agent hooks): [references/enforcement.md](references/enforcement.md).
