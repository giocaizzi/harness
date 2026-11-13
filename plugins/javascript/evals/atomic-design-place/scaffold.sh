#!/usr/bin/env bash
# A React app with a src/ui kit and src/features folders.
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
mkdir -p src/ui src/features/booking src/features/profile src/pages
cat > src/ui/Button.tsx <<'TSX'
import type { ButtonHTMLAttributes } from "react";

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className="btn" {...props} />;
}
TSX
cat > src/ui/Input.tsx <<'TSX'
import type { InputHTMLAttributes } from "react";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}
TSX
cat > src/features/booking/DatePicker.tsx <<'TSX'
import { useState } from "react";
import { Button } from "../../ui/Button";

export function DatePicker({ onPick }: { onPick: (d: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div>
      <input type="date" value={value} onChange={(e) => setValue(e.target.value)} />
      <Button onClick={() => onPick(value)}>Pick</Button>
    </div>
  );
}
TSX
cat > src/features/booking/BookingForm.tsx <<'TSX'
import { DatePicker } from "./DatePicker";

export function BookingForm() {
  return <DatePicker onPick={(d) => console.log("book", d)} />;
}
TSX
cat > src/features/profile/ProfileForm.tsx <<'TSX'
import { Input } from "../../ui/Input";

export function ProfileForm() {
  return <Input name="birthday" placeholder="Birthday" />;
}
TSX
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
