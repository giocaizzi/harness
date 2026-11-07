# DDD Project Structure Reference

Annotated folder structure for a Python DDD project with Hexagonal Architecture and a Shared Core.

```
project_root/
│
├─ shared/
│  │  # SHARED CORE: Cross-cutting infrastructure and truly generic abstractions.
│  │  # NOT a DDD Shared Kernel (that is a context mapping relationship).
│  │  # RULE: Only stable abstractions with identical semantics across ALL contexts.
│  │  # WHEN IN DOUBT: Duplicate in the context instead of sharing.
│  │
│  ├─ api/
│  │  # Cross-cutting API concerns used by all contexts.
│  │  # PUT HERE: Common error handlers, middleware, auth, shared response types.
│  │  # AVOID: Context-specific request/response schemas (those belong in context api/).
│  │
│  ├─ domain/
│  │  │  # Shared domain abstractions — base types and generic value objects.
│  │  │
│  │  ├─ value_objects/
│  │  │  # Generic value objects shared across ALL contexts.
│  │  │  # PUT HERE: Money, Email, PhoneNumber, Timestamp, Address.
│  │  │  # RULE: Only objects with identical semantics everywhere.
│  │  │  # AVOID: Context-specific value objects (OrderStatus, ShippingMethod).
│  │  │
│  │  ├─ events.py
│  │  │  # DomainEvent base class/protocol.
│  │  │  # PUT HERE: Base event interface, event metadata fields.
│  │  │
│  │  └─ errors/
│  │     # Base domain error classes.
│  │     # PUT HERE: DomainError base, common error types.
│  │
│  └─ infrastructure/
│     │  # Cross-cutting technical implementations.
│     │  # RULE: Only truly shared concerns serving multiple contexts.
│     │
│     ├─ config/
│     │  # Application configuration and settings.
│     │  # PUT HERE: Environment variables, feature flags, secrets management.
│     │
│     ├─ persistence/
│     │  # Shared database utilities.
│     │  # PUT HERE: DB connection pools, base repository helpers, session factories.
│     │  # AVOID: Context-specific repository implementations or ORM models.
│     │
│     ├─ logging/
│     │  # Structured logging infrastructure.
│     │  # PUT HERE: Logger configuration, formatters, log context propagation.
│     │
│     ├─ telemetry/
│     │  # Observability infrastructure.
│     │  # PUT HERE: Tracing, metrics, distributed context propagation.
│     │
│     ├─ event_bus/
│     │  # In-process event publishing.
│     │  # PUT HERE: EventBus implementation, subscriber registry.
│     │  # PURPOSE: Domain event dispatch to application event handlers.
│     │
│     └─ adapters/
│        # Shared adapter implementations.
│        # PUT HERE: Storage adapters, common integrations used by 2+ contexts.
│        # RULE: Only adapters used by multiple contexts.
│
├─ contexts/
│  │  # BOUNDED CONTEXTS: Each context is a self-contained module.
│  │  # RULE: One folder per bounded context.
│  │  # COMMUNICATION: Via defined integration patterns (see Context Mapping).
│  │  # PRINCIPLE: High cohesion within, loose coupling between.
│  │
│  └─ {context_name}/
│     │
│     ├─ api/
│     │  │  # DRIVING ADAPTER LAYER: HTTP endpoints, serialization, dependency injection.
│     │  │  # RESPONSIBILITY: Translate HTTP <-> application layer (primary adapter).
│     │  │  # RULE: No business logic, only routing and input validation.
│     │  │
│     │  ├─ routes/
│     │  │  # HTTP endpoints organized by resource or use case.
│     │  │  # PATTERN: Receive request -> validate -> dispatch command/query -> return response.
│     │  │  # AVOID: Business logic, direct DB access, domain knowledge.
│     │  │
│     │  ├─ dependencies/
│     │  │  # COMPOSITION ROOT: The only place that knows about concrete implementations.
│     │  │  # PUT HERE: Factory functions for UoW, repositories, ports, handlers.
│     │  │  # PURPOSE: Wire concrete implementations (infrastructure) to abstract interfaces
│     │  │  #          (domain/application Protocols). Return abstract types.
│     │  │  # DIP: This is the only folder outside infrastructure allowed to import from it.
│     │  │  # DI: Uses constructor injection or FastAPI Depends() for parameter injection.
│     │  │
│     │  ├─ schemas/
│     │  │  # Pydantic models for HTTP serialization/deserialization.
│     │  │  # PUT HERE: Request/response DTOs, validation rules.
│     │  │  # RULE: NOT domain models, only transport format.
│     │  │  # NAMING: *Request, *Response.
│     │  │
│     │  └─ middleware/
│     │     # Cross-cutting HTTP concerns.
│     │     # PUT HERE: Error translation (application errors -> HTTP status codes),
│     │     #           request logging, CORS.
│     │     # AVOID: Business logic, direct DB access.
│     │
│     ├─ domain/
│     │  │  # THE HEXAGON CORE: Pure business logic.
│     │  │  # RULE: NO I/O, no frameworks, no infrastructure dependencies.
│     │  │  # TESTABLE: With minimal test doubles (no I/O mocks needed).
│     │  │  # GOAL: Expresses ubiquitous language.
│     │  │
│     │  ├─ aggregates/
│     │  │  │  # Aggregate roots: transactional consistency boundaries.
│     │  │  │  # STRUCTURE: One folder per aggregate, co-locate entities and events.
│     │  │  │  # DESIGN RULES (Vernon):
│     │  │  │  #   1. Model true invariants in consistency boundaries
│     │  │  │  #   2. Design small aggregates
│     │  │  │  #   3. Reference other aggregates by identity only
│     │  │  │  #   4. Use eventual consistency outside the boundary
│     │  │  │
│     │  │  └─ {aggregate_name}/
│     │  │     │
│     │  │     ├─ {aggregate_root}.py
│     │  │     │  # The aggregate root entity.
│     │  │     │  # CONTAINS: Private __init__, factory classmethods (create, reconstitute),
│     │  │     │  #           invariant enforcement, event raising, entity coordination.
│     │  │     │  # PATTERN: Methods are domain verbs (place_order, cancel, ship).
│     │  │     │  # EVENTS: Collect via _domain_events: list[DomainEvent], expose pull_domain_events().
│     │  │     │
│     │  │     ├─ {entity}.py
│     │  │     │  # Child entities within the aggregate (have identity, not aggregate roots).
│     │  │     │  # RULE: Never accessed directly by repositories, always through root.
│     │  │     │
│     │  │     └─ events.py
│     │  │        # Domain events for this aggregate.
│     │  │        # NAMING: Past-tense (OrderPlaced, OrderCancelled, PaymentReceived).
│     │  │        # STRUCTURE: Immutable data classes with timestamp, aggregate_id, event data.
│     │  │
│     │  ├─ value_objects/
│     │  │  # Context-specific immutable value objects.
│     │  │  # PUT HERE: OrderStatus, ShippingMethod, Quantity, DateRange.
│     │  │  # RULE: Immutable, validated on creation, __eq__/__hash__ by all attributes.
│     │  │  # NOTE: Generic value objects (Money, Email) live in shared/domain/value_objects/.
│     │  │
│     │  ├─ specifications/
│     │  │  # Reusable business rule objects (Specification pattern).
│     │  │  # PATTERN: is_satisfied_by(candidate) -> bool.
│     │  │  # COMPOSITION: Support and/or/not operations.
│     │  │  # EXAMPLES: CustomerIsPremium, OrderCanBeShipped, ProductIsInStock.
│     │  │  # USE AS DOMAIN GUARDS: Composable invariant checks.
│     │  │
│     │  ├─ services/
│     │  │  # Domain services: operations spanning multiple aggregates.
│     │  │  # CHARACTERISTICS: Stateless, pure, no side effects, ubiquitous language.
│     │  │  # WHEN: Rarely! Most logic belongs in aggregates.
│     │  │  # EXAMPLE: PricingService (uses Product + Customer + Promotions).
│     │  │  # AVOID: CRUD operations, orchestration (those are application concerns).
│     │  │
│     │  ├─ repositories/
│     │  │  # Repository protocols (driven port interfaces for persistence).
│     │  │  # PATTERN: add(aggregate), get(id), find_by_*(), remove(id).
│     │  │  # RULE: One repository per aggregate root. Collection-like semantics.
│     │  │  # NOTE: These are DRIVEN PORTS — infrastructure implements them.
│     │  │
│     │  ├─ ports/
│     │  │  # Domain-level driven port interfaces (rare).
│     │  │  # PUT HERE: Only when domain logic itself needs external data.
│     │  │  # MOST PORTS belong in application/ports/ instead.
│     │  │
│     │  └─ errors/
│     │     # Domain-specific exceptions for business rule violations.
│     │     # EXAMPLES: InsufficientInventory, InvalidOrderState, AccountLocked.
│     │     # RULE: Never reference infrastructure (no DB errors, no HTTP codes).
│     │     # INHERIT: From shared DomainError base class.
│     │
│     ├─ application/
│     │  │  # USE CASE ORCHESTRATION: The handler IS the use case.
│     │  │  # RESPONSIBILITY: Transaction boundaries, workflow coordination.
│     │  │  # RULE: Thin layer — delegates all business logic to domain.
│     │  │  # FLOW: Open UoW -> load aggregates -> call domain -> collect events -> commit -> publish.
│     │  │
│     │  ├─ commands/
│     │  │  # Command definitions + handlers.
│     │  │  # COMMANDS: Immutable data classes representing intent to modify state.
│     │  │  #   Naming: {Action}{Entity}Command (CreateShopCommand).
│     │  │  # HANDLERS: One handler per command. Receives command, orchestrates domain.
│     │  │  #   Pattern: handle(command) -> Result.
│     │  │  # AVOID: Business rules in handlers (delegate to domain).
│     │  │
│     │  ├─ queries/
│     │  │  # Query definitions + handlers.
│     │  │  # QUERIES: Immutable data classes for read-only requests.
│     │  │  #   Naming: Get{Entity}Query, List{Entities}Query.
│     │  │  # HANDLERS: Read from read models/projections, return DTOs.
│     │  │  # RULE: No side effects, no business logic.
│     │  │
│     │  ├─ events/
│     │  │  # Domain event handlers: react to domain events with side effects.
│     │  │  # PUT HERE: Send email on OrderPlaced, update analytics, notify.
│     │  │  # RULE: Must be idempotent (events may be delivered more than once).
│     │  │  # PATTERN: handle(event) -> trigger ports (can fail independently).
│     │  │
│     │  ├─ ports/
│     │  │  # Application-level driven port interfaces (hexagonal).
│     │  │  # PUT HERE: EmailSender, PaymentGateway, EventPublisher.
│     │  │  # RULE: Domain/application defines interface, infrastructure implements.
│     │  │  # NAMING: Python Protocol, no I prefix. (EmailSender, not IEmailSender).
│     │  │
│     │  ├─ policies/
│     │  │  # Cross-cutting application concerns.
│     │  │  # PUT HERE: Authorization, rate limiting, idempotency, retry policies.
│     │  │  # EXAMPLES: RBACPolicy, IdempotencyPolicy, RateLimitPolicy.
│     │  │  # NOTE: Domain authorization rules belong in domain (specifications/guards).
│     │  │
│     │  ├─ uow.py
│     │  │  # Unit of Work interface.
│     │  │  # DEFINES: Transaction boundary, repository access, event collection.
│     │  │  # PATTERN: Context manager (__enter__/__exit__), commit(), rollback().
│     │  │
│     │  └─ errors/
│     │     # Application-level errors.
│     │     # PUT HERE: Orchestration failures, wrapped domain/infra errors.
│     │     # EXAMPLES: UseCaseExecutionFailed, ResourceNotFound.
│     │
│     └─ infrastructure/
│        │  # DRIVEN ADAPTER LAYER: I/O, persistence, external systems.
│        │  # RULE: Implements interfaces defined in domain/application.
│        │  # CHARACTERISTIC: Replaceable, framework-specific, has side effects.
│        │
│        ├─ persistence/
│        │  │
│        │  ├─ repositories/
│        │  │  # Concrete repository implementations (driven adapters).
│        │  │  # IMPLEMENTS: Domain repository protocols.
│        │  │  # RESPONSIBILITY: Load/save aggregates, maintain boundaries.
│        │  │  # NAMING: PostgresOrderRepository, InMemoryOrderRepository.
│        │  │  # AVOID: Business logic. Return domain models, not ORM models.
│        │  │
│        │  ├─ models/
│        │  │  # ORM models (SQLAlchemy, etc.).
│        │  │  # PUT HERE: Database schema definitions, table mappings.
│        │  │  # RULE: Separate from domain models. Use mappers to convert.
│        │  │
│        │  ├─ mappers/
│        │  │  # Bidirectional mapping: Domain <-> ORM.
│        │  │  # PATTERN: to_domain(orm_model), to_persistence(domain_model).
│        │  │  # RULE: One mapper per aggregate.
│        │  │
│        │  ├─ read_models/
│        │  │  # CQRS read-side implementations.
│        │  │  # PUT HERE: Optimized query implementations, denormalized views, projections.
│        │  │  # PURPOSE: Serve application/queries/ handlers with purpose-built DTOs.
│        │  │  # RULE: NOT domain models. Optimized for read performance.
│        │  │
│        │  ├─ uow.py
│        │  │  # Concrete Unit of Work implementation.
│        │  │  # IMPLEMENTS: application/uow.py interface.
│        │  │  # CONTAINS: DB session lifecycle, transaction control, event collection.
│        │  │
│        │  ├─ outbox/
│        │  │  # Transactional outbox for reliable event publishing.
│        │  │  # PUT HERE: Outbox table, event storage, polling relay.
│        │  │  # PURPOSE: Atomically save aggregate + events in same transaction.
│        │  │  # COMPONENTS: store.py (save), processor.py (poll + publish).
│        │  │
│        │  └─ errors/
│        │     # Persistence-specific errors.
│        │     # PUT HERE: DBConnectionError, UniqueViolation, DeadlockDetected.
│        │
│        ├─ adapters/
│        │  │  # External system adapters (implement application ports).
│        │  │
│        │  └─ {adapter_category}/
│        │     # Group by external system type.
│        │     # EXAMPLES: email/, payment/, notifications/, storage/.
│        │     # NAMING: SmtpEmailSender, SendGridEmailSender, StripePaymentGateway.
│        │     # IMPLEMENTS: Corresponding application/ports/ interface.
│        │
│        ├─ messaging/
│        │  # Cross-context integration events.
│        │  # PUT HERE: Message bus client, publisher, subscribers, retry, DLQ.
│        │  # PROTOCOLS: RabbitMQ, Kafka, Redis Streams, AWS SQS.
│        │  # PURPOSE: Publish integration events to other bounded contexts.
│        │
│        ├─ workers/
│        │  # Background workers and async processors.
│        │  # PUT HERE: Outbox consumers, scheduled jobs, retry handlers.
│        │  # EXAMPLES: Celery tasks, cron jobs, message queue consumers.
│        │
│        └─ config/
│           # Context-specific configuration overrides.
│           # PUT HERE: Context-level settings, feature flags.
│           # NOTE: Shared config lives in shared/infrastructure/config/.
```
