# `foundations` plugin

Language-neutral design and practice: domain-driven design, system design, architecture fitness tests, API design and design patterns, with Go and Python signatures where a language matters.

## Skills

| Skill | Description |
|---|---|
| `domain-driven-design` | Domain-driven design with ports and adapters: bounded contexts, aggregates, repositories, events, the composition root. |
| `system-design` | System design decisions: NFRs as numbers, consistency, messaging and the outbox, failure modes, live-data migrations, ADRs; design and infra review rubrics. |
| `architecture-fitness` | Architecture enforced by failing checks: dependency-direction tests, adapter conformance suites, lint ratchets. |
| `api-design` | HTTP API contracts: errors, versioning, pagination, idempotency keys, OpenAPI drift and breaking-change checks. |
| `design-patterns` | When to abstract and which pattern fits, with named anti-patterns. |

## Agents

| Agent | Description |
|---|---|
| `api-reviewer` | API security review (vulnerabilities, RBAC leaks, compliance) that maintains tests, adds x-failing regression tests to prove vulnerabilities, and posts a verdict with severities. Never edits production code. |

## Install

```bash
# Claude Code / Copilot CLI / Codex (codex plugin add)
/plugin install foundations@giocaizzi-harness
```

Every harness (Codex, opencode and pi included), updates and local development: [docs/install.md](../../docs/install.md).
