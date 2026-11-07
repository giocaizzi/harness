# Test patterns

Every snippet passed `vitest run` (Vitest 5.1, shuffled) and the javascript-typescript ESLint config, in the payments package whose code that skill's PATTERNS.md shows. Imports of the code under test use the `.js` extension, as in source.

## Table test

```ts
import {expect, test} from 'vitest';

import {describeOutcome, type ChargeOutcome} from './payment.js';

test.for<[ChargeOutcome, string]>([
  [{kind: 'paid', reference: 'ch_1'}, 'paid (ch_1)'],
  [{kind: 'declined', reason: 'card expired'}, 'declined: card expired'],
  [{kind: 'pending', retryAfterMs: 2000}, 'pending, retry in 2000 ms'],
])('%o -> %s', ([outcome, want]) => {
  expect(describeOutcome(outcome)).toBe(want);
});
```

`test.for` passes the row as one argument (destructure it) and leaves the second parameter for the test context; `test.each` spreads the row instead and has no context.

## Fake for a consumer interface

The production code declares `PaymentProvider`; the fake implements it, answers from a script and records what it was asked. It lives in `src/testing/` because several features' tests use it.

```ts
import type {
  Charge,
  ChargeOutcome,
  PaymentProvider,
} from '../payments/payment.js';

/** A provider that answers from a script and records what it was asked. */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly charged: Charge[] = [];

  constructor(private readonly answers: ChargeOutcome[]) {}

  charge(charge: Charge): Promise<ChargeOutcome> {
    this.charged.push(charge);
    const answer =
      this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    if (answer === undefined) {
      return Promise.reject(new Error('FakeProvider: no answer scripted'));
    }
    return Promise.resolve(answer);
  }
}
```

```ts
test('routes a charge to the provider for its currency', async () => {
  const eur = new FakeProvider([{kind: 'paid', reference: 'eur_1'}]);
  const usd = new FakeProvider([{kind: 'paid', reference: 'usd_1'}]);
  const checkout = new Checkout(
    new Map([
      ['EUR', eur],
      ['USD', usd],
    ]),
  );

  const outcome = await checkout.pay(
    {orderId: 'o1', amountMinor: 500, currency: 'USD'},
    AbortSignal.timeout(1000),
  );

  expect(outcome).toStrictEqual({kind: 'paid', reference: 'usd_1'});
  expect(eur.charged).toStrictEqual([]);
  expect(usd.charged.map(c => c.orderId)).toStrictEqual(['o1']);
});
```

## Fake timers: backoff in zero real time

`Date.now()` is faked too, so the test reads the delays the code actually waited.

```ts
import {afterEach, beforeEach, expect, test, vi} from 'vitest';

import {retry} from './retry.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('backs off 100, 200 ms and succeeds on the third call', async () => {
  const calls: number[] = [];
  const fn = () => {
    calls.push(Date.now());
    return calls.length < 3
      ? Promise.reject(new Error('busy'))
      : Promise.resolve('ok');
  };

  const result = retry(fn, {
    attempts: 5,
    baseDelayMs: 100,
    signal: new AbortController().signal,
  });
  await vi.runAllTimersAsync();

  await expect(result).resolves.toBe('ok');
  expect(calls.map(t => t - (calls[0] ?? 0))).toStrictEqual([0, 100, 300]);
});

test('gives up with the last error as cause', async () => {
  const result = retry(() => Promise.reject(new Error('down')), {
    attempts: 2,
    baseDelayMs: 10,
    signal: new AbortController().signal,
  });
  await Promise.all([
    expect(result).rejects.toThrow(
      expect.objectContaining({
        message: 'gave up after 2 attempts',
        cause: new Error('down'),
      }),
    ),
    vi.runAllTimersAsync(),
  ]);
});
```

## HTTP client against MSW

The client's real `fetch` runs; MSW answers at the network layer. One server per file, handlers per test, reset after each.

```ts
import {http, HttpResponse} from 'msw';
import {setupServer} from 'msw/node';
import {afterAll, afterEach, beforeAll, expect, test} from 'vitest';

import {StripeProvider} from './stripe_provider.js';

const BASE_URL = new URL('https://stripe.test');
const server = setupServer();

beforeAll(() => {
  server.listen({onUnhandledFrame: 'error'});
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const charge = {orderId: 'o1', amountMinor: 1250, currency: 'EUR'} as const;

test('maps a failed charge to declined', async () => {
  server.use(
    http.post(new URL('/v1/charges', BASE_URL).href, () =>
      HttpResponse.json({
        id: 'ch_1',
        status: 'failed',
        failure_message: 'card expired',
      }),
    ),
  );
  const provider = new StripeProvider(BASE_URL, 'sk_test');

  const outcome = await provider.charge(charge, AbortSignal.timeout(1000));

  expect(outcome).toStrictEqual({kind: 'declined', reason: 'card expired'});
});

test('rejects on a server error, naming the order', async () => {
  server.use(
    http.post(
      new URL('/v1/charges', BASE_URL).href,
      () => new HttpResponse(null, {status: 502}),
    ),
  );
  const provider = new StripeProvider(BASE_URL, 'sk_test');

  await expect(
    provider.charge(charge, AbortSignal.timeout(1000)),
  ).rejects.toThrow(/HTTP 502 for order o1/);
});
```

## Property test for a parser

```ts
import fc from 'fast-check';
import {expect, test} from 'vitest';

import {parseConfig} from './config.js';

test('names every missing field', () => {
  expect(parseConfig('{}')).toMatchObject({
    ok: false,
    problems: [
      expect.stringMatching(/^port:/),
      expect.stringMatching(/^databaseUrl:/),
    ],
  });
});

test('never throws, whatever the input', () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.json()), text => {
      const result = parseConfig(text);
      expect(typeof result.ok).toBe('boolean');
    }),
  );
});
```

When fast-check reports a counterexample, copy the shrunk input into a named test like the first one, then fix the parser.

## Type test

```ts
// retry.test-d.ts
import {expectTypeOf, test} from 'vitest';

import {retry} from './retry.js';

test('retry resolves to what fn resolves to', () => {
  expectTypeOf(
    retry(() => Promise.resolve(1), {
      attempts: 1,
      baseDelayMs: 0,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqualTypeOf<number>();
});
```
