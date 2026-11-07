// ESLint 10 flat config: typescript-eslint strictTypeChecked + stylisticTypeChecked,
// plus the rules that encode the Google TypeScript Style Guide
// (https://google.github.io/styleguide/tsguide.html). Formatting is Prettier's job
// (eslint-config-prettier turns the overlapping rules off). Every rule turned off
// or loosened says why on its line; source files carry no eslint-disable comments.
//
// pnpm add -D eslint @eslint/js typescript-eslint eslint-config-prettier \
//   eslint-plugin-jsdoc eslint-plugin-n eslint-plugin-unicorn @vitest/eslint-plugin
import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import jsdoc from 'eslint-plugin-jsdoc';
import n from 'eslint-plugin-n';
import {defineConfig, globalIgnores} from 'eslint/config';
import unicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';

// Google bans these outright; no-restricted-syntax encodes the ones no rule covers.
const GOOGLE_BANNED_SYNTAX = [
  {
    selector: 'ExportDefaultDeclaration',
    message: 'Named exports only (Google: Exports).',
  },
  {
    selector: 'ExportSpecifier[exported.name="default"]',
    message: 'Named exports only (Google: Exports).',
  },
  {
    selector: 'ExportNamedDeclaration > VariableDeclaration[kind="let"]',
    message:
      'No mutable exports: `export let` is not allowed (Google: Mutable exports).',
  },
  {
    selector: 'PrivateIdentifier',
    message:
      'Use the TypeScript `private` modifier, not #private (Google: No #private fields).',
  },
  {
    selector: 'TSEnumDeclaration',
    message:
      'Use a union of string literals (house rule; Google bans const enum, we ban both).',
  },
  {
    selector: 'ForInStatement',
    message:
      'Iterate Object.keys/entries or a Map, not for...in (Google: Iterating objects).',
  },
  {
    selector:
      'TSTypeAliasDeclaration > TSUnionType > :matches(TSNullKeyword, TSUndefinedKeyword)',
    message:
      'Add |null or |undefined where the alias is used, not in the alias (Google: Nullable type aliases).',
  },
  {
    selector:
      ':matches(MethodDefinition, PropertyDefinition)[static=true] ThisExpression',
    message:
      'No `this` in a static context; name the class (Google: Avoid static this references).',
  },
  {
    selector:
      ':matches(Program, ExportNamedDeclaration) > VariableDeclaration > VariableDeclarator:not([id.typeAnnotation]) > ArrowFunctionExpression',
    message:
      'Declare a top-level named function with `function` (Google: Prefer function declarations).',
  },
  {
    selector: 'TSImportType',
    message:
      'No import() in type positions; use `import type` (Google: Dynamic import() type).',
  },
];

const DEFAULT_EXPORT_SELECTORS = new Set([
  GOOGLE_BANNED_SYNTAX[0].selector,
  GOOGLE_BANNED_SYNTAX[1].selector,
]);

