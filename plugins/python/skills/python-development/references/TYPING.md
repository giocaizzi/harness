# Typing Reference

Deep-dive on Python typing for 3.12+ codebases.

## Modern Syntax (3.12+)

### Generics

```python
# ✅ New syntax (3.12+)
class Stack[T]:
    def __init__(self) -> None:
        self._items: list[T] = []

    def push(self, item: T) -> None:
        self._items.append(item)

    def pop(self) -> T:
        return self._items.pop()

def first[T](items: Sequence[T]) -> T:
    return items[0]

# ❌ Legacy (never use on 3.12+)
from typing import TypeVar, Generic
T = TypeVar("T")
class Stack(Generic[T]): ...
```

### Type Aliases

```python
# ✅ New keyword (3.12+)
type Vector = list[float]
type Result[T] = T | Error
type JSON = str | int | float | bool | None | list["JSON"] | dict[str, "JSON"]

# ❌ Legacy
from typing import TypeAlias
Vector: TypeAlias = list[float]
```

### Union Syntax

```python
# ✅ Always (3.10+ / 3.12 is our floor)
def process(value: int | str | None) -> str: ...

# ❌ Never
from typing import Union, Optional
def process(value: Optional[Union[int, str]]) -> str: ...
```

## Wide vs. Narrow Types

Use the **widest** type for parameters that the implementation actually supports.
Use the **narrowest** type for return values.

```python
from collections.abc import Sequence, Mapping, Iterable

# ✅ Wide input, narrow output
def summarize(items: Iterable[str]) -> list[str]:
    return [item.strip() for item in items]

def lookup(config: Mapping[str, int], key: str) -> int:
    return config[key]

# ❌ Unnecessarily narrow input
def summarize(items: list[str]) -> list[str]: ...
```

### Common type width ladder (narrow → wide)

| Narrow | Wide | Use when |
|--------|------|----------|
| `list[T]` | `Sequence[T]` | Read-only ordered access |
| `list[T]` | `Iterable[T]` | Single-pass iteration |
| `dict[K, V]` | `Mapping[K, V]` | Read-only key lookup |
| `set[T]` | `AbstractSet[T]` | Read-only membership |
| `str` | `str \| bytes` | Accept both text forms |

Import abstract types from `collections.abc`, not from `typing`.

## Protocols (Structural Typing)

Use `Protocol` when you need duck typing with static checking. Prefer over ABC
when callers shouldn't need to inherit from your type.

```python
from typing import Protocol, runtime_checkable

class Readable(Protocol):
    def read(self, n: int = -1) -> bytes: ...

class Closeable(Protocol):
    def close(self) -> None: ...

class ReadableCloseable(Readable, Closeable, Protocol): ...

# Can also be runtime-checkable (use sparingly — performance cost)
@runtime_checkable
class Sized(Protocol):
    def __len__(self) -> int: ...
```

### When to use Protocol vs ABC

| Use `Protocol` when | Use `ABC` when |
|---|---|
| Consumers shouldn't know about your type | You own the hierarchy |
| Duck typing / structural compatibility | Need shared implementation |
| Third-party types must satisfy interface | Enforcement via `isinstance` required |

## Overloads

Use `@overload` when the return type depends on argument types or values:

```python
from typing import overload, Literal

@overload
def fetch(url: str, *, raw: Literal[True]) -> bytes: ...
@overload
def fetch(url: str, *, raw: Literal[False] = ...) -> str: ...
def fetch(url: str, *, raw: bool = False) -> bytes | str:
    response = _get(url)
    return response if raw else response.decode()
```

## TypeIs vs TypeGuard (3.13+)

`TypeIs` narrows in both branches; `TypeGuard` only narrows in the `True` branch.
Prefer `TypeIs` unless you need asymmetric narrowing.

```python
from typing import TypeIs

def is_str_list(val: list[object]) -> TypeIs[list[str]]:
    return all(isinstance(x, str) for x in val)

items: list[object] = ["a", "b"]
if is_str_list(items):
    # items is list[str] here
    print(items[0].upper())
```

On 3.12 use `from typing_extensions import TypeIs`.

## Keyword-Only and Positional-Only Parameters

```python
# Keyword-only (after *)
def connect(host: str, port: int, *, timeout: float = 30.0, ssl: bool = True) -> None: ...

# Positional-only (before /)
def pow(base: float, exp: float, /) -> float: ...

# Combined
def create(name: str, /, *, force: bool = False) -> None: ...
```

## Decorators

```python
from collections.abc import Callable
from typing import ParamSpec, TypeVar
from functools import wraps

P = ParamSpec("P")
R = TypeVar("R")

def retry(times: int) -> Callable[[Callable[P, R]], Callable[P, R]]:
    def decorator(func: Callable[P, R]) -> Callable[P, R]:
        @wraps(func)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            for attempt in range(times):
                try:
                    return func(*args, **kwargs)
                except Exception:
                    if attempt == times - 1:
                        raise
            raise RuntimeError("unreachable")
        return wrapper
    return decorator
```

## Final, Literal, and Constants

```python
from typing import Final, Literal

# Constants
MAX_RETRIES: Final = 3
API_VERSION: Final[str] = "v2"

# Literal types for constrained values
def set_mode(mode: Literal["read", "write", "append"]) -> None: ...

# Enum alternative for string literals
from enum import StrEnum
class Mode(StrEnum):
    READ = "read"
    WRITE = "write"
    APPEND = "append"
```

## Forward References

| Python version | Solution |
|---|---|
| 3.12–3.13 | `from __future__ import annotations` at module top |
| 3.14+ | Native deferred evaluation (PEP 649) — no action needed |

On 3.12–3.13 you can also quote the reference: `def f() -> "MyClass": ...`

## TypedDict

```python
from typing import TypedDict, Required, NotRequired

# 3.12+
class UserCreate(TypedDict):
    name: str
    email: str
    age: NotRequired[int]

# 3.13+ ReadOnly fields
from typing import ReadOnly

class Config(TypedDict):
    host: ReadOnly[str]
    port: ReadOnly[int]
    debug: bool  # mutable
```

## typing_extensions Bridge

For features above your minimum Python version, import from `typing_extensions`:

```python
import sys
if sys.version_info >= (3, 13):
    from typing import TypeIs
else:
    from typing_extensions import TypeIs
```

Or simply always use `typing_extensions` — it re-exports the stdlib version when available.
