#!/usr/bin/env bash
# A Python API with a small TypeScript front end.
set -euo pipefail
mkdir -p api/src/shop web/src
cat > api/pyproject.toml <<'TOML'
[project]
name = "shop"
version = "0.1.0"
requires-python = ">=3.12"
TOML
cat > api/src/shop/prices.py <<'PY'
def total(prices: list[float]) -> float:
    return sum(prices)
PY
cat > web/package.json <<'JSON'
{ "name": "web", "private": true, "type": "module", "devDependencies": { "typescript": "^5.9.0" } }
JSON
cat > web/src/ProductCard.ts <<'TS'
export interface Product {
  name: string;
  price: number;
}

export function renderProductCard(product: Product): string {
  return `<div class="card"><h2>${product.name}</h2><p>€${product.price}</p></div>`;
}
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
