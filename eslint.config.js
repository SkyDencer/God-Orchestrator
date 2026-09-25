import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'prefer-const': 'error',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '.zcode/', '**/*.mjs'],
  }
);
