#!/usr/bin/env bash
# A repo on main right after PR 21 merged a --version flag with its test, and a stand-in gh.
set -euo pipefail
mkdir -p src tests bin
cat > src/cli.py <<'PY'
import argparse

VERSION = "0.3.0"


def build_parser():
    parser = argparse.ArgumentParser(prog="acme")
    parser.add_argument("--version", action="version", version=f"acme {VERSION}")
    parser.add_argument("name", nargs="?", default="world")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    print(f"hello {args.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
PY
cat > tests/test_cli.py <<'PY'
import subprocess
import sys
import unittest


class VersionTest(unittest.TestCase):
    def test_version_flag(self):
        out = subprocess.run(
            [sys.executable, "src/cli.py", "--version"], capture_output=True, text=True, check=True
        )
        self.assertEqual(out.stdout.strip(), "acme 0.3.0")


if __name__ == "__main__":
    unittest.main()
PY
cat > Makefile <<'MK'
test:
	python3 -m unittest discover -s tests
MK
echo "# acme" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat: add --version flag (#21)"
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call and answers the few the task needs.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
case "$1 $2" in
  "pr view") echo '{"number":21,"state":"MERGED","title":"feat: add --version flag","body":"Adds a --version flag to the CLI.","url":"https://example.com/acme/app/pull/21","headRefName":"feat/version","mergedAt":"2026-11-13T09:00:00Z"}' ;;
  "run list") echo '[{"databaseId":5,"name":"ci","status":"completed","conclusion":"success","headBranch":"main"}]' ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
