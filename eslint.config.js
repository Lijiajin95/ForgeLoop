import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * 代码可靠性门禁：
 * - src 使用类型感知规则（异步、类型断言、穷尽 switch、复杂度）；
 * - tests / scripts 使用无类型规则，避免为测试再建一套 program 拖慢检查。
 * 未接入的规则（non-null、unnecessary-condition 等）见 docs/status.md 的 ratchet 清单。
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/lib/**',
      '**/dist/**',
      '**/coverage/**',
      '.cache/**',
      '**/*.js',
      '**/*.mjs',
    ],
  },
  js.configs.recommended,
  {
    files: ['packages/forgeloop/src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./packages/forgeloop/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/require-await': 'off',
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'max-depth': ['error', 7],
    },
  },
  {
    files: ['packages/forgeloop/tests/**/*.ts', 'scripts/ts/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
