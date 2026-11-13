#!/usr/bin/env bash
# A React app with three pages that each repeat the same shell layout.
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
mkdir -p src/pages src/ui
cat > src/pages/DashboardPage.tsx <<'TSX'
export function DashboardPage() {
  return (
    <div className="shell">
      <header className="shell-header"><h1>Acme</h1><nav>Home | Settings</nav></header>
      <aside className="shell-sidebar"><ul><li>Overview</li><li>Dashboard</li></ul></aside>
      <main className="shell-content"><h2>Dashboard</h2></main>
    </div>
  );
}
TSX
cat > src/pages/ReportsPage.tsx <<'TSX'
export function ReportsPage() {
  return (
    <div className="shell">
      <header className="shell-header"><h1>Acme</h1><nav>Home | Settings</nav></header>
      <aside className="shell-sidebar"><ul><li>Overview</li><li>Reports</li></ul></aside>
      <main className="shell-content"><h2>Reports</h2></main>
    </div>
  );
}
TSX
cat > src/pages/SettingsPage.tsx <<'TSX'
export function SettingsPage() {
  return (
    <div className="shell">
      <header className="shell-header"><h1>Acme</h1><nav>Home | Settings</nav></header>
      <aside className="shell-sidebar"><ul><li>Overview</li><li>Settings</li></ul></aside>
      <main className="shell-content"><h2>Settings</h2></main>
    </div>
  );
}
TSX
cat > src/ui/Button.tsx <<'TSX'
import type { ButtonHTMLAttributes } from "react";

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className="btn" {...props} />;
}
TSX
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
