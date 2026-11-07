// Vitest 5. `make test` runs the unit project with coverage; `make test-integration`
// runs the integration project (real services, *.int.test.ts) in CI.
import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    restoreMocks: true, // vi.fn and vi.spyOn state never leaks into the next test
    unstubEnvs: true, // vi.stubEnv is undone after each test
    unstubGlobals: true, // vi.stubGlobal likewise
    sequence: {shuffle: true}, // order dependence fails here, not in CI by luck
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test-d.ts', 'src/testing/**'],
      reporter: ['text-summary', 'lcov'], // reported, never gated
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.int.test.ts'],
          typecheck: {enabled: true, include: ['src/**/*.test-d.ts']},
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          testTimeout: 60_000, // containers start slowly; unit tests keep the 5 s default
        },
      },
    ],
  },
});
