# Conformance suites for ports

A port (an interface the domain owns) gets one suite that states its contract. Every implementation runs it: the in-memory fake the unit tests use, and each real adapter. A fake that passes the suite is a fake you can trust; a second adapter is correct when it passes the same suite.

- The suite lives with the port, not with an adapter. An adapter's test file only supplies a factory.
- Cover the contract's edges: not found, duplicates, ordering, concurrent writes, partial failure.
- The real adapter runs behind a marker or build tag (`integration`) against a container; the fake runs in every `make test`.

## Python

```python
# tests/ports/order_repository_contract.py
from collections.abc import Callable

import pytest

from acme.domain.orders import Order, OrderRepository


class OrderRepositoryContract:
    """Subclass and set `make_repo`. No `Test` prefix, so pytest does not collect it alone."""

    make_repo: Callable[[], OrderRepository]

    @pytest.fixture
    def repo(self) -> OrderRepository:
        return type(self).make_repo()

    def test_get_missing_returns_none(self, repo: OrderRepository) -> None:
        assert repo.get("nope") is None

    def test_saved_order_is_returned(self, repo: OrderRepository) -> None:
        repo.save(Order(id="o1"))
        assert repo.get("o1") == Order(id="o1")


# tests/test_fake_repo.py
class TestFake(OrderRepositoryContract):
    make_repo = staticmethod(FakeOrderRepository)


# tests/integration/test_pg_repo.py
@pytest.mark.integration
class TestPostgres(OrderRepositoryContract):
    make_repo = staticmethod(lambda: PostgresOrderRepository(dsn=container_dsn()))
```

## Go

```go
// internal/orders/ordertest/contract.go
package ordertest

import (
	"errors"
	"testing"

	"acme/app/internal/orders"
)

// RunRepository runs the repository contract on a new repository per subtest.
func RunRepository(t *testing.T, newRepo func(t *testing.T) orders.Repository) {
	t.Helper()
	t.Run("get missing returns ErrNotFound", func(t *testing.T) {
		repo := newRepo(t)
		if _, err := repo.Get(t.Context(), "nope"); !errors.Is(err, orders.ErrNotFound) {
			t.Errorf("Get(nope) error = %v, want ErrNotFound", err)
		}
	})
}

// internal/orders/fake_test.go
func TestFakeRepository(t *testing.T) {
	ordertest.RunRepository(t, func(*testing.T) orders.Repository { return orders.NewFake() })
}

// internal/db/repository_integration_test.go  (//go:build integration)
func TestPostgresRepository(t *testing.T) {
	ordertest.RunRepository(t, newPostgresRepo) // starts a container, stops it with t.Cleanup
}
```

## TypeScript

Same shape: export `runRepositoryContract(name, makeRepo)` from the port's folder, registering the `describe` and `it` blocks, and call it once per implementation; skip the real one unless an integration flag is set.
