#!/usr/bin/env bash
# A Python package whose notifier tests patch four collaborators with mock.patch.
set -euo pipefail
cat > pyproject.toml <<'TOML'
[project]
name = "acme"
version = "0.1.0"
requires-python = ">=3.14"
dependencies = []

[tool.mypy]
strict = true

[tool.pytest.ini_options]
testpaths = ["tests"]
TOML
mkdir -p src/acme tests
cat > src/acme/notifier.py <<'PY'
import smtplib
import time
from email.message import EmailMessage


def load_template(name: str) -> str:
    with open(f"templates/{name}.txt") as fh:
        return fh.read()


def notify(address: str, name: str) -> str:
    body = load_template("welcome").format(name=name)
    msg = EmailMessage()
    msg["To"] = address
    msg["Subject"] = "Welcome"
    msg.set_content(body)
    with smtplib.SMTP("smtp.example.com") as smtp:
        smtp.send_message(msg)
    sent_at = time.time()
    return f"sent to {address} at {sent_at}"
PY
cat > tests/test_notifier.py <<'PY'
from unittest import mock

from acme.notifier import notify


@mock.patch("acme.notifier.time.time", return_value=1000.0)
@mock.patch("acme.notifier.smtplib.SMTP")
@mock.patch("acme.notifier.EmailMessage")
@mock.patch("acme.notifier.load_template", return_value="Hi {name}")
def test_notify(load_template, email_message, smtp, now):
    result = notify("ada@example.com", "Ada")
    assert result == "sent to ada@example.com at 1000.0"
    smtp.return_value.__enter__.return_value.send_message.assert_called_once()
    load_template.assert_called_once_with("welcome")
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
