#!/usr/bin/env bash
# A Vite React app with a flat components folder.
set -euo pipefail
mkdir -p src/components
cat > package.json <<'JSON'
{ "name": "web", "private": true, "type": "module", "scripts": { "dev": "vite", "build": "tsc && vite build" },
  "dependencies": { "react": "^19.2.0", "react-dom": "^19.2.0" },
  "devDependencies": { "vite": "^7.1.0", "@vitejs/plugin-react": "^5.0.0", "typescript": "^5.9.0", "@types/react": "^19.2.0" } }
JSON
for c in Button Input Label Avatar Badge SearchField UserCard Header CheckoutForm CartSummary ProductGrid Modal; do
  printf 'export function %s() {\n  return <div className="%s" />;\n}\n' "$c" "$c" > "src/components/$c.tsx"
done
cat > src/components/CartSummary.tsx <<'TSX'
import { useEffect, useState } from "react";
import { Button } from "./Button";

export function CartSummary() {
  const [total, setTotal] = useState(0);
  useEffect(() => {
    fetch("/api/cart").then((r) => r.json()).then((c) => setTotal(c.total));
  }, []);
  return <div>Total {total} <Button /></div>;
}
TSX
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
