# Hexagonal layout and wiring in Python

Read when scaffolding or auditing a Python service built on the `domain-driven-design` skill's layers (foundations plugin): where the folders go and how the dependencies are wired. The design rules (aggregates, ports, events, context maps) are that skill's; this file adds only Python's tree and DI.

## Tree

One package per bounded context under `src/<project>/`, layers inside it, features inside each layer (a module per feature, a folder once it outgrows one). No `models/`, `services/` or `utils/` folders and no folder per pattern (`aggregates/`, `value_objects/`, `specifications/`): `orders.py` holds the aggregate, its value objects and its events together.

```
src/shop/
├── __init__.py            # docstring only
├── errors.py              # class Error(Exception): the package base
├── shared/                # a library: base types, config, logging. Not a Shared Kernel
├── billing/               # a bounded context, same shape as orders/
└── orders/
    ├── domain/            # no I/O, no framework
    │   ├── orders.py      # Order aggregate, its value objects, its events
    │   ├── pricing.py     # a domain service, only if logic spans aggregates
    │   └── ports.py       # driven ports the domain itself needs (rare)
    ├── application/       # use cases; imports domain only
    │   ├── placing.py     # command, result and handler of one use case
    │   ├── listing.py     # query and handler over a read model
    │   ├── ports.py       # repositories, UnitOfWork, EmailSender, publishers
    │   └── reacting.py    # event handlers (idempotent)
    ├── adapters/          # all I/O; implements the ports
    │   ├── sqlalchemy/    # orm.py (tables), repositories.py, unit_of_work.py, outbox.py
    │   ├── smtp.py        # SmtpEmailSender
    │   └── broker.py      # integration-event publisher
    └── api/               # driving adapter: routes.py, schemas.py, dependencies.py
```

Import direction, enforced by the `architecture-fitness` skill's import-linter contracts:

```
domain       -> nothing from the project (shared base types aside)
application  -> domain
adapters     -> domain, application
api          -> application; and adapters, in dependencies.py only
```

Per the house import rule, modules are imported, not members: `from shop.orders.domain import orders`, then `orders.Order`. Two layers each have an `orders` module, so alias on collision (`from shop.orders.adapters.sqlalchemy import repositories`). Errors inherit the package `errors.Error`; a layer's own base (`DomainError`) is a subclass of it.

## Ports

Declare a port in the consuming layer, as a `Protocol` named for the business need, only once there is a second implementation or a test needs the seam ("abstract late"). The adapter inherits it explicitly so the checker catches drift; the fake does too. No `Abstract*`, `Base*` or `I` prefix; name adapters for the technology (`SqlAlchemyOrderRepository`, `InMemoryOrderRepository`).

## DIP and DI are two things

- **DIP** is about ownership and direction: the abstraction lives with the consumer, in domain terms, so adapters import the domain and never the reverse. A `Protocol` shipped by the database library does not invert anything. Apply it at layer boundaries, never between two classes in one module.
- **DI** is delivery: an object receives its collaborators instead of building them. Either can exist without the other.

Constructor injection is the default for handlers, repositories and adapters. Parameter injection is for request-scoped values in the API layer (`Depends`). Setter injection and `functools.partial` over handlers only where a message bus wants a plain callable.

## Composition root

The only code that imports concrete adapters: `main()` or the app factory (`create_app()`), plus `api/dependencies.py` for request-scoped wiring. Libraries have none. Pure DI (hand-written wiring) first; add a container (dishka, dependency-injector) only with several entry points (HTTP, CLI, workers) or lifecycle scopes that hand-wiring cannot express.

```python
# api/dependencies.py: imports concrete, returns abstract
def get_unit_of_work(
    session_factory: Annotated[async_sessionmaker, Depends(get_session_factory)],
) -> ports.UnitOfWork:
    return unit_of_work.SqlAlchemyUnitOfWork(session_factory)

UnitOfWorkDep = Annotated[ports.UnitOfWork, Depends(get_unit_of_work)]
```

Tests swap the root, not the code: `app.dependency_overrides[get_unit_of_work] = FakeUnitOfWork`, or build the handler with fakes directly. Fakes (`InMemoryOrderRepository`) over mocks.

## DI anti-patterns

| Name | Looks like | Fix |
|---|---|---|
| Control Freak | `self._repo = PostgresRepo()` in the class | take it in `__init__` |
| Service Locator | `Registry.get(OrderRepository)` | explicit parameters |
| Bastard Injection | `repo or PostgresRepo()` default | required parameter, no default |
| Ambient Context | `TimeProvider.now()` static accessor | inject a clock |

## Sources

Martin, "The Dependency Inversion Principle" (1996) and *Clean Architecture*; Fowler, "Inversion of Control Containers and the Dependency Injection pattern" (2004); Seemann, *Dependency Injection: Principles, Practices, and Patterns* and "Composition Root" (blog.ploeh.dk); Percival and Gregory, *Architecture Patterns with Python*.
