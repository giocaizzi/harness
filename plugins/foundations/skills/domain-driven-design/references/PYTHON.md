# Python: port and unit-of-work signatures

Read when writing a port, an adapter or a unit of work in Python. The folder tree, the import direction, DIP versus DI and the composition root with FastAPI are in the `python-development` skill's `references/HEXAGONAL.md`.

## Port and adapter

A port is a `Protocol` declared by its consumer; the adapter inherits it explicitly so the type checker catches drift. No `I` prefix, no `Abstract` name.

```python
class OrderRepository(Protocol):
    def add(self, order: Order) -> None: ...
    def get(self, order_id: OrderId) -> Order: ...


class SqlAlchemyOrderRepository(OrderRepository):
    def __init__(self, session: Session) -> None: ...
```

A repository returns domain objects, never ORM rows; `Order.create(...)` builds a new aggregate and `Order.reconstitute(...)` rebuilds a stored one.

## Unit of work

A context manager that owns the transaction and exposes the repositories; leaving the block without `commit()` rolls back.

```python
class UnitOfWork(Protocol):
    orders: OrderRepository

    def __enter__(self) -> Self: ...
    def __exit__(self, *exc_info: object) -> None: ...
    def commit(self) -> None: ...
    def collect_events(self) -> Iterator[Event]: ...
```

An async service uses `__aenter__` and `__aexit__` with awaited `commit`.

## Handler

```python
class PlaceOrderHandler:
    def __init__(self, uow: UnitOfWork) -> None: ...
    def handle(self, command: PlaceOrderCommand) -> PlaceOrderResult: ...
```
