#!/usr/bin/env bash
# A small uv package that sends alerts to one channel, Slack.
set -euo pipefail
mkdir -p src/notify tests
cat > pyproject.toml <<'TOML'
[project]
name = "notify"
version = "0.1.0"
requires-python = ">=3.14"
dependencies = ["httpx>=0.28"]

[project.scripts]
notify = "notify.cli:main"

[build-system]
requires = ["uv_build>=0.13.7,<0.14"]
build-backend = "uv_build"
TOML
cat > src/notify/__init__.py <<'PY'
"""Alert notifications."""
PY
cat > src/notify/slack.py <<'PY'
"""Sends alerts to a Slack incoming webhook."""

import httpx


class SlackSender:
    """Posts each message to one webhook."""

    def __init__(self, client: httpx.Client, webhook_url: str) -> None:
        """Initializes the sender.

        Args:
            client: A client with a timeout; owned by the caller.
            webhook_url: The incoming-webhook URL.
        """
        self._client = client
        self._webhook_url = webhook_url

    def send(self, text: str) -> None:
        """Posts the text.

        Args:
            text: The message.
        """
        response = self._client.post(self._webhook_url, json={"text": text})
        response.raise_for_status()
PY
cat > src/notify/cli.py <<'PY'
"""Command line: sends one alert."""

import argparse
from collections.abc import Sequence
import os
import sys

import httpx

from notify import slack


def main(argv: Sequence[str] | None = None) -> int:
    """Sends the alert given on the command line.

    Args:
        argv: Arguments without the program name; None reads sys.argv.

    Returns:
        The process exit code.
    """
    parser = argparse.ArgumentParser(prog="notify")
    parser.add_argument("text")
    args = parser.parse_args(argv)
    webhook_url = os.environ["NOTIFY_SLACK_WEBHOOK"]
    with httpx.Client(timeout=10.0) as client:
        slack.SlackSender(client, webhook_url).send(args.text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
