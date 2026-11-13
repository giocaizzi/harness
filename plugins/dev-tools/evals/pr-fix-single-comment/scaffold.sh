#!/usr/bin/env bash
# A repo on a PR branch whose api.py line 40 has an unclear error, a stand-in gh returning that review comment.
set -euo pipefail
cat > api.py <<'PY'
"""Tiny order API helpers."""

import json

ORDERS = {}


def load_orders(path):
    with open(path) as handle:
        for row in json.load(handle):
            ORDERS[row["id"]] = row


def get_order(order_id):
    return ORDERS.get(order_id)


def list_orders():
    return sorted(ORDERS.values(), key=lambda row: row["id"])


def count_orders():
    """Return how many orders are loaded."""
    return len(ORDERS)


# Orders are keyed by id.
def total_for(order_id):
    order = get_order(order_id)
    if order is None:
        raise KeyError(order_id)
    return sum(line["qty"] * line["price"] for line in order["lines"])


def cancel_order(order_id):
    order = get_order(order_id)
    if order is None:
        raise KeyError(order_id)
    if order.get("shipped"):
        raise ValueError("bad state")
    order["cancelled"] = True
    return order


def refund(order_id, amount):
    order = get_order(order_id)
    if order is None:
        raise KeyError(order_id)
    if amount > total_for(order_id):
        raise ValueError("bad amount")
    order["refunded"] = amount
    return order
PY
echo "# orders" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git switch -q -c feat/cancel-order
mkdir -p bin
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call and answers the few the task needs.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
comments='[{"id":501,"path":"api.py","line":40,"user":{"login":"reviewer"},"body":"This error message is unclear. Say what state the order is in and why it cannot be cancelled."}]'
case "$1 $2" in
  "pr view") echo '{"number":12,"state":"OPEN","title":"feat: cancel orders","url":"https://example.com/acme/app/pull/12","headRefName":"feat/cancel-order","reviewDecision":"CHANGES_REQUESTED","comments":[],"reviews":[{"author":{"login":"reviewer"},"state":"CHANGES_REQUESTED","body":"One comment inline."}]}' ;;
  "pr checks") printf 'test\tpass\t20s\thttps://example.com/acme/app/actions/runs/1\n' ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) [ "$1" = api ] && echo "$comments" ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
