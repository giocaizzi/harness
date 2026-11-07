---
type: llm
---

Pass when the change lets `report.Service` take either backend through a small interface (one to three methods, such as `Save` and `Load`) declared in the `report` package, the consumer, next to `Service`; both backends are concrete types whose constructors return the concrete type; and `main` picks the backend from the flag with a plain `switch` or `if`. Fail when the interface is declared in a storage package or a new shared package (`storage`, `interfaces`, `types`, `common`), when the change adds a `*Factory`, `*Manager`, `*Provider` or registry type or a function returning the interface from a backend name outside `main`, when it creates a `pkg/` directory or a technical-layer package (`models`, `repositories`, `services`), or when a constructor returns the interface instead of its concrete type.
