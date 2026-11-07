# Review-only Google rules

ruff (with [ruff.toml](./ruff.toml)) and mypy check everything else; these Google rules have no checker, so a reviewer looks for them. The Imports and Design rules in SKILL.md are review-only too. Section numbers are the [guide's](https://google.github.io/styleguide/pyguide.html).

| Look for | Google |
|---|---|
| A class or function imported from a non-typing module (`from shop.orders import Order`) | 2.2.4 |
| A comprehension with two `for` clauses, or a `for` and two `if`s: write the loop | 2.7.4 |
| A conditional expression whose three parts do not each fit on a line | 2.11.4 |
| A nested function that closes over nothing but `self`: make it a `_private` module function | 2.6.4 |
| `@staticmethod` (ruff's no-self-use catches only methods that ignore `self`); `@classmethod` other than a named constructor | 2.17.4 |
| A `@property` that only reads or writes an attribute; a property a subclass would override | 2.13.4, 3.15 |
| `x = x or default` and `if x:` where `None` and a falsy value differ: `if x is None` | 2.14.4 |
| A default evaluated at import: `b=_FLAG.value` (ruff catches calls, not attribute reads) | 2.12.4 |
| Metaclasses, `__getattr__` tricks, import hooks, `__del__`, bytecode access | 2.19.4 |
| Threads sharing data without `queue.Queue` or a lock | 2.18 |
| A string built with `+` from more than two parts, or `+=` in a loop | 3.10 |
| A docstring whose summary is not one line ending in `.`, `?` or `!`; a mix of "Fetches" and "Fetch" in one file; a property documented as "Returns the path." instead of "The path." | 3.8.1, 3.8.3 |
| A `Raises:` entry for a misuse error (`ValueError` on a bad argument) | 2.4.4 |
| A single-letter name outside counters, `e`, `f` and scoped type parameters; a name that carries its type (`id_to_name_dict`) | 3.16.1 |
| `TODO(username)`: the parentheses hold an issue link | 3.12 |
| A function past about 40 lines that splits cleanly | 3.18 |
| An error or log message that guesses the cause, or whose interpolated value is not delimited (`{path!r}`, `{p=}`) | 3.10.2 |
