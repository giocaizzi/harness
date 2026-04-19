---
name: javascript-typescript
description: JavaScript and TypeScript development with ES6+ and Node.js. Use this skill whenever you are writing JavaScript or TypeScript code. You must follow these guidelines always.
metadata:
  version: "1.0"
---

# JavaScript/TypeScript Development

- TypeScript strict mode
- Use `constants.ts` and `types.ts` for type definitions and place them in their respective feature folders
- JSDocs Docstrings on public functions (purpose, params, returns, errors). Comments explain _why_, not _what_. Be short and concise.


## Devtools

- `eslint` + `prettier` for code quality and formatting
- `knip` for dependency analysis
- `tsc` for type checking

## Prohibited Patterns

- `any`, `eslint-disable`, explicit type assertions/casts (`as`, `as const` for typing, `!`)

## TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## Type Patterns

### Utility Types
```typescript
// Pick specific properties
type UserPreview = Pick<User, 'id' | 'name'>;

// Omit properties
type CreateUser = Omit<User, 'id' | 'created_at'>;

// Make all properties optional
type PartialUser = Partial<User>;

// Make all properties required
type RequiredUser = Required<User>;

// Extract union types
type Status = 'pending' | 'active' | 'inactive';
type ActiveStatus = Extract<Status, 'active' | 'pending'>;
```

### Discriminated Unions
```typescript
type Result<T> =
  | { success: true; data: T }
  | { success: false; error: Error };

function handleResult<T>(result: Result<T>) {
  if (result.success) {
    console.log(result.data); // T
  } else {
    console.error(result.error); // Error
  }
}
```

### Generic Constraints
```typescript
interface HasId {
  id: string | number;
}

function findById<T extends HasId>(items: T[], id: T['id']): T | undefined {
  return items.find(item => item.id === id);
}
```

## Modern JavaScript

### Destructuring & Spread
```javascript
const { name, ...rest } = user;
const merged = { ...defaults, ...options };
const [first, ...others] = items;
```

### Optional Chaining & Nullish Coalescing
```javascript
const city = user?.address?.city ?? 'Unknown';
const count = data?.items?.length ?? 0;
```

### Array Methods
```javascript
const adults = users.filter(u => u.age >= 18);
const names = users.map(u => u.name);
const total = items.reduce((sum, item) => sum + item.price, 0);
const hasAdmin = users.some(u => u.role === 'admin');
const allActive = users.every(u => u.active);
```

## Node.js Patterns

```typescript
// ES Modules
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Error handling
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});
```