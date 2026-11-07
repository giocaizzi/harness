# Patterns

Every module below is part of one small package (`notify`) that passed `ruff check` with [ruff.toml](./ruff.toml), `pyrefly check` with the strict preset and its tests on CPython 3.14.10. The license header is cut from each listing; real files start with it.

## Program skeleton

`main` parses arguments, reads the environment, builds every dependency and hands them down. Nothing below `main` reads `os.environ`, creates a client or configures logging.

```python
"""Command line: sends one alert to Slack."""

import argparse
import asyncio
from collections.abc import Sequence
import datetime as dt
import logging
import os
import sys

import httpx

from notify import alerts
from notify import errors
from notify import slack

_LOGGER = logging.getLogger(__name__)


async def _run(args: argparse.Namespace, webhook_url: str) -> int:
    async with httpx.AsyncClient(timeout=10.0) as client:
        alerter = alerts.Alerter(
            slack.SlackSender(client, webhook_url),
            quiet=dt.timedelta(minutes=args.quiet_minutes),
            now=lambda: dt.datetime.now(dt.UTC),
        )
        try:
            await alerter.alert(args.key, args.text)
        except errors.DeliveryError:
            _LOGGER.exception("Alert %r not delivered", args.key)
            return 1
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Parses the arguments, builds the dependencies and sends the alert.

    Args:
        argv: Arguments without the program name; None reads sys.argv.

    Returns:
        The process exit code.
    """
    parser = argparse.ArgumentParser(prog="notify")
    parser.add_argument("key")
    parser.add_argument("text")
    parser.add_argument("--quiet-minutes", type=int, default=10)
    args = parser.parse_args(argv)
    webhook_url = os.environ.get("NOTIFY_SLACK_WEBHOOK")
    if webhook_url is None:
        parser.error("NOTIFY_SLACK_WEBHOOK is not set")
    logging.basicConfig(level=logging.INFO)
    return asyncio.run(_run(args, webhook_url))


if __name__ == "__main__":
    sys.exit(main())
```

## Injection and the one seam

`Alerter` needs something with `send`. The protocol lives in the consumer's module, and it exists because the test passes a fake; with no test seam and one sender, `Alerter` would take `slack.SlackSender` directly. A second channel (`email.EmailSender`) is one more class with the same `send` and no change here: no base class, no factory, no registry.

```python
"""Sends an alert at most once per quiet period."""

from collections.abc import Callable
import datetime as dt
from typing import Protocol


class Sender(Protocol):
    """Delivers one message to a channel."""

    async def send(self, text: str) -> None:
        """Sends the text."""


class Alerter:
    """Forwards alerts, dropping repeats inside the quiet period."""

    def __init__(
        self,
        sender: Sender,
        *,
        quiet: dt.timedelta,
        now: Callable[[], dt.datetime],
    ) -> None:
        """Initializes the alerter.

        Args:
            sender: Where alerts go.
            quiet: How long a repeated alert is dropped.
            now: The clock; `dt.datetime.now` bound to UTC in main.
        """
        self._sender = sender
        self._quiet = quiet
        self._now = now
        self._last_sent: dict[str, dt.datetime] = {}

    async def alert(self, key: str, text: str) -> bool:
        """Sends the alert unless the same key was sent recently.

        Args:
            key: Identifies repeats of one alert.
            text: The message.

        Returns:
            Whether the alert was sent.
        """
        now = self._now()
        last = self._last_sent.get(key)
        if last is not None and now - last < self._quiet:
            return False
        await self._sender.send(text)
        self._last_sent[key] = now
        return True
```

The clock is a plain callable, not a `Clock` class: a function type is the smallest seam that works.

## A concrete adapter and the package's errors

```python
"""Errors the notify package raises for callers to handle."""


class Error(Exception):
    """Base for every notify error."""


class DeliveryError(Error):
    """A channel refused or lost a message.

    Attributes:
        channel: The channel's name.
    """

    def __init__(self, channel: str, reason: str) -> None:
        """Initializes the error.

        Args:
            channel: The channel's name.
            reason: What the channel reported.
        """
        super().__init__(f"Delivery to {channel!r} failed: {reason}")
        self.channel = channel
```

