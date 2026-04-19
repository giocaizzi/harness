---
name: python-testing
description: python testing best practices and conventions. Use this skill whenever you are testing Python code. You must follow these guidelines always.
metadata:
  version: "1.0"
---

# Python Testing

- **Test behaviour not implementation details.**
- **Test edge cases and failure modes.**
- TDD: write tests before implementation -> For bugs, reproduce first with failing test then fix
- `pytest` for testing; co-locate tests in `tests/`
- Use `pytest-asyncio` for async tests
- Use fixtures for setup/teardown
- Re-utilize test utilities/helpers, avoid duplication
- Use markers for categorization (e.g., `@pytest.mark.integration`)

## Best Practices 

### Kill fixture sprawl aggressively : Fixtures must be local first, then promoted.

- Fixtures must be local first, then promoted.
- No fixture may depend on more than 2 other fixtures.
- Fixtures returning complex graphs are banned.

```python
user = make_user()
order = make_order(user)
payment = make_payment(order)
```

### Prefer factories over fixtures

```python 
@pytest.fixture
def user_factory():
    def factory(**kwargs):
        return User(...)
    return factory
```

### Make test data boring and deterministic

- Hardcode values unless randomness is the thing being tested.
- Use semantic defaults:

```python
DEFAULT_EMAIL = "user@example.com"
```

