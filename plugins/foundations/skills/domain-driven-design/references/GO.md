# Go: layout and signatures

Read when scaffolding or restructuring a Go service on these rules. Consumer-declared interfaces and "accept interfaces, return structs" are the Go skill's baseline; this file only places them.

## Layout

```
acme/shop/
├── cmd/
│   └── shop/main.go          # composition root: the only place that builds adapters
└── internal/
    ├── orders/               # one bounded context
    │   ├── domain/           # Order, value objects, events; imports nothing from the project
    │   ├── app/              # handlers, and the ports they consume
    │   └── adapters/         # postgres/, smtp/, http/: implement the ports
    ├── billing/              # same shape
    └── platform/             # a library: config, logging, db pool. Not a Shared Kernel
```

`internal/` keeps contexts private to the module. A context talks to another through that context's `app` package or through events, never through its `domain` or `adapters`.

## Signatures

Port, declared in the package that consumes it (`app`), named for the need:

```go
type InvoiceSender interface {
	Send(ctx context.Context, inv billing.InvoiceID) error
}

type OrderRepository interface {
	Add(ctx context.Context, o *domain.Order) error
	Get(ctx context.Context, id domain.OrderID) (*domain.Order, error)
}

type UnitOfWork interface {
	Do(ctx context.Context, fn func(ctx context.Context, tx Tx) error) error
}
```

Handler: a struct with its ports as fields, built by a constructor that takes them:

```go
type PlaceOrder struct{ uow UnitOfWork }

func NewPlaceOrder(uow UnitOfWork) *PlaceOrder
func (h *PlaceOrder) Handle(ctx context.Context, cmd PlaceOrderCommand) (PlaceOrderResult, error)
```

Adapter, in `adapters/postgres`: a concrete struct returned by its constructor, never an interface; it satisfies the port implicitly, and a compile-time check pins it:

```go
var _ app.OrderRepository = (*OrderRepository)(nil)

func NewOrderRepository(db *sql.DB) *OrderRepository
```

Composition root, `cmd/shop/main.go`: `func run(ctx context.Context, cfg Config) error` builds the pool, the adapters and the handlers, passes them down, and starts the servers; `main` only calls `run` and exits on its error.

## Go-specific points

- The port goes in `app`, the adapter implements it from `adapters`, so `adapters` imports `app` and `domain`, never the reverse.
- Pass `context.Context` first; the unit of work owns the transaction, so handlers never see `*sql.Tx`.
- Domain errors are sentinel values or types the adapters and the API layer map with `errors.Is` and `errors.As`.
- Enforce the direction with depguard rules per layer (`architecture-fitness`).