export default defineConfig([
  globalIgnores(['dist/', 'coverage/', '**/*.d.ts']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  jsdoc.configs['flat/recommended-typescript-error'],
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      noInlineConfig: true, // no eslint-disable in source: change this file, with the reason
    },
    plugins: {n, unicorn},
    rules: {
      // Language features (Google: Language features)
      'no-restricted-syntax': ['error', ...GOOGLE_BANNED_SYNTAX],
      'no-var': 'error',
      'prefer-const': 'error',
      'one-var': ['error', 'never'],
      'no-object-constructor': 'error',
      'no-new-wrappers': 'error',
      'no-extend-native': 'error',
      'no-proto': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-multi-str': 'error',
      'no-cond-assign': ['error', 'always'],
      'prefer-arrow-callback': 'error',
      // Google: named top-level functions are declarations; nested ones may be arrows
      'func-style': ['error', 'declaration', {allowArrowFunctions: true}],
      // Google allows !! and String(); unary plus and implicit string/number coercion are banned
      'no-implicit-coercion': ['error', {boolean: false}],
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'Use Number() and check for NaN (Google: Coercing to numbers).',
        },
      ],
      eqeqeq: ['error', 'always', {null: 'ignore'}],
      'default-case': 'error',
      'default-case-last': 'error',
      'no-empty': 'error', // an intentionally empty catch carries a comment, which satisfies the rule
      'preserve-caught-error': 'error',
      'multiline-comment-style': ['error', 'separate-lines'],

      // Type system
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {assertionStyle: 'never'}, // `as const` stays allowed; `as T` and <T> are banned
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {fixStyle: 'inline-type-imports'},
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/array-type': ['error', {default: 'array-simple'}],
      // Google shows both {[userName: string]: T} and Record<string, T>, and prefers Map over either
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          considerDefaultExhaustiveForUnions: false,
          requireDefaultForNonUnion: true,
        },
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Classes
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        // Google: never write `public`, except on a non-readonly parameter property
        {accessibility: 'no-public', overrides: {parameterProperties: 'off'}},
      ],
      '@typescript-eslint/parameter-properties': [
        'error',
        {prefer: 'parameter-property'},
      ],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-extraneous-class': 'error', // container classes of statics

      // Naming (Google: Naming). strictCamelCase rejects loadHTTPURL and a $ or _ in names.
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'default',
          format: ['strictCamelCase'],
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid',
        },
        {selector: 'import', format: ['strictCamelCase', 'StrictPascalCase']},
        {
          selector: 'variable',
          modifiers: ['global', 'const'],
          format: ['strictCamelCase', 'UPPER_CASE', 'StrictPascalCase'],
        },
        {
          selector: 'parameter',
          format: ['strictCamelCase'],
          leadingUnderscore: 'allow',
        },
        {selector: 'variable', modifiers: ['destructured'], format: null}, // a local alias keeps the source's name
        {
          selector: 'classProperty',
          modifiers: ['static', 'readonly'],
          format: ['UPPER_CASE', 'strictCamelCase'],
        },
        {selector: 'typeLike', format: ['StrictPascalCase']},
        {
          selector: 'typeParameter',
          format: ['StrictPascalCase'],
          custom: {regex: '^([A-Z]|[A-Z][a-z]\\w*)$', match: true},
        },
        {
          selector: 'interface',
          format: ['StrictPascalCase'],
          custom: {regex: '^I[A-Z]', match: false},
        },
        // Object literal keys mirror external formats (HTTP headers, wire JSON in a schema);
        // the interface they satisfy is still checked as typeProperty
        {selector: 'objectLiteralProperty', format: null},
        {selector: 'typeProperty', modifiers: ['requiresQuotes'], format: null},
      ],

      // Documentation: JSDoc on exports, no types in JSDoc (TypeScript carries them)
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {FunctionDeclaration: true, ClassDeclaration: true}, // methods: when not obvious (review)
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'ExportNamedDeclaration > VariableDeclaration',
          ],
        },
      ],
      'jsdoc/require-param': 'off', // Google: omit @param when the name and type say it all
      'jsdoc/require-returns': 'off', // same for @returns

      // Google: files are snake_case (Naming: Imports). Directories are not covered: a
      // Next.js route folder is a URL segment.
      'unicorn/filename-case': [
        'error',
        {case: 'snakeCase', checkDirectories: false},
      ],

      // Node
      'n/prefer-node-protocol': 'error',
      'n/no-deprecated-api': 'error',
      'n/no-unsupported-features/node-builtins': 'error', // checked against package.json engines
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test-d.ts', '**/testing/**/*.ts'],
    plugins: {vitest},
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/expect-expect': [
        'error',
        {assertFunctionNames: ['expect', 'expectTypeOf', 'assertType']},
      ],
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/consistent-test-it': [
        'error',
        {fn: 'test', withinDescribe: 'test'},
      ],
      'vitest/prefer-strict-equal': 'error',
      'vitest/require-awaited-expect-poll': 'error',
      'vitest/no-restricted-vi-methods': [
        'error',
        {
          mock: 'Inject the dependency and pass a fake; module mocks test the import graph.',
          doMock:
            'Inject the dependency and pass a fake; module mocks test the import graph.',
          advanceTimersByTime:
            'Use advanceTimersByTimeAsync so awaited callbacks run.',
          runAllTimers: 'Use runAllTimersAsync so awaited callbacks run.',
        },
      ],
      // Google allows @ts-expect-error in tests; it must say why
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {'ts-expect-error': 'allow-with-description'},
      ],
      'jsdoc/require-jsdoc': 'off', // test helpers are not a public API
    },
  },
  {
    // Tools and frameworks that load a module through its default export: Google allows
    // default exports only where external code requires them. Delete the globs you don't use.
    files: [
      '*.config.{js,ts,mjs}',
      '**/*.stories.{ts,tsx}',
      '{app,src/app}/**/{page,layout,template,loading,error,global-error,not-found,forbidden,unauthorized,default,icon,apple-icon,opengraph-image,twitter-image,sitemap,robots,manifest}.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...GOOGLE_BANNED_SYNTAX.filter(
          ({selector}) => !DEFAULT_EXPORT_SELECTORS.has(selector),
        ),
      ],
    },
  },
  {
    files: ['*.config.{js,ts,mjs}'],
    rules: {
      'n/no-unsupported-features/node-builtins': 'off', // dev-only, runs on the Node in .node-version
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
]);
