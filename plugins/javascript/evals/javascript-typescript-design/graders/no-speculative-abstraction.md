---
type: llm
---

Pass when the change adds PayPal with at most one new interface (for example `PaymentProvider`) that both Stripe and PayPal satisfy, picks the provider for an order with a plain construct (a `Map` or object keyed by currency, a `switch`, or a constructor parameter wired in `main.ts`), uses named exports only (no `export default`), and adds no `as` cast, `!` non-null assertion or `any` to parse the PayPal response (it narrows the unknown JSON or parses it with a schema). Fail when it adds an abstract base class, a class or function named like `*Factory`, `*Manager`, `*Helper` or `Abstract*`, a registry or DI container, a default export, or a cast to read the response.
