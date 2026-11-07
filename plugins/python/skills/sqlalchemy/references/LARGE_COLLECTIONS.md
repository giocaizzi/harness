# Large Collections

## WriteOnlyMapped (replaces DynamicMapped)

For relationships with thousands+ of items. Never loads the full collection into memory.

```python
from sqlalchemy.orm import WriteOnlyMapped

class User(Base):
    __tablename__ = "users"

    id: Mapped[intpk]
    # Large collection — never fully loaded
    audit_logs: WriteOnlyMapped[list["AuditLog"]] = relationship()

# Add items
user.audit_logs.add_all([AuditLog(action="login"), AuditLog(action="view")])

# Query items (returns a select() you can filter/paginate)
stmt = user.audit_logs.select().where(AuditLog.action == "login").limit(10)
logs = session.execute(stmt).scalars().all()

# Bulk operations
user.audit_logs.insert().values([{"action": "bulk1"}, {"action": "bulk2"}])
user.audit_logs.delete().where(AuditLog.created_at < cutoff)
```

## AssociationProxy

Access association table attributes directly:

```python
from sqlalchemy.ext.associationproxy import AssociationProxy, association_proxy

class User(Base):
    __tablename__ = "users"

    id: Mapped[intpk]
    user_tags: Mapped[list["UserTag"]] = relationship()

    # Access tag names directly: user.tag_names → ["admin", "active"]
    tag_names: AssociationProxy[list[str]] = association_proxy("user_tags", "tag_name")
```

## type_annotation_map

Customize default SQL types for Python types globally on the Base:

```python
from sqlalchemy import BIGINT, Text
from decimal import Decimal

class Base(DeclarativeBase):
    type_annotation_map = {
        int: BIGINT,          # all Mapped[int] → BIGINT
        str: Text,            # all Mapped[str] → TEXT
        Decimal: Numeric(10, 2),
    }
```

Override per-column with `mapped_column(type_=...)` when needed.
