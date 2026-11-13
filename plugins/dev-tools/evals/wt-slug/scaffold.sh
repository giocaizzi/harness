#!/usr/bin/env bash
# A small API repo.
set -euo pipefail
mkdir -p api
cat > api/server.py <<'P'
from http.server import BaseHTTPRequestHandler


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")
P
echo '# api' > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
