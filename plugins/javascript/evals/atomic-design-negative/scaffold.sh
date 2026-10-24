#!/usr/bin/env bash
# A Vite React app with a UI kit Button.
set -euo pipefail
mkdir -p src/ui/atoms
cat > package.json <<'JSON'
{ "name": "web", "private": true, "type": "module", "scripts": { "dev": "vite", "build": "tsc && vite build" },
  "dependencies": { "react": "^19.2.0", "react-dom": "^19.2.0" },
  "devDependencies": { "vite": "^7.1.0", "@vitejs/plugin-react": "^5.0.0", "typescript": "^5.9.0", "@types/react": "^19.2.0" } }
JSON
cat > src/ui/atoms/Button.tsx <<'TSX'
interface ButtonProps {
  label: string;
  onClick: () => void;
}

export function Button({ label, onClick }: ButtonProps) {
  return (
    <button className="rounded bg-blue-600 px-4 py-2 text-white" onClick={onClick}>
      {label}
    </button>
  );
}
TSX
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
