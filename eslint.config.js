import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['server/**/*.ts', 'shared/**/*.ts', '**/scripts/**/*.mjs', '*.config.{js,ts}', '**/vite.config.ts', '**/vitest.config.ts', '**/tsup.config.ts'],
    languageOptions: { globals: globals.node },
  },
  { files: ['server/src/logger.ts', '**/scripts/**/*.mjs', 'server/bench/**/*.ts'], rules: { 'no-console': 'off' } },
  {
    files: ['extension/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
