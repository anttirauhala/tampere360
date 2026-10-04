// ESLint 9 flat config
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/cdk.out/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Paljaat .js/.mjs-tiedostot (esim. scripts/smoke.mjs) ajetaan Nodessa, eikä
  // niillä ole TypeScript-tyyppejä antamassa globaaleja. Luetellaan tarvittavat
  // Node 22 -globaalit, jotta js.configs.recommendedin `no-undef` ei laukea.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
];
