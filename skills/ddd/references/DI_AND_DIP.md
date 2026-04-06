# Dependency Inversion Principle (DIP) & Dependency Injection (DI)

Detailed reference for DIP and DI concepts as they apply to DDD + Hexagonal Architecture.

## DIP vs DI — Two Distinct Concepts

| | Dependency Inversion Principle (DIP) | Dependency Injection (DI) |
|---|---|---|
| **What** | Architectural *principle* about dependency **direction** and **ownership** | Implementation *technique* for **providing** dependencies from outside |
| **Source** | Robert C. Martin, "The Dependency Inversion Principle" (1996); "Clean Architecture" (2017) | Martin Fowler, "Inversion of Control Containers and the Dependency Injection pattern" (2004) |
| **Core idea** | High-level modules own the abstraction; low-level modules implement it | A separate assembler provides dependencies — objects don't create their own |
| **Python mechanism** | `typing.Protocol` defined in domain, implemented in infrastructure | Constructor `__init__`, FastAPI `Depends()`, `functools.partial` |
| **Scope** | Module/package boundaries (architectural) | Object wiring (implementation) |
| **Independent?** | DIP without DI: use factory methods with correct abstraction ownership | DI without DIP: inject concrete classes (no abstraction) |

## Dependency Inversion Principle — Deep Dive

### Original Definition (Robert C. Martin, 1996)

**Part A:** *"High-level modules should not depend on low-level modules. Both should depend on abstractions."*

**Part B:** *"Abstractions should not depend on details. Details should depend on abstractions."*

### How DIP Enables Hexagonal Architecture

Traditional layered architecture (without DIP):
```
Domain → Infrastructure  (domain imports concrete DB classes)
```

With DIP applied:
```
Domain defines Protocol ← Infrastructure implements Protocol
```

The dependency arrow is **inverted**: infrastructure depends on domain, not the reverse. This is the mechanism behind Clean Architecture's **Dependency Rule** (source code dependencies point inward only).

### The Ownership Rule

DIP is NOT just "code to an interface." The critical insight is **who owns the abstraction**:

- If the database library ships `DatabaseInterface` and your domain codes to it → you are coding to an interface but domain STILL depends on the database package.
- If your domain defines `OrderRepository` Protocol in its own package → infrastructure depends on domain. True inversion.

The abstraction must live in the high-level module's package, defined in terms the domain cares about.

### DIP in Python

```python
# domain/repositories/order.py — HIGH-LEVEL MODULE OWNS THE ABSTRACTION
from typing import Protocol

class OrderRepository(Protocol):
    def add(self, order: Order) -> None: ...
    def get(self, order_id: OrderId) -> Order: ...
    def remove(self, order_id: OrderId) -> None: ...

# infrastructure/persistence/repositories/order.py — LOW-LEVEL IMPLEMENTS IT
class SqlAlchemyOrderRepository:  # satisfies Protocol structurally
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    def add(self, order: Order) -> None: ...
    def get(self, order_id: OrderId) -> Order: ...
    def remove(self, order_id: OrderId) -> None: ...
```

Domain has zero imports from infrastructure. Infrastructure imports domain types (`Order`, `OrderId`).

### When to Apply DIP

Apply at **architectural boundaries** (between layers, modules, deployment units). Do NOT apply to every class-to-class relationship within a single module — that is over-engineering.

### Common Misconceptions

1. **DIP = DI** → No. DIP is about direction, DI is about delivery.
2. **DIP = coding to interfaces** → Necessary but insufficient. Ownership matters.
3. **DIP = runtime indirection** → DIP is about source-code dependencies, not runtime flow.
4. **DIP means abstract classes everywhere** → Only at layer boundaries.

## Dependency Injection — Deep Dive

### Types of DI

| Type | How | When to Use |
|------|-----|-------------|
| **Constructor injection** | Via `__init__` parameters | Default for all services, handlers, repositories |
| **Parameter injection** | Per-call arguments (FastAPI `Depends()`) | Request-scoped dependencies in API layer |
| **Property/setter injection** | Via attribute assignment | Truly optional dependencies only (avoid) |
| **Closures/partials** | `functools.partial` wrapping handlers | Message bus patterns (Cosmic Python) |

Constructor injection is preferred: it makes dependencies explicit, enables immutability, and guarantees valid objects at construction time.

