#!/usr/bin/env bash
# A Vite React app with Storybook configured and a Button with three variants.
set -euo pipefail
cat > package.json <<'JSON'
{
  "name": "acme-app",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest run" },
  "dependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": { "typescript": "^5.6.0", "vite": "^6.0.0", "vitest": "^3.0.0", "@vitejs/plugin-react": "^4.3.0" }
}
JSON
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
JSON
cat > vite.config.ts <<'TS'
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [react()] });
TS
cat > index.html <<'HTML'
<!doctype html>
<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
HTML
mkdir -p src/components src/pages
cat > src/main.tsx <<'TSX'
import { createRoot } from "react-dom/client";
import { OrderList } from "./components/OrderList";

createRoot(document.getElementById("root")!).render(<OrderList />);
TSX
cat > src/components/OrderList.tsx <<'TSX'
import { useEffect, useState } from "react";

type Order = { id: number; total: number };

export function OrderList() {
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    fetch("/api/orders")
      .then((res) => res.json())
      .then((data: Order[]) => setOrders(data));
  }, []);

  return (
    <ul>
      {orders.map((o) => (
        <li key={o.id}>
          #{o.id}: {o.total}
        </li>
      ))}
    </ul>
  );
}
TSX
mkdir -p .storybook
cat > .storybook/main.ts <<'TS'
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: "@storybook/react-vite",
};
export default config;
TS
cat > src/components/Button.tsx <<'TSX'
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger";

export function Button({
  variant = "primary",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button className={`btn btn-${variant}`} {...rest} />;
}
TSX
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
