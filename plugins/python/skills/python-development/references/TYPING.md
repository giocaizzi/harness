# Typing

Snippets passed ruff with [ruff.toml](./ruff.toml) and pyrefly's strict preset on CPython 3.14.10 (docstrings trimmed here).

## What each version adds

Use a feature natively when `requires-python` allows it; otherwise import it from `typing_extensions` unconditionally (it re-exports the stdlib object when there is one). No `if sys.version_info` import blocks: Google 3.19.13 discourages conditional imports.

| Version | Typing and syntax that change how code is written |
|---|---|
| 3.12 | `class C[T]`, `def f[T]`, `type Alias = ...` (PEP 695); `@override` (PEP 698) |
| 3.13 | `TypeIs` (PEP 742), `@warnings.deprecated` (PEP 702), `ReadOnly` TypedDict items (PEP 705), type parameter defaults (PEP 696) |
| 3.14 (floor) | Lazy annotations and `annotationlib` (PEP 649/749), t-strings and `string.templatelib` (PEP 750), `except A, B:` without parentheses (PEP 758) |
| 3.15 | `lazy import` (PEP 810), closed TypedDicts and `extra_items` (PEP 728), `TypeForm` (PEP 747), `frozendict` (PEP 814), `sentinel` (PEP 661) |

## Generics, aliases and their names

```python
from collections.abc import Callable, Sequence
import functools
import itertools

type _Pair[T] = tuple[T, T]  # module-local alias: _Private, CapWords
type JsonValue = (
    str | int | float | bool | list[JsonValue] | dict[str, JsonValue] | None
)


def neighbours[T](items: Sequence[T]) -> list[_Pair[T]]:
    return list(itertools.pairwise(items))


def largest[AddableT: (int, str)](items: Sequence[AddableT]) -> AddableT:
    return max(items)  # constrained: a descriptive name (Google 3.19.10)


def retry[**P, R](times: int) -> Callable[[Callable[P, R]], Callable[P, R]]:
    def decorate(func: Callable[P, R]) -> Callable[P, R]:
        @functools.wraps(func)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            for _ in range(times - 1):
                try:
                    return func(*args, **kwargs)
                except OSError:
                    continue
            return func(*args, **kwargs)

        return wrapper

    return decorate
```

No `TypeVar`, `ParamSpec`, `Generic[T]` or `TypeAlias` in new code (ruff's UP040, UP046 and UP047 rewrite them). A recursive alias refers to itself unquoted. A decorator's docstring says it is a decorator (Google 2.17).

## Wide in, narrow out

| Parameter takes | Instead of | When the function only |
|---|---|---|
| `Iterable[T]` | `list[T]` | Loops once |
| `Sequence[T]` | `list[T]` | Indexes or loops more than once |
| `Mapping[K, V]` | `dict[K, V]` | Reads keys |
| `AbstractSet[T]` (`collections.abc.Set`) | `set[T]` | Tests membership |

Return the concrete type you built (`list[str]`, `dict[str, int]`). Abstract types come from `collections.abc`, never `typing`.

## Protocol or ABC

A seam exists for a second implementation or a test fake (SKILL.md, Design). When it does:

| `Protocol` | `ABC` |
|---|---|
| Implementations need not know the interface (a fake, a third-party class) | Implementations share code through the base class |
| Declared in the consumer's module | Declared beside the implementations it serves |
| `@runtime_checkable` only when code really branches on it (`isinstance` checks only method presence) | `@abstractmethod` on every hook a subclass must fill |

## Overloads

When the return type follows an argument's value:

```python
from typing import Literal, overload


@overload
def fetch(url: str, *, raw: Literal[True]) -> bytes: ...
@overload
def fetch(url: str, *, raw: Literal[False] = ...) -> str: ...
def fetch(url: str, *, raw: bool = False) -> bytes | str:
    body = url.encode()
    return body if raw else body.decode()
```

Two functions (`fetch_text`, `fetch_bytes`) are often clearer than the overload; prefer them for new APIs.

## Narrowing

`TypeIs[T]` narrows both branches. `TypeGuard[T]` narrows only the true one; use it only when `T` is not a subtype of the input type, which `TypeIs` cannot express. `isinstance`, `match` and `is None` narrow on their own: write a guard function only to reuse a check.

## TypedDict

For a payload you pass through rather than model:

```python
from typing_extensions import TypedDict  # typing on 3.15+


class Event(TypedDict, closed=True):  # no keys beyond these
    kind: str
    id: int
```

`NotRequired[...]` for optional keys, `ReadOnly[...]` for keys the consumer must not write. Data the code owns is a dataclass instead.

## Constants and enums

`MAX_RETRIES: Final = 3` at module level (Google 2.5 constant naming). A closed set of string values is a `StrEnum`; `Literal["read", "write"]` only for a parameter of one function.

## Annotations at runtime

Since 3.14, annotations are evaluated when read, not when the `def` runs. Tools that read them (Pydantic, dataclasses, cattrs) resolve names in the module's globals, so a type they need is imported for real, not under `TYPE_CHECKING`. To read annotations yourself, use `annotationlib.get_annotations(obj, format=annotationlib.Format.FORWARDREF)`, which returns `ForwardRef` for names it cannot resolve instead of raising.
