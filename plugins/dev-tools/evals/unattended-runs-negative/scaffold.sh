#!/usr/bin/env bash
# A small CLI whose delete command asks for confirmation with input().
set -euo pipefail
cat > cli.py <<'P'
import argparse
import sys


def delete(name):
    answer = input(f"Delete {name}? [y/N] ")
    if answer.lower() != "y":
        print("aborted")
        return 1
    print(f"deleted {name}")
    return 0


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("delete")
    d.add_argument("name")
    args = parser.parse_args()
    if args.cmd == "delete":
        sys.exit(delete(args.name))


if __name__ == "__main__":
    main()
P
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
