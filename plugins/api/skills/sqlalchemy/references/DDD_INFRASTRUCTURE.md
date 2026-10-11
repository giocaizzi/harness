# DDD Infrastructure Patterns

Read when SQLAlchemy backs a DDD/hexagonal project. ORM models stay separate from domain entities; the repository returns domain objects.

```python
class OrderMapper:
    @staticmethod
    def to_domain(model: OrderModel) -> Order:
        return Order.reconstitute(id=OrderId(model.id), status=OrderStatus(model.status))

    @staticmethod
    def to_persistence(entity: Order) -> OrderModel:
        return OrderModel(id=entity.id.value, status=entity.status.value)

class SqlAlchemyOrderRepository:  # implements the domain Protocol
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, order_id: OrderId) -> Order:
        model = (await self._session.execute(
            select(OrderModel).where(OrderModel.id == order_id.value)
        )).scalar_one_or_none()
        if not model:
            raise OrderNotFound(order_id)
        return OrderMapper.to_domain(model)

    async def add(self, order: Order) -> None:
        self._session.add(OrderMapper.to_persistence(order))

class SqlAlchemyUnitOfWork:
    def __init__(self, session_factory: async_sessionmaker) -> None:
        self._session_factory = session_factory

    async def __aenter__(self):
        self._session = self._session_factory()
        self.orders = SqlAlchemyOrderRepository(self._session)
        return self

    async def __aexit__(self, exc_type, *args):
        if exc_type:
            await self._session.rollback()
        await self._session.close()

    async def commit(self):
        await self._session.commit()
```
