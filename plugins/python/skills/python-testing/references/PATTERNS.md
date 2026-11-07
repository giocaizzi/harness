# Test patterns

Every test below passed `make check` (ruff with every rule, pyrefly strict, pytest in parallel and random order) on CPython 3.14.10 with pytest 9.2, pytest-asyncio 1.4, pytest-xdist 3.8, pytest-randomly 5.0, pytest-timeout 2.4, pytest-cov 7.1, hypothesis 6.170 and syrupy 6.1. They test the `notify` package in python-development's `references/PATTERNS.md`. License headers are cut.

## Config

```toml
[dependency-groups]
dev = [
    "hypothesis>=6.170",
    "pytest>=9.2",
    "pytest-asyncio>=1.4",
    "pytest-cov>=7.1",
    "pytest-randomly>=5.0",
    "pytest-timeout>=2.4",
    "pytest-xdist>=3.8",
    "syrupy>=6.1",
]

[tool.pytest]
minversion = "9.0"
strict = true
testpaths = ["tests"]
addopts = [
    "-ra", "--import-mode=importlib", "-n", "auto", "-m", "not integration",
]
markers = ["integration: needs the network or a real service"]
timeout = "300"
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"

[tool.coverage.run]
source = ["notify"]
branch = true

[tool.coverage.report]
show_missing = true
skip_covered = true
```

```makefile
test: ## Run the tests in parallel, with coverage
	uv run pytest --cov --cov-report=term-missing:skip-covered

test-integration: ## Run the tests that need the network or real services
	uv run pytest -m integration
```

A `-m` on the command line replaces the one in `addopts`. `--import-mode=importlib` lets `tests/` hold same-named modules in different directories without `__init__.py` files.

## Parametrize and property-based tests

```python
import contextlib

from hypothesis import example
from hypothesis import given
from hypothesis import strategies as st
import pytest

from notify import intervals

_INTERVALS = st.builds(
    intervals.Interval,
    count=st.integers(min_value=1, max_value=10_000),
    unit=st.sampled_from("smh"),
)


@pytest.mark.parametrize(
    ("text", "seconds"),
    [
        pytest.param("5m", 300, id="minutes"),
        pytest.param(" 2h ", 7200, id="surrounding-space"),
        pytest.param("1s", 1, id="one-second"),
    ],
)
def test_parse_seconds(text: str, seconds: int) -> None:
    assert intervals.Interval.parse(text).seconds == seconds


@pytest.mark.parametrize("text", ["", "0m", "5", "m", "5d", "-5m", "5 m"])
def test_parse_rejects(text: str) -> None:
    with pytest.raises(ValueError, match="Not an interval"):
        intervals.Interval.parse(text)


@given(_INTERVALS)
def test_str_round_trips(interval: intervals.Interval) -> None:
    assert intervals.Interval.parse(str(interval)) == interval


@given(st.text())
@example("05m")  # regression: leading zero was accepted
def test_parse_accepts_or_raises_value_error(text: str) -> None:
    with contextlib.suppress(ValueError):
        intervals.Interval.parse(text)
```

The hand-picked cases pin the documented behaviour; the two properties cover the input space. The last test fails on any exception other than `ValueError`, which is the parser's contract.

## A fake and an injected clock

```python
import dataclasses
import datetime as dt

from notify import alerts

_START = dt.datetime(2026, 1, 1, 9, 0, tzinfo=dt.UTC)
_QUIET = dt.timedelta(minutes=10)


@dataclasses.dataclass
class FakeSender:
    sent: list[str] = dataclasses.field(default_factory=list)

    async def send(self, text: str) -> None:
        self.sent.append(text)


@dataclasses.dataclass
class FakeClock:
    now: dt.datetime = _START

    def __call__(self) -> dt.datetime:
        return self.now

    def advance(self, delta: dt.timedelta) -> None:
        self.now += delta


def _alerter() -> tuple[alerts.Alerter, FakeSender, FakeClock]:
    sender, clock = FakeSender(), FakeClock()
    return alerts.Alerter(sender, quiet=_QUIET, now=clock), sender, clock


async def test_alert_drops_repeat_inside_quiet_period() -> None:
    alerter, sender, clock = _alerter()

    await alerter.alert("disk", "disk full")
    clock.advance(_QUIET - dt.timedelta(seconds=1))
    sent_again = await alerter.alert("disk", "disk full")

    assert not sent_again
    assert sender.sent == ["disk full"]


async def test_alert_resends_after_quiet_period() -> None:
    alerter, sender, clock = _alerter()

    await alerter.alert("disk", "disk full")
    clock.advance(_QUIET)
    await alerter.alert("disk", "disk still full")

    assert sender.sent == ["disk full", "disk still full"]
```

`_alerter()` is a factory, not a fixture: each test sees what it gets. The fakes satisfy `alerts.Sender` structurally; pyrefly checks that without the fake importing the protocol. Ten minutes pass in zero real time.

## An HTTP client against an in-process transport

```python
import json

import httpx
import pytest

from notify import errors
from notify import slack

_WEBHOOK = "https://hooks.example.com/T1"


async def test_send_posts_text_as_json() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handle)
    ) as client:
        await slack.SlackSender(client, _WEBHOOK).send("disk full")

    assert [(r.method, str(r.url)) for r in seen] == [("POST", _WEBHOOK)]
    assert json.loads(seen[0].content) == {"text": "disk full"}


async def test_send_wraps_http_errors() -> None:
    transport = httpx.MockTransport(lambda _: httpx.Response(500))
    async with httpx.AsyncClient(transport=transport) as client:
        sender = slack.SlackSender(client, _WEBHOOK)
        with pytest.raises(errors.DeliveryError, match="slack"):
            await sender.send("disk full")
```

The real `httpx` client runs, request building and status handling included; only the network is replaced. No `mock.patch("notify.slack.httpx")`.

## Snapshot

`report.render` formats alert counts as a text table, busiest first.

```python
from syrupy.assertion import SnapshotAssertion

from notify import report


def test_render_orders_busiest_first(snapshot: SnapshotAssertion) -> None:
    assert report.render({"disk": 3, "cpu": 7, "api": 3}) == snapshot
```

The first `pytest --snapshot-update` writes `tests/__snapshots__/test_report.ambr`; commit it, and read its diff whenever it changes. A snapshot with a timestamp or random id in it fails every run: scrub them in the code under test's output first, or use syrupy's `exclude`/`matcher` options.
