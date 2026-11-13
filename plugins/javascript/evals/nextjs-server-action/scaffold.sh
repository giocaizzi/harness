#!/usr/bin/env bash
# A Next.js app whose contact form posts to an API route.
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
mkdir -p app/contact app/api/contact
cat > app/contact/page.tsx <<'TSX'
"use client";

import { useState } from "react";

export default function ContactPage() {
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    await fetch("/api/contact", {
      method: "POST",
      body: JSON.stringify({ email: data.get("email"), message: data.get("message") }),
    });
    setSent(true);
  }

  return sent ? (
    <p>Thanks!</p>
  ) : (
    <form onSubmit={onSubmit}>
      <input name="email" type="email" required />
      <textarea name="message" required />
      <button type="submit">Send</button>
    </form>
  );
}
TSX
cat > app/api/contact/route.ts <<'TS'
export async function POST(req: Request) {
  const { email, message } = await req.json();
  console.log("contact", email, message);
  return Response.json({ ok: true });
}
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
