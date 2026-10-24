#!/usr/bin/env bash
# A Vite React app whose profile effect depends on an object rebuilt every render.
set -euo pipefail
mkdir -p src/components
cat > package.json <<'JSON'
{ "name": "web", "private": true, "type": "module", "scripts": { "dev": "vite", "build": "tsc && vite build" },
  "dependencies": { "react": "^19.2.0", "react-dom": "^19.2.0" },
  "devDependencies": { "vite": "^7.1.0", "@vitejs/plugin-react": "^5.0.0", "typescript": "^5.9.0", "@types/react": "^19.2.0" } }
JSON
cat > src/components/UserProfile.tsx <<'TSX'
import { useEffect, useState } from "react";

interface User {
  name: string;
}

export function UserProfile({ userId }: { userId: string }) {
  const [user, setUser] = useState<User | null>(null);
  const options = { headers: { Accept: "application/json" } };

  useEffect(() => {
    fetch(`/api/users/${userId}`, options)
      .then((r) => r.json())
      .then(setUser);
  }, [userId, options]);

  return <h1>{user?.name ?? "Loading"}</h1>;
}
TSX
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
