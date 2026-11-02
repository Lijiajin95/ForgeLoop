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
      // 普通业务代码默认禁止类型断言；受控边界在下方 overrides 中单独放行。
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
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
    // 受控边界：宿主 API、SQLite、配置、npm/子进程输出、HTTP/工具入参。
    // 仅放宽“必须用 as”这一项；no-explicit-any / no-unsafe-* 等仍按 strictTypeChecked 生效。
    files: [
      'packages/forgeloop/src/domain/json.ts',
      'packages/forgeloop/src/records/db.ts',
      'packages/forgeloop/src/records/repository.ts',
      'packages/forgeloop/src/records/ops-store.ts',
      'packages/forgeloop/src/records/issues.ts',
      'packages/forgeloop/src/config.ts',
      'packages/forgeloop/src/index.ts',
      'packages/forgeloop/src/tools.ts',
      'packages/forgeloop/src/cli/pack.ts',
      'packages/forgeloop/src/runtime/agent-runner.ts',
      'packages/forgeloop/src/runtime/formal-test.ts',
      'packages/forgeloop/src/runtime/board-route.ts',
      'packages/forgeloop/src/session/events.ts',
      'packages/forgeloop/src/session/index.ts',
      'packages/forgeloop/src/session/preset.ts',
    ],
    rules: {
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as' },
      ],
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
