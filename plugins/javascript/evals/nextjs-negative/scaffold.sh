#!/usr/bin/env bash
# A Vite React single-page app with React Router.
set -euo pipefail
mkdir -p src/components
cat > package.json <<'JSON'
{ "name": "web", "private": true, "type": "module", "scripts": { "dev": "vite", "build": "tsc && vite build" },
  "dependencies": { "react": "^19.2.0", "react-dom": "^19.2.0", "react-router": "^7.9.0" },
  "devDependencies": { "vite": "^7.1.0", "@vitejs/plugin-react": "^5.0.0", "typescript": "^5.9.0", "@types/react": "^19.2.0" } }
JSON
cat > src/App.tsx <<'TSX'
import { BrowserRouter, Route, Routes } from "react-router";
import { Header } from "./components/Header";

function Home() {
  return <h1>Notes</h1>;
}

export function App() {
  return (
    <BrowserRouter>
      <Header />
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </BrowserRouter>
  );
}
TSX
cat > src/components/Header.tsx <<'TSX'
import { Link } from "react-router";

export function Header() {
  return (
    <nav>
      <Link to="/">Home</Link>
    </nav>
  );
}
TSX
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
