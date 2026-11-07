# Patterns

The snippets come from one small payments package (`src/payments/`, `src/config/`, `src/retry/`, `src/run.ts`, `src/main.ts`) that type-checks under [tsconfig.node.json](./tsconfig.node.json) with TypeScript 7.0, passes [eslint.config.js](./eslint.config.js), and ran on Node 22; the provider wiring sketch is the one part not compiled.

## A union, handled exhaustively

Variants are data, not subclasses. The `switch` lists every case and keeps Google's mandatory `default`, which assigns to `never` so a new variant fails the type check here (and `switch-exhaustiveness-check` names the missing case).

```ts
/** What a provider answered; declined is an expected outcome, not an error. */
export type ChargeOutcome =
  | {readonly kind: 'paid'; readonly reference: string}
  | {readonly kind: 'declined'; readonly reason: string}
  | {readonly kind: 'pending'; readonly retryAfterMs: number};

/** Describes an outcome for the order log. */
export function describeOutcome(outcome: ChargeOutcome): string {
  switch (outcome.kind) {
    case 'paid':
      return `paid (${outcome.reference})`;
    case 'declined':
      return `declined: ${outcome.reason}`;
    case 'pending':
      return `pending, retry in ${String(outcome.retryAfterMs)} ms`;
    default: {
      const unreachable: never = outcome;
      throw new Error(`unknown outcome ${JSON.stringify(unreachable)}`);
    }
  }
}
```

`String(n)` in the template: `restrict-template-expressions` rejects a bare number, so the conversion is visible.

## The interface the consumer needs, and a second implementation

The interface lives with the code that calls it (`payment.ts`), not with an implementation. With one provider there is no interface: `Checkout` takes `StripeProvider` directly. The second provider is the moment it appears, and it stays an interface plus two classes: no abstract base, no factory.

```ts
/** Anything that can take a payment. Declared here, by the code that needs it. */
export interface PaymentProvider {
  readonly name: string;
  charge(charge: Charge, signal: AbortSignal): Promise<ChargeOutcome>;
}

/** Pays each order through the provider configured for its currency. */
export class Checkout {
  constructor(
    private readonly providers: ReadonlyMap<Charge['currency'], PaymentProvider>,
  ) {}

  /** Charges the order; throws only when no provider takes its currency. */
  async pay(charge: Charge, signal: AbortSignal): Promise<ChargeOutcome> {
    const provider = this.providers.get(charge.currency);
    if (provider === undefined) {
      throw new Error(`no payment provider for ${charge.currency}`);
    }
    return provider.charge(charge, signal);
  }
}
```

Choosing the implementation is a `Map` built in the composition root (`run`), from validated config:

```ts
const checkout = new Checkout(
  new Map([
    ['EUR', new StripeProvider(config.stripeUrl, config.stripeKey)],
    ['USD', new PaypalProvider(config.paypalUrl, config.paypalKey)],
  ]),
);
```

Shared behaviour between the two providers (signing, retries) is a function both call, extracted when a third copy would appear.

## Parsing at the boundary, typed outcomes versus throws

Wire JSON is `unknown` until the schema accepts it; keys keep the wire's spelling inside the schema and never leave this file. An HTTP failure the caller cannot fix throws; a declined card is an answer.

```ts
import * as z from 'zod';

import type {Charge, ChargeOutcome, PaymentProvider} from './payment.js';

const stripeChargeSchema = z.object({
  id: z.string(),
  status: z.enum(['succeeded', 'failed', 'processing']),
  failure_message: z.string().nullish(),
});

/** Takes payments through the Stripe charges API. */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';

  constructor(
    private readonly baseUrl: URL,
    private readonly apiKey: string,
  ) {}

  async charge(charge: Charge, signal: AbortSignal): Promise<ChargeOutcome> {
    const response = await fetch(new URL('/v1/charges', this.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: charge.amountMinor,
        currency: charge.currency.toLowerCase(),
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) {
      throw new Error(
        `stripe: HTTP ${String(response.status)} for order ${charge.orderId}`,
      );
    }
    const body = stripeChargeSchema.parse(await response.json());
    switch (body.status) {
      case 'succeeded':
        return {kind: 'paid', reference: body.id};
      case 'failed':
        return {kind: 'declined', reason: body.failure_message ?? 'unknown'};
      case 'processing':
        return {kind: 'pending', retryAfterMs: 2000};
      default: {
        const unreachable: never = body.status;
        throw new Error(`stripe: unknown status ${String(unreachable)}`);
      }
    }
  }
}
```

Config a person edits gets every problem at once, as a result rather than a throw. In a library the interface is written out and the schema is checked against it (`isolatedDeclarations`); an app writes `export type Config = z.infer<typeof configSchema>` instead.

```ts
/** Service configuration, validated at startup. */
export interface Config {
  readonly port: number;
  readonly databaseUrl: string;
}

const configSchema: z.ZodType<Config> = z.object({
  port: z.int().min(1).max(65_535),
  databaseUrl: z.url(),
});

/** The result of {@link parseConfig}: a config, or every problem found. */
export type ConfigResult =
  | {readonly ok: true; readonly config: Config}
  | {readonly ok: false; readonly problems: readonly string[]};

/** Parses and validates config.json text. */
export function parseConfig(text: string): ConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e: unknown) {
    return {
      ok: false,
      problems: [`not JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
    };
  }
  return {ok: true, config: parsed.data};
}
```

## Cancellation and wrapping

An `AbortSignal` goes to everything that waits. The wrapping error keeps the original as `cause` (`preserve-caught-error` checks it). The delay uses the global `setTimeout`, so fake timers control it in tests.

```ts
/** Options for {@link retry}. */
export interface RetryOptions {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly signal: AbortSignal;
}

/** Calls fn until it resolves, doubling the delay after each failure. */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      lastError = e;
    }
    if (attempt + 1 < options.attempts) {
      await delay(options.baseDelayMs * 2 ** attempt, options.signal);
    }
  }
  throw new Error(`gave up after ${String(options.attempts)} attempts`, {
    cause: lastError,
  });
}

// Global setTimeout, not node:timers/promises: fake timers patch only the global.
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('retry aborted', {cause: signal.reason}));
      },
      {once: true},
    );
  });
}
```

## `main` and `run`

`src/main.ts` is the only file with process side effects, so tests import `run` without starting anything. `run` returns the exit code; `await using` closes the server on every path out.

```ts
// src/main.ts
import {run} from './run.js';

const controller = new AbortController();
process.once('SIGTERM', () => {
  controller.abort(new Error('SIGTERM'));
});
process.once('SIGINT', () => {
  controller.abort(new Error('SIGINT'));
});
process.exitCode = await run(process.argv.slice(2), controller.signal);
```

```ts
// src/run.ts
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';

import {parseConfig} from './config/config.js';

/** Runs the service until signal aborts and returns the process exit code. */
export async function run(
  argv: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  const [configPath] = argv;
  if (configPath === undefined) {
    console.error('usage: payments <config.json>');
    return 2;
  }
  const result = parseConfig(
    await readFile(configPath, {encoding: 'utf8', signal}),
  );
  if (!result.ok) {
    console.error(`invalid ${configPath}:\n  ${result.problems.join('\n  ')}`);
    return 2;
  }
  await using server = createServer((_req, res) => {
    res.end('ok');
  }).listen(result.config.port);
  await once(server, 'listening');
  await once(signal, 'abort');
  return 0;
}
```

knip does not know `main.ts` is an entry point (`package.json` points at `dist/`): an app lists it in `knip.json` as `{"entry": ["src/main.ts"]}`, plus `src/index.ts` if the package also exports an API.
