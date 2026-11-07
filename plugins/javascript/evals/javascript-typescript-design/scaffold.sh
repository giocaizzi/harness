#!/usr/bin/env bash
# A small Node TypeScript shop whose checkout calls Stripe directly: the one provider has no interface yet.
set -euo pipefail
mkdir -p src/payments
cat > package.json <<'JSON'
{ "name": "shop", "private": true, "type": "module", "packageManager": "pnpm@12.18.0", "scripts": { "build": "tsc", "test": "vitest run" }, "devDependencies": { "typescript": "npm:@typescript/typescript6@^6.0.2", "@typescript/native": "npm:typescript@^7.0.2", "@types/node": "^22.19.0", "vitest": "^5.1.0" } }
JSON
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "es2024", "lib": ["es2024"], "module": "nodenext", "moduleResolution": "nodenext", "types": ["node"], "rootDir": "src", "outDir": "dist", "strict": true, "noUncheckedIndexedAccess": true, "verbatimModuleSyntax": true }, "include": ["src"] }
JSON
cat > src/payments/stripe_provider.ts <<'TS'
import type {Charge, ChargeOutcome} from './payment.js';

/** Takes payments through the Stripe charges API. */
export class StripeProvider {
  constructor(
    private readonly baseUrl: URL,
    private readonly apiKey: string,
  ) {}

  /** Charges the order; a declined card is an outcome, an HTTP failure throws. */
  async charge(charge: Charge, signal: AbortSignal): Promise<ChargeOutcome> {
    const response = await fetch(new URL('/v1/charges', this.baseUrl), {
      method: 'POST',
      headers: {Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({amount: charge.amountMinor, currency: charge.currency.toLowerCase()}),
      signal,
    });
    if (!response.ok) {
      throw new Error(`stripe: HTTP ${String(response.status)} for order ${charge.orderId}`);
    }
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'id' in body && typeof body.id === 'string') {
      return {kind: 'paid', reference: body.id};
    }
    return {kind: 'declined', reason: 'unexpected response'};
  }
}
TS
cat > src/payments/payment.ts <<'TS'
/** A charge request in minor units of its currency. */
export interface Charge {
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: 'EUR' | 'USD';
}

/** What the provider answered. */
export type ChargeOutcome =
  | {readonly kind: 'paid'; readonly reference: string}
  | {readonly kind: 'declined'; readonly reason: string};
TS
cat > src/payments/checkout.ts <<'TS'
import type {Charge, ChargeOutcome} from './payment.js';
import type {StripeProvider} from './stripe_provider.js';

/** Pays orders. */
export class Checkout {
  constructor(private readonly stripe: StripeProvider) {}

  /** Charges the order through Stripe. */
  pay(charge: Charge, signal: AbortSignal): Promise<ChargeOutcome> {
    return this.stripe.charge(charge, signal);
  }
}
TS
cat > src/main.ts <<'TS'
import {Checkout} from './payments/checkout.js';
import {StripeProvider} from './payments/stripe_provider.js';

const checkout = new Checkout(
  new StripeProvider(new URL('https://api.stripe.test'), process.env['STRIPE_KEY'] ?? ''),
);
const outcome = await checkout.pay(
  {orderId: 'o1', amountMinor: 1250, currency: 'EUR'},
  AbortSignal.timeout(10_000),
);
console.log(outcome);
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