```python
"""Sends alerts to a Slack incoming webhook."""

import httpx

from notify import errors


class SlackSender:
    """Posts each message to one webhook."""

    def __init__(self, client: httpx.AsyncClient, webhook_url: str) -> None:
        """Initializes the sender.

        Args:
            client: A client with a timeout; owned by the caller.
            webhook_url: The incoming-webhook URL.
        """
        self._client = client
        self._webhook_url = webhook_url

    async def send(self, text: str) -> None:
        """Posts the text.

        Args:
            text: The message.

        Raises:
            errors.DeliveryError: If Slack does not accept it.
        """
        try:
            response = await self._client.post(
                self._webhook_url, json={"text": text}
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise errors.DeliveryError("slack", str(exc)) from exc
```

The third-party exception stops at the adapter; callers catch `errors.DeliveryError` and never import `httpx` to handle a failure.

## Values and named constructors

```python
"""Parses and formats intervals such as `5m` or `2h`."""

import dataclasses
import re

_UNITS = {"s": 1, "m": 60, "h": 3600}
_PATTERN = re.compile(r"(?P<count>[1-9][0-9]*)(?P<unit>[smh])")


@dataclasses.dataclass(frozen=True, slots=True)
class Interval:
    """A whole number of seconds, minutes or hours.

    Attributes:
        count: How many units; at least 1.
        unit: One of `s`, `m`, `h`.
    """

    count: int
    unit: str

    @classmethod
    def parse(cls, text: str) -> Interval:
        """Parses `<count><unit>`, for example `5m`.

        Args:
            text: The interval as written in a config file.

        Returns:
            The parsed interval.

        Raises:
            ValueError: If the text is not an interval.
        """
        match = _PATTERN.fullmatch(text.strip())
        if match is None:
            raise ValueError(f"Not an interval: {text=}")
        return cls(int(match["count"]), match["unit"])

    @property
    def seconds(self) -> int:
        """The interval's length in seconds."""
        return self.count * _UNITS[self.unit]

    def __str__(self) -> str:
        """Formats the interval the way `parse` reads it.

        Returns:
            The interval as `<count><unit>`.
        """
        return f"{self.count}{self.unit}"
```

`-> Interval` needs no quotes on 3.14. `parse` documents `ValueError` because bad config text is an expected input, not API misuse.

| Shape | Use |
|---|---|
| `@dataclass(frozen=True, slots=True)` (`kw_only=True` past two fields) | Values: compared, hashed, never mutated |
| `@dataclass(slots=True)` | Internal state that changes |
| Pydantic `BaseModel` | Outside input (HTTP bodies, config files) validated at the boundary |
| `TypedDict` | A dict shape you do not own (a JSON payload passed through) |
| `NamedTuple` | A small immutable record that must also unpack |

## Concurrent failures

```python
"""Sends one message to every channel at once."""

import asyncio
from collections.abc import Sequence

from notify import alerts


async def send_all(senders: Sequence[alerts.Sender], text: str) -> None:
    """Sends the text through every sender concurrently.

    Args:
        senders: The channels.
        text: The message.

    Raises:
        ExceptionGroup: Holding every channel's failure, after all finish.
    """
    async with asyncio.TaskGroup() as group:
        for sender in senders:
            group.create_task(sender.send(text))
```

Callers split the group: `except* errors.DeliveryError as group:` handles delivery failures and lets anything else propagate. Wrap the block in `async with asyncio.timeout(seconds):` when the whole fan-out has a deadline.

## Template strings

```python
"""Builds parameterized SQL from template strings."""

from string import templatelib


def to_query(template: templatelib.Template) -> tuple[str, list[object]]:
    """Turns t"... {value} ..." into a query with placeholders.

    Args:
        template: The query; every interpolation becomes a parameter.

    Returns:
        The SQL text with `?` placeholders, and the parameters in order.
    """
    parts: list[str] = []
    params: list[object] = []
    for item in template:
        if isinstance(item, str):
            parts.append(item)
        else:
            parts.append("?")
            params.append(item.value)
    return "".join(parts), params
```

`to_query(t"select * from users where name = {name}")` returns the placeholder text and `[name]`; an f-string in the same place would splice the value into the SQL.
