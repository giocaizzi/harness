#!/usr/bin/env bash
# A Next.js app whose dashboard page fetches stats with a long revalidate.
set -euo pipefail
cat > package.json <<'JSON'
{
  "name": "acme-web",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build", "start": "next start" },
  "dependencies": { "next": "^16.0.0", "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": { "typescript": "^5.6.0", "@types/react": "^19.0.0", "@types/node": "^22.0.0" }
}
JSON
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["dom", "esnext"], "module": "esnext", "moduleResolution": "bundler",
    "jsx": "preserve", "strict": true, "noEmit": true, "skipLibCheck": true, "plugins": [{ "name": "next" }]
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
JSON
mkdir -p app
cat > app/layout.tsx <<'TSX'
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
TSX
mkdir -p app/dashboard
cat > app/dashboard/page.tsx <<'TSX'
export default async function DashboardPage() {
  const res = await fetch("https://api.example.com/stats", { next: { revalidate: 600 } });
  const stats: { visitors: number; signups: number } = await res.json();
  return (
    <main>
      <h1>Dashboard</h1>
      <p>Visitors: {stats.visitors}</p>
      <p>Signups: {stats.signups}</p>
    </main>
  );
}
TSX
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