### Composition Root (Mark Seemann)

*"A (preferably) unique location in an application where modules are composed together."*

Rules:
- Lives as close as possible to the application entry point
- Only applications have Composition Roots — libraries must not
- A DI Container should only be referenced from the Composition Root
- All other modules use constructor injection; they never compose themselves

In DDD + FastAPI: `api/dependencies/` is the Composition Root. It imports from infrastructure and returns types annotated as abstractions.

### Pure DI vs DI Containers

**Pure DI** (manual wiring): Write the wiring code yourself. No magic, fully debuggable. Recommended by Cosmic Python. Best for small-to-medium DDD projects.

**DI Containers** (dependency-injector, dishka): Automate resolution of dependency graphs. Justify when the dependency graph is complex, multiple entry points exist (HTTP + CLI + workers), or lifecycle management is needed.

| Library | Approach | Notes |
|---------|----------|-------|
| **Pure DI** | No library | Cosmic Python approach. Most explicit. |
| **FastAPI Depends** | Framework-native | Request-scoped only. Not a full container. |
| **dishka** | Modern container | Async-native, explicit scopes, FastAPI integration. Growing adoption. |
| **dependency-injector** | Established container | Mature, declarative providers. Can feel heavy. |

Recommendation: Start with pure DI + FastAPI Depends. Add dishka only if manual wiring becomes unmanageable.

### DI Anti-Patterns

| Anti-Pattern | Description | Why It's Bad |
|---|---|---|
| **Control Freak** | `self._repo = PostgresRepo()` — class creates own dependencies | No substitution possible, violates IoC |
| **Service Locator** | `ServiceLocator.get(OrderRepository)` — global registry | Hides dependencies, runtime-only failures |
| **Bastard Injection** | `def __init__(self, repo=None): self._repo = repo or PostgresRepo()` | Hides coupling, creates false optionality |
| **Ambient Context** | `TimeProvider.now()` — static global accessor | Hidden dependency, global mutable state |

### DI and Testing

DI enables testability by allowing substitution at the Composition Root. Test doubles:
- **Fakes** (preferred): Simplified working implementations (`InMemoryOrderRepository`)
- **Stubs**: Return canned responses
- **Mocks**: Verify interactions (use sparingly)

FastAPI overrides: `app.dependency_overrides[get_uow] = lambda: FakeUnitOfWork()`
Cosmic Python bootstrap: `bus = bootstrap(uow=FakeUnitOfWork())`

## The Full Dependency Flow (DDD + FastAPI)

```
api/routes/orders.py                  → calls handler, receives deps via Depends()
    │ Depends(get_uow)
    ▼
api/dependencies/uow.py              → COMPOSITION ROOT (imports concrete, returns abstract)
    │ instantiates
    ▼
infrastructure/persistence/uow.py    → SqlAlchemyUnitOfWork (concrete)
    │ implements
    ▼
application/uow.py                   → AbstractUnitOfWork (Protocol)
    │ UoW creates repos
    ▼
infrastructure/persistence/repos/    → SqlAlchemyOrderRepository (concrete)
    │ implements
    ▼
domain/repositories/order.py         → OrderRepository (Protocol)
```

**Import direction** (strictly enforced):
```
domain/           → imports NOTHING from the project
application/      → imports from domain/ only
infrastructure/   → imports from domain/ and application/
api/routes/       → imports from application/ and api/schemas/
api/dependencies/ → imports from application/ AND infrastructure/ (composition root exception)
```

## Sources

- Martin, R.C. — "The Dependency Inversion Principle" (C++ Report, 1996)
- Martin, R.C. — *Clean Architecture* (2017)
- Fowler, M. — "Inversion of Control Containers and the Dependency Injection pattern" (2004)
- Seemann, M. — *Dependency Injection: Principles, Practices, and Patterns* (2019)
- Seemann, M. — "Composition Root" (blog.ploeh.dk, 2011)
- Seemann, M. — "Pure DI" (blog.ploeh.dk, 2014)
- Percival, H. & Gregory, B. — *Architecture Patterns with Python* (Cosmic Python)
- Cockburn, A. — "Hexagonal Architecture" (2005)
- Bailey, D. — "DI is NOT DIP" (lostechies.com, 2011)
