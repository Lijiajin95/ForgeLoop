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
    extends: [...tseslint.configs.strictTypeChecked],
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
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true, allowRegExp: true },
      ],
      // 两条规则暂列 ratchet：断言集中在已校验的 Map/数组取值，条件判断多为宿主/JSON
      // 防御式校验；逐条收敛前先显式关闭，避免用 disable 注释刷绿。
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'max-depth': ['error', 7],
      // 规模预算：按 1M 上下文推导（文件 2,000 行 / 25k tokens；函数 300 行 / 4k tokens）。
      // 不跳过注释：注释同样占用上下文预算。存量违规由 eslint-suppressions.json 冻结。
      'max-lines': ['error', { max: 2000, skipBlankLines: true }],
      'max-lines-per-function': [
        'error',
        { max: 300, skipBlankLines: true, IIFEs: true },
      ],
      'max-statements': ['error', 40],
      complexity: ['error', 15],
      'max-params': ['error', 4],
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
