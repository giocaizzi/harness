#!/usr/bin/env bash
# A Vite React app with a UI kit and feature folders, and a cross-feature import.
set -euo pipefail
mkdir -p src/ui src/features/cart src/features/profile
cat > package.json <<'JSON'
{ "name": "web", "private": true, "type": "module", "scripts": { "dev": "vite", "build": "tsc && vite build" },
  "dependencies": { "react": "^19.2.0", "react-dom": "^19.2.0" },
  "devDependencies": { "vite": "^7.1.0", "@vitejs/plugin-react": "^5.0.0", "typescript": "^5.9.0", "@types/react": "^19.2.0" } }
JSON
cat > eslint.config.js <<'JS'
import tseslint from "typescript-eslint";

export default tseslint.config(tseslint.configs.recommended);
JS
cat > src/ui/Button.tsx <<'TSX'
export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}
TSX
cat > src/features/profile/useUser.ts <<'TS'
export function useUser() {
  return { name: "Ada" };
}
TS
cat > src/features/cart/Cart.tsx <<'TSX'
import { Button } from "../../ui/Button";
import { useUser } from "../profile/useUser";

export function Cart() {
  const user = useUser();
  return <Button label={`Checkout as ${user.name}`} />;
}
TSX
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
