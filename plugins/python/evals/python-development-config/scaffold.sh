#!/usr/bin/env bash
# A tiny uv project with a settings file and no loader.
set -euo pipefail
mkdir -p src/notify
cat > pyproject.toml <<'TOML'
[project]
name = "notify"
version = "0.1.0"
requires-python = ">=3.12"
TOML
cat > settings.toml <<'TOML'
smtp_host = "mail.example.com"
smtp_port = 587
sender = "alerts@example.com"
TOML
cat > src/notify/__init__.py <<'PY'
PY
cat > src/notify/mailer.py <<'PY'
import smtplib


def send(host, port, sender, to, body):
    with smtplib.SMTP(host, port) as smtp:
        smtp.sendmail(sender, [to], body)
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
