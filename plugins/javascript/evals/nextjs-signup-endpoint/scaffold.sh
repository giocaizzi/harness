#!/usr/bin/env bash
# A Next.js app with a subscriber store and a signup form that posts nowhere.
set -euo pipefail
mkdir -p app lib components
cat > package.json <<'JSON'
{ "name": "blog", "private": true, "scripts": { "dev": "next dev", "build": "next build" },
  "dependencies": { "next": "^16.0.0", "react": "^19.2.0", "react-dom": "^19.2.0" },
  "devDependencies": { "typescript": "^5.9.0", "@types/react": "^19.2.0" } }
JSON
cat > app/layout.tsx <<'TSX'
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
TSX
cat > app/page.tsx <<'TSX'
export default function Home() {
  return <h1>Home</h1>;
}
TSX
cat > lib/subscribers.ts <<'TS'
const subscribers = new Set<string>();

export async function addSubscriber(email: string): Promise<void> {
  subscribers.add(email);
}
TS
cat > components/SignupForm.tsx <<'TSX'
"use client";

export function SignupForm() {
  return (
    <form method="post">
      <input type="email" name="email" required />
      <button type="submit">Subscribe</button>
    </form>
  );
}
TSX
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
