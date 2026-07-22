import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config (ESLint 10) for backend TypeScript sources only.
 *
 * We use typescript-eslint's syntax-only "recommended" preset (no type-aware
 * program, so linting stays fast and needs no parserOptions.project). The web
 * app owns its own lint scope; config files and build output are ignored.
 *
 * `no-console` is an error by project standard: all logging goes through pino.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'web/**',
      'drizzle/**',
      '**/*.d.ts',
      '*.config.js',
      '*.config.ts',
      'vitest.config.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
