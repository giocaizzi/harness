#!/usr/bin/env bash
# A Next.js app with a posts module and no post page.
set -euo pipefail
mkdir -p app lib
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
cat > lib/posts.ts <<'TS'
export interface Post {
  slug: string;
  title: string;
  body: string;
}

const posts: Post[] = [{ slug: "hello", title: "Hello", body: "First post." }];

export async function getPost(slug: string): Promise<Post | undefined> {
  return posts.find((p) => p.slug === slug);
}
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
